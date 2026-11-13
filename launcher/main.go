package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"golang.org/x/sys/windows"
)

const protocolVersion = "1.18.12"
const originalHash = "de2e62ab0e3f27a3ea7ff9ef4c4fe7097f0d6df01118b2e7c5f57726256d6314"

type installation struct {
	OriginalHash   string `json:"originalHash"`
	RuntimeRelease string `json:"runtimeRelease"`
	PiVersion      string `json:"piVersion"`
}

var releaseID = regexp.MustCompile(`^[0-9a-f]{64}$`)

type modeState struct {
	Mode string `json:"mode"`
}

func readJSON(path string, value any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, value)
}

func hashFile(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	_, err = io.Copy(hash, file)
	return hex.EncodeToString(hash.Sum(nil)), err
}

func main() {
	code, err := run(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, "ShadowBotPi:", err)
	}
	os.Exit(code)
}

func run(args []string) (int, error) {
	if len(args) == 1 && (args[0] == "--version" || args[0] == "-v") {
		fmt.Println(protocolVersion)
		return 0, nil
	}
	executable, err := os.Executable()
	if err != nil {
		return 1, fmt.Errorf("locate launcher executable: %w", err)
	}
	home, err := stateDirectory(executable)
	if err != nil {
		return 1, err
	}
	return runAt(home, args)
}

func stateDirectory(executable string) (string, error) {
	// ShadowBot redirects the child's profile directories into the workspace. The
	// installed entry uses its own locator so the workspace environment stays intact.
	var location struct {
		Home string `json:"home"`
	}
	if err := readJSON(executable+".shadowbot-pi.json", &location); err == nil {
		if !filepath.IsAbs(location.Home) {
			return "", errors.New("installed launcher location must be absolute")
		}
		return filepath.Clean(location.Home), nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", fmt.Errorf("read launcher location: %w", err)
	}
	if strings.EqualFold(filepath.Base(executable), "shadowbot-pi.exe") {
		return filepath.Dir(executable), nil
	}
	return "", errors.New("project locator is missing; run install.ps1")
}

func runAt(home string, args []string) (int, error) {
	var install installation
	if err := readJSON(filepath.Join(home, "install.json"), &install); err != nil {
		return 1, fmt.Errorf("read installation manifest: %w", err)
	}
	runtime := home
	if install.RuntimeRelease != "" {
		if !releaseID.MatchString(install.RuntimeRelease) {
			return 1, errors.New("invalid installation release ID")
		}
		if install.PiVersion != "" {
			runtime = filepath.Join(home, "harnesses", "pi")
		}
		runtime = filepath.Join(runtime, "releases", install.RuntimeRelease)
	}
	if _, err := os.Stat(filepath.Join(home, "activation.pending.json")); !errors.Is(err, os.ErrNotExist) &&
		(len(args) == 0 || (args[0] != "doctor" && args[0] != "status" && args[0] != "help")) {
		return 1, errors.New("installation activation requires recovery before starting the agent")
	}
	env := append(os.Environ(), "SHADOWBOT_PI_HOME="+home, "PI_CODING_AGENT_DIR="+filepath.Join(home, "agent"))
	if len(args) > 0 && (args[0] == "doctor" || args[0] == "status" || args[0] == "help" || args[0] == "config" || args[0] == "apps" || args[0] == "skills" || args[0] == "mcp" || args[0] == "reload") {
		cmd := exec.Command(filepath.Join(runtime, "node.exe"), append([]string{filepath.Join(runtime, "service", "control.js")}, args...)...)
		cmd.Env = env
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		cmd.Stdin = os.Stdin
		return supervise(cmd)
	}
	if _, err := os.Stat(filepath.Join(home, "switch.pending.json")); !errors.Is(err, os.ErrNotExist) {
		return 1, errors.New("backend switch requires recovery before starting the agent")
	}
	var state modeState
	if err := readJSON(filepath.Join(home, "backend.json"), &state); err != nil {
		return 1, fmt.Errorf("read backend mode: %w", err)
	}
	if len(args) == 0 {
		return 2, errors.New("expected serve, --version, or doctor")
	}
	if args[0] != "serve" {
		return 2, errors.New("unsupported OpenCode command")
	}
	if state.Mode == "pi" {
		cmd := exec.Command(filepath.Join(runtime, "node.exe"), append([]string{filepath.Join(runtime, "service", "main.js")}, args...)...)
		cmd.Env = env
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		return supervise(cmd)
	}
	if state.Mode != "original" && (state.Mode != "observe" || install.PiVersion != "") {
		return 1, errors.New("unknown backend mode")
	}
	backup := filepath.Join(home, "original", "opencode.exe")
	hash, err := hashFile(backup)
	if err != nil || hash != originalHash || !strings.EqualFold(hash, install.OriginalHash) {
		return 1, errors.New("original OpenCode checksum mismatch")
	}
	if state.Mode == "original" {
		cmd := exec.Command(backup, args...)
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		return supervise(cmd)
	}
	return observe(home, backup, args)
}

func supervise(cmd *exec.Cmd) (int, error) {
	parent, err := parentExit()
	if err != nil {
		return 1, err
	}
	job, err := startInJob(cmd)
	if err != nil {
		return 1, fmt.Errorf("start backend: %w", err)
	}
	defer windows.CloseHandle(job)
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	interrupt := make(chan os.Signal, 1)
	signal.Notify(interrupt, os.Interrupt)
	defer signal.Stop(interrupt)
	select {
	case err := <-exited:
		var status *exec.ExitError
		if errors.As(err, &status) {
			return status.ExitCode(), nil
		}
		if err != nil {
			return 1, err
		}
		return 0, nil
	case <-parent:
		return 0, nil
	case <-interrupt:
		return 130, nil
	}
}

func observeAddresses(args []string) (string, []string, error) {
	var upstream []string
	upstream = append(upstream, "serve")
	host := "127.0.0.1"
	port := "0"
	for i := 1; i < len(args); i++ {
		flag, value, assigned := strings.Cut(args[i], "=")
		switch flag {
		case "--port", "--hostname":
			if !assigned {
				i++
				if i == len(args) {
					return "", nil, fmt.Errorf("missing value for %s", flag)
				}
				value = args[i]
			}
			if flag == "--port" {
				port = value
			} else {
				host = value
			}
		case "--mdns", "--mdns-domain":
			return "", nil, errors.New("observe requires a loopback listener without mDNS")
		default:
			upstream = append(upstream, args[i])
		}
	}
	if n, err := strconv.ParseUint(port, 10, 16); err != nil || n > 65535 {
		return "", nil, errors.New("invalid listen port")
	}
	if host == "localhost" {
		host = "127.0.0.1"
	}
	if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
		return "", nil, errors.New("observe requires a loopback listener")
	}
	return net.JoinHostPort(host, port), upstream, nil
}
