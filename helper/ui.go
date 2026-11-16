package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"html/template"
	"net"
	"net/http"
	"runtime"
	"strings"
	"sync"
	"time"
)

type uiServer struct {
	mu        sync.Mutex
	cfg       Config
	relay     *Relay
	uiPort    int
	relayPort int
	csrf      string
	log       []string
}

func randomToken() string {
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return base64.RawURLEncoding.EncodeToString(buf)
}

func (s *uiServer) addLog(line string) {
	s.log = append(s.log, fmt.Sprintf("%s  %s", time.Now().Format("15:04:05"), line))
	if len(s.log) > 40 {
		s.log = s.log[len(s.log)-40:]
	}
}

type statusResponse struct {
	Server       string   `json:"server"`
	Paired       bool     `json:"paired"`
	RelayRunning bool     `json:"relayRunning"`
	RelayURL     string   `json:"relayUrl"`
	HelperURL    string   `json:"helperUrl"`
	Version      string   `json:"version"`
	Log          []string `json:"log"`
}

func (s *uiServer) statusLocked() statusResponse {
	relayURL := fmt.Sprintf("http://127.0.0.1:%d/oauth-callback", s.relayPort)
	return statusResponse{
		Server:       s.cfg.Server,
		Paired:       s.cfg.Token != "",
		RelayRunning: s.relay != nil,
		RelayURL:     relayURL,
		HelperURL:    fmt.Sprintf("http://127.0.0.1:%d", s.uiPort),
		Version:      version,
		Log:          append([]string(nil), s.log...),
	}
}

func (s *uiServer) requireCSRF(w http.ResponseWriter, r *http.Request) bool {
	if r.Header.Get("X-Helper-Token") != s.csrf {
		http.Error(w, "invalid helper token", http.StatusForbidden)
		return false
	}
	return true
}

func (s *uiServer) writeJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(value)
}

func (s *uiServer) handleStatus(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.writeJSON(w, s.statusLocked())
}

func (s *uiServer) handleServer(w http.ResponseWriter, r *http.Request) {
	if !s.requireCSRF(w, r) {
		return
	}
	var body struct {
		Server string `json:"server"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	server := strings.TrimRight(strings.TrimSpace(body.Server), "/")
	if server == "" {
		http.Error(w, "server URL is required", http.StatusBadRequest)
		return
	}
	if !strings.HasPrefix(server, "http://") && !strings.HasPrefix(server, "https://") {
		http.Error(w, "server URL must start with http:// or https://", http.StatusBadRequest)
		return
	}

	s.mu.Lock()
	s.cfg.Server = server
	err := saveConfig(s.cfg)
	if err == nil {
		s.addLog("server set to " + server)
	}
	status := s.statusLocked()
	s.mu.Unlock()

	if err != nil {
		http.Error(w, "could not save config: "+err.Error(), http.StatusInternalServerError)
		return
	}
	s.writeJSON(w, status)
}

func (s *uiServer) handlePair(w http.ResponseWriter, r *http.Request) {
	if !s.requireCSRF(w, r) {
		return
	}
	var body struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	code := strings.TrimSpace(body.Code)
	if len(code) != 6 {
		http.Error(w, "enter the 6-digit code from the dashboard", http.StatusBadRequest)
		return
	}

	s.mu.Lock()
	server := s.cfg.Server
	s.mu.Unlock()

	token, err := pairDevice(server, code, "Desktop helper ("+goos()+")")
	if err != nil {
		s.mu.Lock()
		s.addLog("pairing failed: " + err.Error())
		s.mu.Unlock()
		http.Error(w, err.Error(), http.StatusUnauthorized)
		return
	}

	s.mu.Lock()
	s.cfg.Token = token
	s.addLog("this computer is paired")
	if saveErr := saveConfig(s.cfg); saveErr != nil {
		s.addLog("warning: could not save config: " + saveErr.Error())
	}
	status := s.statusLocked()
	s.mu.Unlock()

	s.writeJSON(w, status)
}

func (s *uiServer) handleImport(w http.ResponseWriter, r *http.Request) {
	if !s.requireCSRF(w, r) {
		return
	}
	var body struct {
		Content string `json:"content"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxImportBytes+1024)).Decode(&body); err != nil {
		http.Error(w, "invalid request or file too large", http.StatusBadRequest)
		return
	}

	s.mu.Lock()
	server, token := s.cfg.Server, s.cfg.Token
	s.mu.Unlock()

	result, err := importContent(server, token, []byte(body.Content))
	s.mu.Lock()
	if err != nil {
		s.addLog("import failed: " + err.Error())
	} else {
		s.addLog("import complete: " + result)
	}
	status := s.statusLocked()
	s.mu.Unlock()

	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	s.writeJSON(w, status)
}

func (s *uiServer) handleRelay(w http.ResponseWriter, r *http.Request) {
	if !s.requireCSRF(w, r) {
		return
	}
	var body struct {
		Action string `json:"action"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	switch body.Action {
	case "start":
		if s.relay != nil {
			s.writeJSON(w, s.statusLocked())
			return
		}
		relay, err := startRelay(s.relayPort, s.cfg.Server)
		if err != nil {
			s.addLog(err.Error())
			http.Error(w, err.Error(), http.StatusConflict)
			return
		}
		s.relay = relay
		s.addLog(fmt.Sprintf("relay started on 127.0.0.1:%d", s.relayPort))
	case "stop":
		if s.relay != nil {
			s.relay.Stop()
			s.relay = nil
			s.addLog("relay stopped")
		}
	default:
		http.Error(w, "unknown action", http.StatusBadRequest)
		return
	}

	s.writeJSON(w, s.statusLocked())
}

const pageTemplate = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Framecall Helper</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
         background:#faf7f2; color:#2a2723; }
  .wrap { max-width:720px; margin:0 auto; padding:32px 20px 48px; }
  h1 { font-size:22px; margin:0 0 4px; letter-spacing:-0.01em; }
  .sub { color:#706b65; margin:0 0 24px; font-size:13px; }
  .card { background:#fff; border:1px solid #eae5de; border-radius:14px; padding:18px; margin-bottom:14px; }
  .card h2 { font-size:13px; text-transform:uppercase; letter-spacing:.06em; color:#c25938; margin:0 0 10px; }
  .row { display:flex; gap:8px; flex-wrap:wrap; }
  input[type=text],input[type=file] { flex:1 1 240px; min-width:0; padding:9px 11px; border:1px solid #eae5de;
         border-radius:10px; background:#fff; font:inherit; }
  button { padding:9px 14px; border-radius:10px; border:1px solid #ddd7ce; background:#f2ece4; color:#2a2723;
           font:inherit; font-weight:600; cursor:pointer; }
  button.primary { background:#c25938; border-color:#c25938; color:#fff; }
  button:disabled { opacity:.5; cursor:default; }
  .pill { display:inline-flex; align-items:center; gap:6px; font-size:12px; padding:3px 9px; border-radius:999px;
          border:1px solid #d3e4db; background:#eef5f1; color:#4e7b62; }
  .pill.off { border-color:#eae5de; background:#f2ece4; color:#706b65; }
  .dot { width:7px; height:7px; border-radius:50%; background:currentColor; }
  code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
  .muted { color:#9e988f; font-size:12px; }
  .msg { margin-top:10px; font-size:13px; }
  .msg.ok { color:#4e7b62; } .msg.err { color:#c25938; }
  pre { background:#faf7f2; border:1px solid #eae5de; border-radius:10px; padding:10px; overflow:auto;
        max-height:180px; font-size:11.5px; margin:0; color:#706b65; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Framecall Helper</h1>
  <p class="sub">Pairs this computer with <code>{{.Server}}</code>. Nothing is installed on the server.</p>

  <div class="card">
    <h2>Status</h2>
    <div class="row" style="align-items:center;gap:10px">
      <span class="pill {{if not .Paired}}off{{end}}"><span class="dot"></span>{{if .Paired}}Paired{{else}}Not paired{{end}}</span>
      <span class="pill {{if not .RelayRunning}}off{{end}}"><span class="dot"></span>{{if .RelayRunning}}Relay running{{else}}Relay stopped{{end}}</span>
    </div>
  </div>

  <div class="card">
    <h2>1. Server</h2>
    <div class="row">
      <input id="server" type="text" value="{{.Server}}" spellcheck="false">
      <button id="saveServer">Save</button>
    </div>
  </div>

  <div class="card">
    <h2>2. Pair this computer</h2>
    <p class="muted" style="margin:0 0 10px">In the dashboard open <strong>Accounts → Pair desktop helper</strong> and enter the 6-digit code.</p>
    <div class="row">
      <input id="code" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="123456">
      <button id="pair" class="primary">Pair</button>
    </div>
  </div>

  <div class="card">
    <h2>3. Sign-in relay</h2>
    <p class="muted" style="margin:0 0 10px">Keep this running while adding a Google account. Google returns to
      <code>{{.RelayURL}}</code> and the helper forwards it to the dashboard.</p>
    <div class="row">
      <button id="relayToggle">{{if .RelayRunning}}Stop relay{{else}}Start relay{{end}}</button>
    </div>
  </div>

  <div class="card">
    <h2>4. Import accounts</h2>
    <p class="muted" style="margin:0 0 10px">Export accounts from the Antigravity app, then pick the file here.</p>
    <div class="row">
      <input id="file" type="file" accept=".json,application/json">
    </div>
    <div id="msg" class="msg"></div>
  </div>

  <div class="card">
    <h2>Log</h2>
    <pre id="log">{{range .Log}}{{.}}
{{else}}(nothing yet){{end}}</pre>
  </div>
</div>
<script>
const HELPER_TOKEN = {{.CSRF}};
const msg = document.getElementById('msg');

function setMsg(text, ok) {
  msg.textContent = text || '';
  msg.className = 'msg ' + (ok ? 'ok' : 'err');
}

function headers() {
  return { 'Content-Type': 'application/json', 'X-Helper-Token': HELPER_TOKEN };
}

async function call(path, body) {
  const res = await fetch(path, { method: 'POST', headers: headers(), body: JSON.stringify(body || {}) });
  const text = await res.text();
  if (!res.ok) throw new Error(text.trim() || ('HTTP ' + res.status));
  return text ? JSON.parse(text) : null;
}

async function refresh() {
  const res = await fetch('/local/status');
  if (!res.ok) return;
  const s = await res.json();
  document.getElementById('log').textContent = (s.log && s.log.length ? s.log.join('\n') : '(nothing yet)');
  document.getElementById('relayToggle').textContent = s.relayRunning ? 'Stop relay' : 'Start relay';
  const pills = document.querySelectorAll('.pill');
  pills[0].className = 'pill' + (s.paired ? '' : ' off');
  pills[0].innerHTML = '<span class="dot"></span>' + (s.paired ? 'Paired' : 'Not paired');
  pills[1].className = 'pill' + (s.relayRunning ? '' : ' off');
  pills[1].innerHTML = '<span class="dot"></span>' + (s.relayRunning ? 'Relay running' : 'Relay stopped');
}

document.getElementById('saveServer').addEventListener('click', async () => {
  setMsg('');
  try {
    await call('/local/server', { server: document.getElementById('server').value });
    setMsg('Server saved.', true);
    refresh();
  } catch (err) { setMsg(err.message, false); }
});

document.getElementById('pair').addEventListener('click', async () => {
  setMsg('');
  try {
    await call('/local/pair', { code: document.getElementById('code').value.trim() });
    setMsg('Paired successfully.', true);
    document.getElementById('code').value = '';
    refresh();
  } catch (err) { setMsg(err.message, false); }
});

document.getElementById('relayToggle').addEventListener('click', async () => {
  const label = document.getElementById('relayToggle').textContent;
  try {
    await call('/local/relay', { action: label.toLowerCase().startsWith('stop') ? 'stop' : 'start' });
    refresh();
  } catch (err) { setMsg(err.message, false); }
});

document.getElementById('file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { setMsg('File is larger than 5 MB.', false); return; }
  setMsg('Importing...', true);
  try {
    const content = await file.text();
    await call('/local/import', { content });
    setMsg('Import complete.', true);
    refresh();
  } catch (err) { setMsg(err.message, false); }
});

refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>
`

func (s *uiServer) handlePage(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	s.mu.Lock()
	data := struct {
		Server       string
		Paired       bool
		RelayRunning bool
		RelayURL     string
		CSRF         template.JS
		Log          []string
	}{
		Server:       s.cfg.Server,
		Paired:       s.cfg.Token != "",
		RelayRunning: s.relay != nil,
		RelayURL:     fmt.Sprintf("http://127.0.0.1:%d/oauth-callback", s.relayPort),
		CSRF:         template.JS(fmt.Sprintf("%q", s.csrf)),
		Log:          append([]string(nil), s.log...),
	}
	s.mu.Unlock()

	tmpl, err := template.New("page").Parse(pageTemplate)
	if err != nil {
		http.Error(w, "template error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_ = tmpl.Execute(w, data)
}

func goos() string {
	return runtime.GOOS
}

func runUI(cfg Config, uiPort, relayPort int, open bool) error {
	state := &uiServer{
		cfg:       cfg,
		uiPort:    uiPort,
		relayPort: relayPort,
		csrf:      randomToken(),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/", state.handlePage)
	mux.HandleFunc("/local/status", state.handleStatus)
	mux.HandleFunc("/local/server", state.handleServer)
	mux.HandleFunc("/local/pair", state.handlePair)
	mux.HandleFunc("/local/import", state.handleImport)
	mux.HandleFunc("/local/relay", state.handleRelay)

	addr := fmt.Sprintf("127.0.0.1:%d", uiPort)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("cannot start the helper page on %s (is it already running?): %w", addr, err)
	}

	// The relay is the reason most people open this page; start it if the port is free.
	if relay, relayErr := startRelay(relayPort, cfg.Server); relayErr == nil {
		state.mu.Lock()
		state.relay = relay
		state.addLog(fmt.Sprintf("relay started on 127.0.0.1:%d", relayPort))
		state.mu.Unlock()
	} else {
		state.mu.Lock()
		state.addLog("relay not started: " + relayErr.Error())
		state.mu.Unlock()
	}

	helperURL := fmt.Sprintf("http://%s/", addr)
	fmt.Println("Framecall helper is running.")
	fmt.Printf("  Helper page: %s\n", helperURL)
	fmt.Printf("  Relay:       http://127.0.0.1:%d/oauth-callback\n", relayPort)
	fmt.Println("Press Ctrl+C to stop.")
	if open {
		go openBrowser(helperURL)
	}

	server := &http.Server{Handler: mux}
	return server.Serve(ln)
}
