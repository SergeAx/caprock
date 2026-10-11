package agents

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/wtsetup"
)

// setupRepo is a repository whose .env is ignored and listed in
// .worktreeinclude.
func setupRepo(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	dir := t.TempDir()
	run := func(a ...string) {
		c := exec.Command("git", append([]string{"-C", dir}, a...)...)
		c.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		if out, err := c.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", a, err, out)
		}
	}
	run("init", "-q")
	_ = os.WriteFile(filepath.Join(dir, ".gitignore"), []byte(".env\n"), 0o600)
	_ = os.WriteFile(filepath.Join(dir, wtsetup.IncludeFile), []byte(".env\n"), 0o600)
	run("add", ".")
	run("commit", "-q", "-m", "init")
	_ = os.WriteFile(filepath.Join(dir, ".env"), []byte("TOKEN=1\n"), 0o600)
	return dir
}

func envHas(env []string, kv string) bool { return slices.Contains(env, kv) }

func TestSpawnInAFreshWorktreeCopiesAndRunsSetupFirst(t *testing.T) {
	trustTestHome(t)
	repo := setupRepo(t)
	m, _, f := newMgr(t)
	defer m.Shutdown()
	n := 0
	m.NewSessionID = func() string { n++; return fmt.Sprintf("s-%d", n) }
	m.ProjectSetup = func(string) string { return "npm install" }
	m.SetupExe = "/opt/caprock/caprock"

	a, err := m.Spawn(context.Background(), SpawnRequest{Cwd: repo, Worktree: "w1"})
	if err != nil {
		t.Fatal(err)
	}
	wt := filepath.Join(repo, WorktreeDir, "w1")
	if b, err := os.ReadFile(filepath.Join(wt, ".env")); err != nil || string(b) != "TOKEN=1\n" {
		t.Fatalf(".env not copied into the worktree: %q %v", b, err)
	}
	spec := f.lastSpec
	if spec.Command != m.SetupExe || len(spec.Args) < 3 || spec.Args[0] != wtsetup.Subcommand || spec.Args[1] != "--" || spec.Args[2] != "claude" {
		t.Fatalf("not wrapped: %s %q", spec.Command, spec.Args)
	}
	if !envHas(spec.Env, wtsetup.EnvCommand+"=npm install") {
		t.Fatalf("setup command not passed: %q", spec.Env)
	}
	var note string
	for _, kv := range spec.Env {
		if strings.HasPrefix(kv, wtsetup.EnvNote+"=") {
			note = kv
		}
	}
	if !strings.Contains(note, "copied 1 file from .worktreeinclude (.env)") {
		t.Fatalf("note = %q", note)
	}
	// The agent's own command is still what the session records.
	if !strings.HasPrefix(a.Command, "claude ") {
		t.Fatalf("recorded command = %q", a.Command)
	}
	// The wrapper's marker ends the setup phase.
	if a.setupDone == nil {
		t.Fatal("no setup phase on a wrapped session")
	}
	f.session.out <- []byte("added 120 packages\r\n" + wtsetup.Marker)
	select {
	case <-a.setupDone:
	case <-time.After(3 * time.Second):
		t.Fatal("the marker did not end the setup phase")
	}
}

func TestSpawnInAnExistingWorktreeRunsNoSetup(t *testing.T) {
	trustTestHome(t)
	repo := setupRepo(t)
	m, _, f := newMgr(t)
	defer m.Shutdown()
	m.ProjectSetup = func(string) string { return "npm install" }
	m.SetupExe = "/opt/caprock/caprock"
	if _, err := createWorktree(context.Background(), repo, "w2", "", false); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Spawn(context.Background(), SpawnRequest{Cwd: repo, Worktree: "w2"}); err != nil {
		t.Fatal(err)
	}
	if f.lastSpec.Command == m.SetupExe {
		t.Fatal("setup ran again in a worktree that already existed")
	}
	if _, err := os.Stat(filepath.Join(repo, WorktreeDir, "w2", ".env")); err == nil {
		t.Fatal("copied into a worktree that already existed")
	}
}

func TestSpawnWithoutASetupCommandStartsTheAgentDirectly(t *testing.T) {
	trustTestHome(t)
	repo := setupRepo(t)
	m, _, f := newMgr(t)
	defer m.Shutdown()
	m.SetupExe = "/opt/caprock/caprock"
	a, err := m.Spawn(context.Background(), SpawnRequest{Cwd: repo, Worktree: "w3"})
	if err != nil {
		t.Fatal(err)
	}
	if f.lastSpec.Command == m.SetupExe || a.setupDone != nil {
		t.Fatal("wrapped with no setup command")
	}
	// .worktreeinclude still applies.
	if _, err := os.Stat(filepath.Join(repo, WorktreeDir, "w3", ".env")); err != nil {
		t.Fatalf(".env not copied: %v", err)
	}
}

func TestSpawnWithoutTheBinarySkipsSetup(t *testing.T) {
	trustTestHome(t)
	repo := setupRepo(t)
	m, _, f := newMgr(t)
	defer m.Shutdown()
	m.ProjectSetup = func(string) string { return "npm install" }
	if _, err := m.Spawn(context.Background(), SpawnRequest{Cwd: repo, Worktree: "w4"}); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.Join(f.lastSpec.Args, " "), wtsetup.Subcommand) {
		t.Fatal("wrapped without a binary to run the wrapper from")
	}
}

func TestAddWorktreeCopiesIncludedFiles(t *testing.T) {
	repo := setupRepo(t)
	w, err := AddWorktree(context.Background(), repo, WorktreeSpec{Branch: "feat/x", Create: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(w.Path, ".env")); err != nil {
		t.Fatalf(".env not copied: %v", err)
	}
	if !strings.Contains(w.Copied, "copied 1 file") {
		t.Fatalf("copied = %q", w.Copied)
	}
}
