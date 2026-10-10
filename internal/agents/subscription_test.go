package agents

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/store"
)

// A session on a subscription (ADR-048) runs with that subscription's
// configuration directory in its environment, is trusted in that directory's
// .claude.json rather than the user's, and records the subscription.
func TestSpawnOnASubscription(t *testing.T) {
	home := trustTestHome(t)
	m, st, f := newMgr(t)
	t.Cleanup(m.Shutdown)
	profile := filepath.Join(t.TempDir(), "profiles", "ab12")
	if err := os.MkdirAll(profile, 0o700); err != nil {
		t.Fatal(err)
	}
	cwd := t.TempDir()
	ag, err := m.Spawn(context.Background(), SpawnRequest{Cwd: cwd, Subscription: "ab12", ConfigDir: profile})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(f.lastSpec.Env, "CLAUDE_CONFIG_DIR="+profile) {
		t.Errorf("env lacks the profile: %v", envWith(f.lastSpec.Env, "CLAUDE_"))
	}
	if b, err := os.ReadFile(filepath.Join(profile, ".claude.json")); err != nil || !strings.Contains(string(b), "hasTrustDialogAccepted") {
		t.Errorf("profile not trusted: %s %v", b, err)
	}
	if _, err := os.Stat(filepath.Join(home, ".claude.json")); err == nil {
		t.Error("the user's own .claude.json was written for a subscription's session")
	}
	s, err := store.GetSession(context.Background(), st.DB(), ag.SessionID)
	if err != nil || s.Subscription != "ab12" {
		t.Errorf("session subscription %q, %v", s.Subscription, err)
	}

	// Codex gets CODEX_HOME.
	m.bins = map[string]string{AgentCodex: "/opt/bin/codex"}
	if _, err := m.Spawn(context.Background(), SpawnRequest{Cwd: cwd, Agent: AgentCodex, Subscription: "cd34", ConfigDir: profile}); err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(f.lastSpec.Env, "CODEX_HOME="+profile) {
		t.Errorf("codex env: %v", envWith(f.lastSpec.Env, "CODEX_"))
	}

	// A subscription without its directory, or on an agent that has none, is refused.
	if _, err := m.Spawn(context.Background(), SpawnRequest{Cwd: cwd, Subscription: "ab12"}); err == nil {
		t.Error("a subscription with no directory was started")
	}
	m.bins[AgentGrok] = "/opt/bin/grok"
	if _, err := m.Spawn(context.Background(), SpawnRequest{Cwd: cwd, Agent: AgentGrok, Subscription: "ab12", ConfigDir: profile}); err == nil {
		t.Error("grok was started on a subscription")
	}
	// "default" is the user's own sign-in: no variable set.
	if _, err := m.Spawn(context.Background(), SpawnRequest{Cwd: cwd, Subscription: "default"}); err != nil {
		t.Fatal(err)
	}
	if len(envWith(f.lastSpec.Env, "CLAUDE_CONFIG_DIR=")) != 0 && os.Getenv("CLAUDE_CONFIG_DIR") == "" {
		t.Errorf("default set a config dir: %v", envWith(f.lastSpec.Env, "CLAUDE_CONFIG_DIR="))
	}
}

func envWith(env []string, prefix string) []string {
	var out []string
	for _, kv := range env {
		if strings.HasPrefix(kv, prefix) {
			out = append(out, kv)
		}
	}
	return out
}
