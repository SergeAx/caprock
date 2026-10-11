package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// attemptAgents starts each "session" in a copy of its own: a repository at
// root/<worktree>, as the daemon's spawn would make one, and records it in
// the store.
type attemptAgents struct {
	fakeAgents
	t    *testing.T
	st   *store.Store
	root string
	// failAt makes the n-th spawn fail.
	failAt int
	mu     sync.Mutex
	n      int
}

func (a *attemptAgents) Spawn(ctx context.Context, req any) (string, string, error) {
	m := req.(map[string]any)
	a.mu.Lock()
	a.n++
	n := a.n
	a.spawns = append(a.spawns, m)
	a.mu.Unlock()
	if n == a.failAt {
		return "", "", errors.New("agents: branch caprock/x already exists")
	}
	name, _ := m["worktree"].(string)
	dir := gitRepo(a.t, filepath.Join(a.root, name))
	id := "s-" + name
	if err := store.UpsertSession(ctx, a.st.DB(), id, store.SessionPatch{Cwd: dir, Agent: "claude", StartedAt: 1000, LastEventAt: 2000}); err != nil {
		return "", "", err
	}
	return id, dir, nil
}

func attemptServer(t *testing.T, failAt int) (*env, *attemptAgents, func(method, path, body string) *httptest.ResponseRecorder) {
	t.Helper()
	e := newEnv(t)
	fa := &attemptAgents{fakeAgents: fakeAgents{avail: true}, t: t, st: e.st, root: t.TempDir(), failAt: failAt}
	h := New(Deps{Store: e.st, Version: "t", Token: "tok", Now: func() time.Time { return e.now }, Agents: fa})
	do := func(method, path, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		return rr
	}
	return e, fa, do
}

type attemptsAnswer struct {
	Group    string        `json:"group"`
	Base     string        `json:"base"`
	Attempts []AttemptView `json:"attempts"`
}

func TestAttemptsStartSeveralCopiesAndCompareThem(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	e, fa, do := attemptServer(t, 0)
	w := do("POST", "/v1/agents", `{"cwd":"/repo","worktree":"fix-login","worktree_base":"main","worktree_pull":true,"prompt":"fix the login","attempts":3}`)
	if w.Code != http.StatusOK {
		t.Fatalf("start: %d %s", w.Code, w.Body)
	}
	var started struct {
		SessionID    string   `json:"session_id"`
		SessionIDs   []string `json:"session_ids"`
		AttemptGroup string   `json:"attempt_group"`
		Error        string   `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &started); err != nil {
		t.Fatal(err)
	}
	if strings.Join(started.SessionIDs, ",") != "s-fix-login-1,s-fix-login-2,s-fix-login-3" || started.SessionID != "s-fix-login-1" || started.AttemptGroup == "" || started.Error != "" {
		t.Fatalf("started %+v", started)
	}
	// One copy each, the same message, the base fetched once; the copies
	// after the first start from the commit the first started from.
	first := gitHead(t, filepath.Join(fa.root, "fix-login-1"))
	for i, m := range fa.spawns {
		wantBase := "main"
		if i > 0 {
			wantBase = first
		}
		if m["prompt"] != "fix the login" || m["worktree_base"] != wantBase {
			t.Errorf("spawn %d: %v", i+1, m)
		}
		if _, has := m["attempts"]; has {
			t.Errorf("spawn %d was handed attempts", i+1)
		}
		if pull, _ := m["worktree_pull"].(bool); pull != (i == 0) {
			t.Errorf("spawn %d: worktree_pull %v", i+1, m["worktree_pull"])
		}
	}

	// Each session says which attempt it is.
	sess, err := store.GetSession(context.Background(), e.st.DB(), "s-fix-login-2")
	if err != nil {
		t.Fatal(err)
	}
	if sess.AttemptGroup != started.AttemptGroup || sess.Attempt != 2 || sess.Attempts != 3 {
		t.Fatalf("session 2: %+v", sess)
	}

	// The second attempt changed something; the third's copy is gone.
	two := filepath.Join(fa.root, "fix-login-2")
	if err := os.WriteFile(filepath.Join(two, "login.go"), []byte("package login\n\nfunc ok() {}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(filepath.Join(fa.root, "fix-login-3")); err != nil {
		t.Fatal(err)
	}
	if _, err := store.AddStats(context.Background(), e.st.DB(), store.Stats{SessionID: "s-fix-login-2", Turns: 3, CostUSD: 0.42}); err != nil {
		t.Fatal(err)
	}

	w = do("GET", "/v1/attempts/"+started.AttemptGroup, "")
	if w.Code != http.StatusOK {
		t.Fatalf("compare: %d %s", w.Code, w.Body)
	}
	var got attemptsAnswer
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Base != "main" || len(got.Attempts) != 3 {
		t.Fatalf("compare: %+v", got)
	}
	a1, a2, a3 := got.Attempts[0], got.Attempts[1], got.Attempts[2]
	if a1.N != 1 || a2.N != 2 || a3.N != 3 || a2.Total != 3 {
		t.Fatalf("order: %+v", got.Attempts)
	}
	if a1.Changes == nil || a1.Changes.Files != 0 {
		t.Errorf("attempt 1 changed nothing: %+v %q", a1.Changes, a1.ChangesError)
	}
	if a2.Changes == nil || a2.Changes.Files != 1 || a2.Changes.Additions != 3 || a2.Stats.CostUSD != 0.42 {
		t.Errorf("attempt 2: %+v %+v %q", a2.Changes, a2.Stats, a2.ChangesError)
	}
	if a3.Changes != nil || !strings.Contains(a3.ChangesError, "removed") {
		t.Errorf("attempt 3: %+v %q", a3.Changes, a3.ChangesError)
	}
	if a2.BaseCommit == "" {
		t.Error("no base commit recorded")
	}

	if w := do("GET", "/v1/attempts/nope", ""); w.Code != http.StatusNotFound {
		t.Fatalf("unknown group: %d", w.Code)
	}
}

// A failure stops the rest; the ones that started are kept, grouped as what
// started, and the answer says what did not.
func TestAttemptsStopAtTheFirstFailure(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	e, fa, do := attemptServer(t, 3)
	w := do("POST", "/v1/agents", `{"cwd":"/repo","worktree":"x","prompt":"p","attempts":4}`)
	if w.Code != http.StatusOK {
		t.Fatalf("start: %d %s", w.Code, w.Body)
	}
	var started struct {
		SessionIDs []string `json:"session_ids"`
		Error      string   `json:"error"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &started)
	if len(started.SessionIDs) != 2 || !strings.Contains(started.Error, "attempt 3 of 4") || len(fa.spawns) != 3 {
		t.Fatalf("started %+v after %d spawns", started, len(fa.spawns))
	}
	sess, _ := store.GetSession(context.Background(), e.st.DB(), "s-x-2")
	if sess.Attempts != 2 {
		t.Fatalf("the group's total: %d, want 2", sess.Attempts)
	}

	// The first one failing starts nothing and is an error.
	_, _, do = attemptServer(t, 1)
	if w := do("POST", "/v1/agents", `{"cwd":"/repo","worktree":"y","attempts":2}`); w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "attempt 1 of 2") {
		t.Fatalf("first fails: %d %s", w.Code, w.Body)
	}
}

func TestAttemptsAreRefusedWhereTheyMakeNoSense(t *testing.T) {
	_, fa, do := attemptServer(t, 0)
	for _, body := range []string{
		`{"cwd":"/repo","attempts":2}`,                                 // no new copy
		`{"cwd":"/repo","worktree":"x","attempts":5}`,                  // too many
		`{"cwd":"/repo","worktree":"x","attempts":0}`,                  // too few
		`{"cwd":"/repo","worktree":"x","attempts":1.5}`,                // not whole
		`{"cwd":"/repo","worktree":"x","attempts":"2"}`,                // not a number
		`{"cwd":"/repo","worktree":"x","resume":"s1","attempts":2}`,    // a continue
		`{"chat":true,"worktree":"x","attempts":2}`,                    // a quick chat
		`{"cwd":"/repo","worktree":"x","relay_from":"s","attempts":3}`, // a relay
	} {
		if w := do("POST", "/v1/agents", body); w.Code != http.StatusBadRequest {
			t.Errorf("%s: %d, want 400", body, w.Code)
		}
	}
	if len(fa.spawns) != 0 {
		t.Fatalf("something started: %v", fa.spawns)
	}
	// One attempt is an ordinary start.
	if w := do("POST", "/v1/agents", `{"cwd":"/repo","worktree":"one","attempts":1}`); w.Code != http.StatusOK || strings.Contains(w.Body.String(), "attempt_group") {
		t.Fatalf("one attempt: %d %s", w.Code, w.Body)
	}
	if _, has := fa.spawns[0]["attempts"]; has {
		t.Fatal("a single start was handed attempts")
	}
}

// gitHead is the commit HEAD names in dir.
func gitHead(t *testing.T, dir string) string {
	t.Helper()
	out, err := exec.Command("git", "-C", dir, "rev-parse", "HEAD").Output()
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(out))
}
