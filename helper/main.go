// Framecall helper: pairs this computer with a geminirouter deployment,
// completes the Antigravity loopback OAuth redirect, and imports account
// export files. Single static binary, no runtime dependencies.
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const (
	version          = "0.1.0"
	defaultServer    = "https://framecall.site"
	defaultUIPort    = 41208
	defaultRelayPort = 41209
	maxImportBytes   = 5 * 1024 * 1024
)

// Config is persisted at <user config dir>/framecall/helper.json (0600).
type Config struct {
	Server string `json:"server"`
	Token  string `json:"token"`
	Label  string `json:"label"`
}

func configPath() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "framecall", "helper.json"), nil
}

func loadConfig() Config {
	cfg := Config{Server: defaultServer}
	p, err := configPath()
	if err != nil {
		return cfg
	}
	data, err := os.ReadFile(p)
	if err != nil {
		return cfg
	}
	_ = json.Unmarshal(data, &cfg)
	if strings.TrimSpace(cfg.Server) == "" {
		cfg.Server = defaultServer
	}
	cfg.Server = strings.TrimRight(cfg.Server, "/")
	return cfg
}

func saveConfig(cfg Config) error {
	p, err := configPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	cfg.Server = strings.TrimRight(cfg.Server, "/")
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

func httpClient() *http.Client {
	return &http.Client{Timeout: 30 * time.Second}
}

func postJSON(endpoint string, payload any, bearer string) (int, []byte, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return 0, nil, err
	}
	req, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	resp, err := httpClient().Do(req)
	if err != nil {
		return 0, nil, fmt.Errorf("cannot reach %s: %w", endpoint, err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return resp.StatusCode, nil, err
	}
	return resp.StatusCode, data, nil
}

func pairDevice(server, code, label string) (string, error) {
	status, body, err := postJSON(strings.TrimRight(server, "/")+"/api/device/pair", map[string]string{
		"code":  code,
		"label": label,
	}, "")
	if err != nil {
		return "", err
	}
	var out struct {
		Token string `json:"token"`
		Error string `json:"error"`
	}
	_ = json.Unmarshal(body, &out)
	if status != http.StatusOK {
		if out.Error == "" {
			out.Error = fmt.Sprintf("server returned HTTP %d", status)
		}
		return "", errors.New(out.Error)
	}
	if out.Token == "" {
		return "", errors.New("server did not return a device token")
	}
	return out.Token, nil
}

func validateExport(data []byte) error {
	if len(data) == 0 {
		return errors.New("file is empty")
	}
	if len(data) > maxImportBytes {
		return fmt.Errorf("file is larger than %d MB", maxImportBytes/(1024*1024))
	}
	var parsed map[string]any
	if err := json.Unmarshal(data, &parsed); err != nil {
		return errors.New("file is not valid JSON")
	}
	if v, _ := parsed["version"].(string); v != "1.0" {
		return errors.New(`not an Antigravity export: expected version "1.0"`)
	}
	if _, ok := parsed["exportedAt"].(float64); !ok {
		return errors.New("not an Antigravity export: exportedAt is missing")
	}
	if _, ok := parsed["accounts"].([]any); !ok {
		return errors.New("not an Antigravity export: accounts array is missing")
	}
	return nil
}

func importContent(server, token string, data []byte) (string, error) {
	if token == "" {
		return "", errors.New("this computer is not paired yet")
	}
	if err := validateExport(data); err != nil {
		return "", err
	}
	status, body, err := postJSON(strings.TrimRight(server, "/")+"/api/accounts/import", map[string]string{
		"content":  string(data),
		"strategy": "merge",
	}, token)
	if err != nil {
		return "", err
	}
	if status == http.StatusUnauthorized {
		return "", errors.New("device token was rejected; pair this computer again")
	}
	text := strings.TrimSpace(string(body))
	if status < 200 || status >= 300 {
		return "", fmt.Errorf("server returned HTTP %d: %s", status, summarize(text))
	}
	return summarize(text), nil
}

func summarize(text string) string {
	var parsed struct {
		Error   string `json:"error"`
		Message string `json:"message"`
		Result  struct {
			Imported int `json:"imported"`
			Updated  int `json:"updated"`
			Skipped  int `json:"skipped"`
			Failed   int `json:"failed"`
		} `json:"result"`
	}
	if json.Unmarshal([]byte(text), &parsed) == nil {
		if parsed.Result.Imported+parsed.Result.Updated+parsed.Result.Skipped+parsed.Result.Failed > 0 {
			return fmt.Sprintf("imported %d, updated %d, skipped %d, failed %d",
				parsed.Result.Imported, parsed.Result.Updated, parsed.Result.Skipped, parsed.Result.Failed)
		}
		if parsed.Message != "" {
			return parsed.Message
		}
		if parsed.Error != "" {
			return parsed.Error
		}
	}
	return text
}

func importFile(server, token, file string) (string, error) {
	data, err := os.ReadFile(file)
	if err != nil {
		return "", fmt.Errorf("cannot read %s: %w", file, err)
	}
	return importContent(server, token, data)
}

// relayHandler forwards Google's loopback callback to the deployment.
func relayHandler(target string) http.Handler {
	target = strings.TrimRight(target, "/")
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ready"))
	})
	mux.HandleFunc("/oauth-callback", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "GET only", http.StatusMethodNotAllowed)
			return
		}
		q := r.URL.Query()
		state, code, oauthErr := q.Get("state"), q.Get("code"), q.Get("error")
		if state == "" || (code == "" && oauthErr == "") {
			http.Error(w, "Google sign-in response is incomplete.", http.StatusBadRequest)
			return
		}
		values := url.Values{}
		values.Set("state", state)
		if code != "" {
			values.Set("code", code)
		}
		if oauthErr != "" {
			values.Set("error", oauthErr)
		}
		http.Redirect(w, r, target+"/oauth/callback?"+values.Encode(), http.StatusFound)
	})
	return mux
}

type Relay struct {
	server *http.Server
	port   int
}

func startRelay(port int, target string) (*Relay, error) {
	if strings.TrimSpace(target) == "" {
		return nil, errors.New("server URL is not set")
	}
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return nil, fmt.Errorf("cannot listen on 127.0.0.1:%d (is another helper running?): %w", port, err)
	}
	srv := &http.Server{Handler: relayHandler(target)}
	go srv.Serve(ln)
	return &Relay{server: srv, port: port}, nil
}

func (r *Relay) Stop() {
	if r == nil || r.server == nil {
		return
	}
	_ = r.server.Close()
}

func openBrowser(target string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", target)
	case "darwin":
		cmd = exec.Command("open", target)
	default:
		cmd = exec.Command("xdg-open", target)
	}
	_ = cmd.Start()
}

func main() {
	var (
		serverFlag = flag.String("server", "", "geminirouter base URL (default "+defaultServer+")")
		pairFlag   = flag.String("pair", "", "pair this computer using a 6-digit code from the dashboard")
		importFlag = flag.String("import", "", "import an Antigravity account export file")
		relayOnly  = flag.Bool("relay", false, "run only the OAuth loopback relay")
		noBrowser  = flag.Bool("no-browser", false, "do not open the helper page automatically")
		uiPort     = flag.Int("port", defaultUIPort, "local helper page port")
		relayPort  = flag.Int("relay-port", defaultRelayPort, "loopback OAuth callback port")
		showVer    = flag.Bool("version", false, "print version and exit")
	)
	flag.Parse()

	if *showVer {
		fmt.Printf("framecall helper %s (%s/%s)\n", version, runtime.GOOS, runtime.GOARCH)
		return
	}

	cfg := loadConfig()
	if strings.TrimSpace(*serverFlag) != "" {
		cfg.Server = strings.TrimRight(strings.TrimSpace(*serverFlag), "/")
		if err := saveConfig(cfg); err != nil {
			fmt.Fprintf(os.Stderr, "warning: could not save config: %v\n", err)
		}
	}

	switch {
	case *pairFlag != "":
		label := fmt.Sprintf("Desktop helper (%s)", runtime.GOOS)
		token, err := pairDevice(cfg.Server, *pairFlag, label)
		if err != nil {
			fmt.Fprintf(os.Stderr, "pairing failed: %v\n", err)
			os.Exit(1)
		}
		cfg.Token = token
		cfg.Label = label
		if err := saveConfig(cfg); err != nil {
			fmt.Fprintf(os.Stderr, "paired, but could not save config: %v\n", err)
			os.Exit(1)
		}
		fmt.Println("Paired successfully. This computer can now import accounts.")
		return

	case *importFlag != "":
		result, err := importFile(cfg.Server, cfg.Token, *importFlag)
		if err != nil {
			fmt.Fprintf(os.Stderr, "import failed: %v\n", err)
			os.Exit(1)
		}
		fmt.Println(result)
		return

	case *relayOnly:
		relay, err := startRelay(*relayPort, cfg.Server)
		if err != nil {
			fmt.Fprintf(os.Stderr, "%v\n", err)
			os.Exit(1)
		}
		defer relay.Stop()
		fmt.Printf("Relay listening on http://127.0.0.1:%d — keep this window open during sign-in.\n", *relayPort)
		select {}
	}

	if err := runUI(cfg, *uiPort, *relayPort, !*noBrowser); err != nil {
		fmt.Fprintf(os.Stderr, "%v\n", err)
		os.Exit(1)
	}
}
