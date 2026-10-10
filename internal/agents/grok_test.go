package agents

import (
	"context"
	"slices"
	"testing"
)

// Built from grok 0.2.114's own `grok --help`, read 2026-10-10: a new session
// is named with --session-id, a resume with --resume (and --fork-session plus
// --session-id to branch), the model with --model, the mode with Claude
// Code's own names, the project's instructions with --rules, and the first
// message as the positional prompt.
func TestGrokArgv(t *testing.T) {
	l, err := grokLaunch(launchInput{SessionID: "11111111-2222-4333-8444-555555555555", Model: "grok-4.7", Mode: "acceptEdits", SystemPrompt: "Use make.", Prompt: "fix the bug"})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"--session-id", "11111111-2222-4333-8444-555555555555", "--model", "grok-4.7", "--permission-mode", "acceptEdits", "--rules", "Use make.", "fix the bug"}
	if !slices.Equal(l.args, want) {
		t.Errorf("new: %q", l.args)
	}
	// A mode Grok does not list is left off rather than guessed at.
	if l, _ := grokLaunch(launchInput{SessionID: "s", Mode: "manual"}); slices.Contains(l.args, "--permission-mode") {
		t.Errorf("manual was passed: %q", l.args)
	}
	l, _ = grokLaunch(launchInput{SessionID: "new", Resume: "old", Prompt: "ignored"})
	if !slices.Equal(l.args, []string{"--resume", "old"}) || l.sessionID != "old" {
		t.Errorf("resume: %q %s", l.args, l.sessionID)
	}
	l, _ = grokLaunch(launchInput{SessionID: "new", Resume: "old", Fork: true})
	if !slices.Equal(l.args, []string{"--resume", "old", "--fork-session", "--session-id", "new"}) || l.sessionID != "new" {
		t.Errorf("fork: %q %s", l.args, l.sessionID)
	}
}

func TestGrokSpawnsWithItsBinary(t *testing.T) {
	m, _, f := newMgr(t)
	m.bins = map[string]string{AgentGrok: "/opt/bin/grok"}
	t.Cleanup(m.Shutdown)
	ag, err := m.Spawn(context.Background(), SpawnRequest{Cwd: t.TempDir(), Agent: AgentGrok, PermissionMode: "plan"})
	if err != nil {
		t.Fatal(err)
	}
	if f.lastSpec.Command != "/opt/bin/grok" || ag.Kind != AgentGrok || !slices.Contains(f.lastSpec.Args, "plan") {
		t.Errorf("spec %+v kind %s", f.lastSpec, ag.Kind)
	}
	if !IsSpawnable(AgentGrok) {
		t.Error("grok is not spawnable")
	}
}
