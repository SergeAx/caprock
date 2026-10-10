package api

import (
	"context"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/store"
)

// A status line run under one of Caprock's subscription directories reports
// that sign-in's windows (ADR-048): they are stored under its prefix, and the
// Default sign-in's are left as they were. A session started on a
// subscription is matched by its row when no directory is forwarded.
func TestStatuslineFilesWindowsUnderTheSubscription(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	data := filepath.Join(t.TempDir(), "caprock")
	e.api.d.DataDir = data
	post := func(body string) {
		t.Helper()
		req, _ := http.NewRequest(http.MethodPost, e.srv.URL+"/v1/statusline", strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer tok")
		resp, err := http.DefaultClient.Do(req)
		if err != nil || resp.StatusCode != 204 {
			t.Fatalf("statusline: %v", err)
		}
		resp.Body.Close()
	}
	dir := filepath.ToSlash(filepath.Join(data, "profiles", "ab12"))
	post(`{"session_id":"s1","five_hour":{"used_percentage":91,"resets_at":1787227200},"config_dir":"` + dir + `"}`)
	if _, ok, _ := store.LatestRateLimit(ctx, e.st.DB(), "five_hour"); ok {
		t.Fatal("a subscription's window was stored as the Default sign-in's")
	}
	got, err := store.RateLimitsWithPrefix(ctx, e.st.DB(), "sub:ab12:")
	if err != nil || len(got) != 1 || got[0].UsedPercentage != 91 {
		t.Fatalf("subscription windows: %+v %v", got, err)
	}

	if err := store.UpsertSession(ctx, e.st.DB(), "s2", store.SessionPatch{Cwd: "/x", Subscription: "cd34"}); err != nil {
		t.Fatal(err)
	}
	post(`{"session_id":"s2","seven_day":{"used_percentage":40,"resets_at":1787227200}}`)
	if got, _ := store.RateLimitsWithPrefix(ctx, e.st.DB(), "sub:cd34:"); len(got) != 1 {
		t.Fatalf("by session: %+v", got)
	}
	post(`{"session_id":"s3","five_hour":{"used_percentage":12,"resets_at":1787227200}}`)
	if s, ok, _ := store.LatestRateLimit(ctx, e.st.DB(), "five_hour"); !ok || s.UsedPercentage != 12 {
		t.Fatalf("default: %+v %v", s, ok)
	}
}

// Without a manager the endpoint says so rather than answering an empty list.
func TestSubscriptionsUnavailable(t *testing.T) {
	e := newEnv(t)
	if code := e.get(t, "/v1/subscriptions", nil); code != http.StatusNotImplemented {
		t.Fatalf("GET without a manager: %d", code)
	}
}
