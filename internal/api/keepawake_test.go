package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/dspv/caprock/internal/keepawake"
)

// keep_awake travels through PUT /v1/settings as a patch, and a word that is
// not a mode is refused rather than stored.
func TestKeepAwakeSettingValidates(t *testing.T) {
	e := newEnv(t)
	if code := e.putSettings(t, map[string]any{"keep_awake": "always"}); code != http.StatusOK {
		t.Fatalf("always: %d", code)
	}
	var s Settings
	if code := e.get(t, "/v1/settings", &s); code != http.StatusOK || s.KeepAwake != keepawake.ModeAlways {
		t.Fatalf("GET: %d %q", code, s.KeepAwake)
	}
	if code := e.putSettings(t, map[string]any{"keep_awake": "forever"}); code != http.StatusBadRequest {
		t.Fatalf("an unknown mode answered %d, want 400", code)
	}
	if code := e.putSettings(t, map[string]any{"keep_awake": ""}); code != http.StatusBadRequest {
		t.Fatalf("an empty mode answered %d, want 400", code)
	}
	_ = e.putSettings(t, map[string]any{"plan_label": "Max"})
	if code := e.get(t, "/v1/settings", &s); code != http.StatusOK || s.KeepAwake != keepawake.ModeAlways {
		t.Fatalf("an unrelated save changed keep_awake to %q", s.KeepAwake)
	}
}

func TestKeepAwakeStatusEndpoint(t *testing.T) {
	e := newEnv(t)
	if code := e.get(t, "/v1/keepawake", nil); code != http.StatusNotImplemented {
		t.Fatalf("without a keeper: %d, want 501", code)
	}
	s := New(Deps{Store: e.st, Token: "tok", KeepAwake: func() any {
		return keepawake.Status{Mode: keepawake.ModeWorking, Holding: true, Working: 2, Available: true}
	}})
	srv := httptest.NewServer(s)
	defer srv.Close()
	e2 := &env{srv: srv}
	var st keepawake.Status
	if code := e2.get(t, "/v1/keepawake", &st); code != http.StatusOK {
		t.Fatalf("GET: %d", code)
	}
	if !st.Holding || st.Working != 2 || st.Mode != keepawake.ModeWorking {
		t.Fatalf("status = %+v", st)
	}
}
