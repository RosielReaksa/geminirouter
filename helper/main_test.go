package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRelayForwardsCallback(t *testing.T) {
	handler := relayHandler("https://example.test/")
	req := httptest.NewRequest(http.MethodGet, "/oauth-callback?state=abc&code=4%2Fxyz", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusFound {
		t.Fatalf("expected 302, got %d", rec.Code)
	}
	want := "https://example.test/oauth/callback?code=4%2Fxyz&state=abc"
	if got := rec.Header().Get("Location"); got != want {
		t.Fatalf("unexpected redirect:\n got %q\nwant %q", got, want)
	}
}

func TestRelayForwardsErrors(t *testing.T) {
	handler := relayHandler("https://example.test")
	req := httptest.NewRequest(http.MethodGet, "/oauth-callback?state=abc&error=access_denied", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	want := "https://example.test/oauth/callback?error=access_denied&state=abc"
	if got := rec.Header().Get("Location"); got != want {
		t.Fatalf("unexpected redirect: %q", got)
	}
}

func TestRelayRejectsIncompleteAndNonGet(t *testing.T) {
	handler := relayHandler("https://example.test")

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/oauth-callback?state=abc", nil))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for incomplete callback, got %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/oauth-callback?state=abc&code=x", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405 for POST, got %d", rec.Code)
	}
}

func TestValidateExport(t *testing.T) {
	valid := []byte(`{"version":"1.0","exportedAt":1700000000,"accounts":[]}`)
	if err := validateExport(valid); err != nil {
		t.Fatalf("valid export rejected: %v", err)
	}

	cases := map[string]string{
		"empty":       ``,
		"not json":    `nope`,
		"wrong ver":   `{"version":"2.0","exportedAt":1,"accounts":[]}`,
		"no time":     `{"version":"1.0","accounts":[]}`,
		"no accounts": `{"version":"1.0","exportedAt":1}`,
	}
	for name, body := range cases {
		if err := validateExport([]byte(body)); err == nil {
			t.Fatalf("%s: expected an error", name)
		}
	}
}

func TestImportRequiresPairing(t *testing.T) {
	if _, err := importContent("https://example.test", "", []byte(`{"version":"1.0","exportedAt":1,"accounts":[]}`)); err == nil {
		t.Fatal("expected an error when not paired")
	} else if !strings.Contains(err.Error(), "not paired") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestPairRejectsUnknownServer(t *testing.T) {
	_, err := pairDevice("http://127.0.0.1:1", "123456", "test")
	if err == nil {
		t.Fatal("expected a connection error")
	}
}
