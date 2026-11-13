package main

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestInstalledLocatorWithRedirectedProfile(t *testing.T) {
	root := t.TempDir()
	executable := filepath.Join(root, "opencode.exe")
	home := filepath.Join(root, "ShadowBotPi")
	t.Setenv("USERPROFILE", filepath.Join(root, "workspace", "home"))
	t.Setenv("LOCALAPPDATA", filepath.Join(root, "workspace", "appdata"))
	location, err := json.Marshal(map[string]string{"home": home})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(executable+".shadowbot-pi.json", location, 0600); err != nil {
		t.Fatal(err)
	}
	actual, err := stateDirectory(executable)
	if err != nil || actual != home {
		t.Fatalf("state directory: %q, %v", actual, err)
	}
}

func TestLaunchUsesCommittedRuntime(t *testing.T) {
	node, err := os.Open(filepath.Join("..", ".tools", "node", "node.exe"))
	if os.IsNotExist(err) {
		t.Skip("run scripts/build.ps1 to install the pinned Node runtime")
	}
	if err != nil {
		t.Fatal(err)
	}
	defer node.Close()
	home := t.TempDir()
	id := strings.Repeat("a", 64)
	runtime := filepath.Join(home, "harnesses", "pi", "releases", id)
	service := filepath.Join(runtime, "service")
	if err := os.MkdirAll(service, 0700); err != nil {
		t.Fatal(err)
	}
	executable, err := os.Create(filepath.Join(runtime, "node.exe"))
	if err != nil {
		t.Fatal(err)
	}
	_, copyErr := io.Copy(executable, node)
	closeErr := executable.Close()
	if copyErr != nil || closeErr != nil {
		t.Fatalf("stage Node: copy=%v close=%v", copyErr, closeErr)
	}
	write := func(path, contents string) {
		t.Helper()
		if err := os.WriteFile(path, []byte(contents), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(service, "main.js"), `
const fs = require('node:fs');
const path = require('node:path');
fs.writeFileSync(path.join(process.env.SHADOWBOT_PI_HOME, 'launch.json'), JSON.stringify({
  args: process.argv.slice(2), cwd: process.cwd(), authenticated: process.env.OPENCODE_SERVER_PASSWORD === 'fixture-password',
  agentDir: process.env.PI_CODING_AGENT_DIR
}));`)
	write(filepath.Join(home, "install.json"), `{"runtimeRelease":"`+id+`","piVersion":"fixture"}`)
	write(filepath.Join(home, "backend.json"), `{"mode":"pi"}`)
	t.Setenv("OPENCODE_SERVER_PASSWORD", "fixture-password")
	t.Setenv("PI_CODING_AGENT_DIR", filepath.Join(t.TempDir(), "external"))
	args := []string{"serve", "--hostname", "127.0.0.1", "--port", "0"}
	pending := filepath.Join(home, "activation.pending.json")
	write(pending, `{}`)
	if code, err := runAt(home, args); code != 1 || err == nil || !strings.Contains(err.Error(), "requires recovery") {
		t.Fatalf("pending activation: code=%d err=%v", code, err)
	}
	if err := os.Remove(pending); err != nil {
		t.Fatal(err)
	}
	if code, err := runAt(home, args); code != 0 || err != nil {
		t.Fatalf("launch: code=%d err=%v", code, err)
	}
	var launch struct {
		Args          []string
		Cwd           string
		Authenticated bool
		AgentDir      string
	}
	data, err := os.ReadFile(filepath.Join(home, "launch.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &launch); err != nil {
		t.Fatal(err)
	}
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(launch.Args, args) || !strings.EqualFold(launch.Cwd, cwd) || !launch.Authenticated ||
		launch.AgentDir != filepath.Join(home, "agent") {
		t.Fatalf("unexpected launch parameters: %+v", launch)
	}
}

func TestRegisteredHarnessSelectsOwnRuntime(t *testing.T) {
	node, err := os.ReadFile(filepath.Join("..", ".tools", "node", "node.exe"))
	if os.IsNotExist(err) {
		t.Skip("pinned Node is required")
	}
	if err != nil {
		t.Fatal(err)
	}
	home := t.TempDir()
	id := strings.Repeat("d", 64)
	runtime := filepath.Join(home, "harnesses", "fixture", "releases", id)
	if err := os.MkdirAll(filepath.Join(runtime, "service"), 0700); err != nil {
		t.Fatal(err)
	}
	write := func(path string, contents []byte) {
		t.Helper()
		if err := os.WriteFile(path, contents, 0600); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(runtime, "node.exe"), node)
	write(filepath.Join(runtime, "service", "fixture.js"), []byte(`
const fs = require('node:fs');
fs.writeFileSync(require('node:path').join(process.env.SHADOWBOT_SWITCH_HOME, 'fixture-launch.json'), JSON.stringify({
 harness: process.env.SHADOWBOT_HARNESS, args: process.argv.slice(2), nativeDir: process.env.PI_CODING_AGENT_DIR
}));`))
	// The control service lives in another release. Serve must select the active harness's record.
	write(filepath.Join(home, "install.json"), []byte(`{"runtime":{"harness":"manager","release":"`+strings.Repeat("e", 64)+`"},"harnesses":{"fixture":{"release":"`+id+`","launch":{"executable":"node.exe","args":["{runtime}/service/fixture.js"]}}}}`))
	write(filepath.Join(home, "backend.json"), []byte(`{"mode":"fixture"}`))
	t.Setenv("PI_CODING_AGENT_DIR", "must-not-be-replaced")
	if code, err := runAt(home, []string{"serve", "--port", "0"}); code != 0 || err != nil {
		t.Fatalf("generic launch: %d %v", code, err)
	}
	var actual struct {
		Harness   string
		Args      []string
		NativeDir string
	}
	if err := readJSON(filepath.Join(home, "fixture-launch.json"), &actual); err != nil {
		t.Fatal(err)
	}
	if actual.Harness != "fixture" || actual.NativeDir != "must-not-be-replaced" || !reflect.DeepEqual(actual.Args, []string{"serve", "--port", "0"}) {
		t.Fatalf("unexpected launch: %+v", actual)
	}
	write(filepath.Join(home, "backend.json"), []byte(`{"mode":"unknown"}`))
	if code, err := runAt(home, []string{"serve"}); code != 1 || err == nil {
		t.Fatal("uninstalled harness was accepted")
	}
}
