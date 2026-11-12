package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const captureLimit = 256 * 1024

var listenLine = regexp.MustCompile(`^opencode server listening on (http://\S+)`)
var knownRoute = regexp.MustCompile(`^/(?:doc|event|global/(?:health|event|dispose)|config(?:/providers)?|project(?:/current)?|path|agent|command|skill|provider(?:/auth)?|auth/[^/]+|mcp(?:/[^/]+(?:/(?:connect|disconnect|auth))?)?|session(?:/status|/[^/]+(?:/(?:message(?:/[^/]+(?:/part/[^/]+)?)?|prompt_async|abort|command|todo|children|diff|revert|unrevert|fork|init|summarize|share))?)?|permission(?:/[^/]+/reply)?|question(?:/[^/]+/(?:reply|reject))?|instance/dispose)$`)
var routeID = regexp.MustCompile(`(^/(?:session|permission|question|auth|mcp)/)([^/]+)`)
var messageID = regexp.MustCompile(`(/(?:message|part)/)[^/]+`)
var knownEvents = wordSet("server.connected server.heartbeat server.instance.disposed session.created session.updated session.deleted session.status session.idle session.error session.diff session.compacted message.updated message.removed message.part.updated message.part.delta message.part.removed permission.asked permission.replied question.asked question.replied question.rejected todo.updated mcp.tools.changed session.next.prompted session.next.prompt.admitted session.next.step.started session.next.step.ended session.next.step.failed session.next.text.started session.next.text.delta session.next.text.ended session.next.tool.called session.next.tool.progress session.next.tool.success session.next.tool.failed")
var knownKeys = wordSet("healthy version directory worktree cwd path root name type id url command args environment headers timeout enabled model modelID providerID provider options npm api baseURL agent permission question title parentID sessionID projectID workspaceID workspace parts part messageID info role text time created updated input output state status metadata callID tool summary revert answers reply config autoconnect data properties payload error success connected disabled failed key system noReply pattern patterns always delta field")
var knownEnvironment = wordSet("OPENCODE_CONFIG OPENCODE_CONFIG_CONTENT OPENCODE_CONFIG_DIR OPENCODE_SERVER_PASSWORD OPENCODE_SERVER_USERNAME OPENCODE_DISABLE_LSP OPENCODE_DISABLE_AUTOUPDATE OPENCODE_DISABLE_DEFAULT_PLUGINS OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS XDG_CACHE_HOME XDG_CONFIG_HOME XDG_DATA_HOME XDG_STATE_HOME HOME USERPROFILE LOCALAPPDATA PATH SHADOWBOT_OPENCODE_CONTEXT_CONFIG_B64 SHADOWBOT_OPENCODE_TRACE_ENABLED SHADOWBOT_OPENCODE_EVIDENCE_URL SHADOWBOT_OPENCODE_RUNTIME_CONTEXT_URL SHADOWBOT_OPENCODE_WORKSPACE_ROOT SHADOWBOT_OPENCODE_REWRITE_DIR SHADOWBOT_OPENCODE_REWRITE_SESSION_ID SHADOWBOT_OPENCODE_TRACE_ID")

func wordSet(list string) map[string]bool {
	set := make(map[string]bool)
	for _, word := range strings.Fields(list) {
		set[word] = true
	}
	return set
}

func shape(value any, depth int) any {
	switch v := value.(type) {
	case map[string]any:
		if depth == 0 {
			return "object"
		}
		out := make(map[string]any)
		for key, value := range v {
			if knownKeys[key] {
				out[key] = shape(value, depth-1)
			}
		}
		return out
	case []any:
		if len(v) == 0 || depth == 0 {
			return "array"
		}
		return []any{shape(v[0], depth-1)}
	case string:
		return "string"
	case bool:
		return "boolean"
	case float64:
		return "number"
	default:
		return "null"
	}
}

func jsonShape(data []byte) any {
	var value any
	if json.Unmarshal(data, &value) != nil {
		return nil
	}
	return shape(value, 4)
}

type trace struct {
	mu  sync.Mutex
	seq uint64
	out *json.Encoder
}

func (t *trace) record(fields map[string]any) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.seq++
	fields["seq"] = t.seq
	fields["time"] = time.Now().UTC().Format(time.RFC3339Nano)
	if err := t.out.Encode(fields); err != nil {
		fmt.Fprintln(os.Stderr, "ShadowBotPi: unable to write observation")
	}
}

func routeLabel(path string) string {
	if !knownRoute.MatchString(path) {
		return "(other)"
	}
	if path == "/session/status" {
		return path
	}
	return messageID.ReplaceAllString(routeID.ReplaceAllString(path, `${1}{id}`), `${1}{id}`)
}

type observeBody struct {
	io.ReadCloser
	buf     []byte
	stream  bool
	skip    bool
	trace   *trace
	request uint64
}

func (b *observeBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	if !b.stream {
		if len(b.buf)+n <= captureLimit && !b.skip {
			b.buf = append(b.buf, p[:n]...)
		} else {
			b.skip = true
			b.buf = nil
		}
		return n, err
	}
	for chunk := p[:n]; len(chunk) > 0; {
		line, rest, end := bytes.Cut(chunk, []byte{'\n'})
		if !b.skip && len(b.buf)+len(line) <= captureLimit {
			b.buf = append(b.buf, line...)
		} else {
			b.skip = true
		}
		if !end {
			break
		}
		if !b.skip {
			b.event(b.buf)
		}
		b.buf, b.skip = b.buf[:0], false
		chunk = rest
	}
	return n, err
}

func (b *observeBody) event(line []byte) {
	data, ok := bytes.CutPrefix(line, []byte("data:"))
	if !ok {
		return
	}
	var frame struct {
		Type       string `json:"type"`
		Properties any    `json:"properties"`
		Payload    *struct {
			Type       string `json:"type"`
			Properties any    `json:"properties"`
		} `json:"payload"`
	}
	if json.Unmarshal(data, &frame) != nil {
		return
	}
	if frame.Payload != nil {
		frame.Type, frame.Properties = frame.Payload.Type, frame.Payload.Properties
	}
	if !knownEvents[frame.Type] {
		frame.Type = "(other)"
	}
	b.trace.record(map[string]any{"kind": "event", "request": b.request, "type": frame.Type, "shape": shape(frame.Properties, 3)})
}

func (b *observeBody) Close() error {
	if !b.stream && !b.skip {
		if shape := jsonShape(b.buf); shape != nil {
			b.trace.record(map[string]any{"kind": "response-shape", "request": b.request, "shape": shape})
		}
	}
	return b.ReadCloser.Close()
}

type backendStdout struct {
	buf      []byte
	upstream *atomic.Pointer[url.URL]
	public   string
}

func (w *backendStdout) Write(p []byte) (int, error) {
	w.buf = append(w.buf, p...)
	for {
		line, rest, end := bytes.Cut(w.buf, []byte{'\n'})
		if !end {
			break
		}
		if match := listenLine.FindSubmatch(line); match != nil {
			address, err := url.Parse(string(match[1]))
			if err == nil && address.Hostname() == "127.0.0.1" {
				w.upstream.Store(address)
				fmt.Fprintf(os.Stdout, "opencode server listening on http://%s\n", w.public)
			}
		} else {
			fmt.Fprintln(os.Stdout, string(line))
		}
		w.buf = rest
	}
	if len(w.buf) > captureLimit {
		return 0, errors.New("unexpected OpenCode startup output")
	}
	return len(p), nil
}

func observe(home, backup string, args []string) (int, error) {
	address, childArgs, err := observeAddresses(args)
	if err != nil {
		return 2, err
	}
	listener, err := net.Listen("tcp", address)
	if err != nil {
		return 1, err
	}
	defer listener.Close()
	dir := filepath.Join(home, "observations")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return 1, err
	}
	file, err := os.OpenFile(filepath.Join(dir, fmt.Sprintf("observe-%d.jsonl", time.Now().UnixNano())), os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0600)
	if err != nil {
		return 1, err
	}
	defer file.Close()
	trace := &trace{out: json.NewEncoder(file)}
	var keys []string
	for _, item := range os.Environ() {
		key, _, _ := strings.Cut(item, "=")
		if knownEnvironment[key] {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	var flags []string
	for _, arg := range args[1:] {
		flag, _, _ := strings.Cut(arg, "=")
		switch flag {
		case "--hostname", "--port", "--cors", "--print-logs", "--log-level", "--pure":
			flags = append(flags, flag)
		}
	}
	trace.record(map[string]any{"kind": "start", "protocol": protocolVersion, "command": "serve", "flags": flags, "environment": keys})
	var upstream atomic.Pointer[url.URL]
	var counter atomic.Uint64
	server := &http.Server{ReadHeaderTimeout: 10 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := counter.Add(1)
		method := r.Method
		switch method {
		case "GET", "POST", "PATCH", "DELETE", "PUT", "OPTIONS":
		default:
			method = "(other)"
		}
		fields := map[string]any{"kind": "request", "request": id, "method": method, "route": routeLabel(r.URL.Path), "authorization": r.Header.Get("Authorization") != "", "directoryHeader": r.Header.Get("x-opencode-directory") != "", "workspaceHeader": r.Header.Get("x-opencode-workspace") != ""}
		for _, key := range []string{"directory", "workspace", "limit", "start", "roots", "search", "archived"} {
			if r.URL.Query().Has(key) {
				fields[key+"Query"] = true
			}
		}
		if r.ContentLength > 0 && r.ContentLength <= captureLimit && strings.Contains(r.Header.Get("Content-Type"), "application/json") {
			body, err := io.ReadAll(io.LimitReader(r.Body, captureLimit+1))
			_ = r.Body.Close()
			if err != nil {
				http.Error(w, "unable to read request", 400)
				return
			}
			fields["shape"] = jsonShape(body)
			r.Body = io.NopCloser(bytes.NewReader(body))
			if r.URL.Path == "/mcp" {
				var registration struct {
					Name   string `json:"name"`
					Config struct {
						Type string `json:"type"`
						URL  string `json:"url"`
					} `json:"config"`
				}
				if json.Unmarshal(body, &registration) == nil {
					if registration.Name == "studio-mcp" || registration.Name == "xbot-copilot" {
						fields["mcpName"] = registration.Name
					}
					if registration.Config.Type == "local" || registration.Config.Type == "remote" {
						fields["mcpType"] = registration.Config.Type
					}
					if u, err := url.Parse(registration.Config.URL); err == nil && registration.Config.URL != "" {
						fields["mcpSsePath"] = strings.HasSuffix(u.Path, "/sse")
						fields["mcpLoopback"] = u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost"
					}
				}
			}
		}
		trace.record(fields)
		target := upstream.Load()
		if target == nil {
			http.Error(w, "OpenCode starting", 503)
			return
		}
		proxy := &httputil.ReverseProxy{
			Rewrite: func(req *httputil.ProxyRequest) {
				req.SetURL(target)
				req.Out.URL.RawQuery = req.In.URL.RawQuery
				req.Out.Header.Del("Accept-Encoding")
			},
			FlushInterval: -1,
			ModifyResponse: func(res *http.Response) error {
				stream := strings.HasPrefix(res.Header.Get("Content-Type"), "text/event-stream")
				trace.record(map[string]any{"kind": "response", "request": id, "status": res.StatusCode, "stream": stream})
				if stream || strings.Contains(res.Header.Get("Content-Type"), "application/json") {
					res.Body = &observeBody{ReadCloser: res.Body, stream: stream, trace: trace, request: id}
				}
				return nil
			},
			ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) { http.Error(w, "OpenCode unavailable", 502) },
		}
		proxy.ServeHTTP(w, r)
	})}
	defer server.Close()
	go func() { _ = server.Serve(listener) }()
	cmd := exec.Command(backup, append(childArgs, "--hostname", "127.0.0.1", "--port", "0")...)
	cmd.Stdout = &backendStdout{upstream: &upstream, public: listener.Addr().String()}
	cmd.Stderr = os.Stderr
	return supervise(cmd)
}
