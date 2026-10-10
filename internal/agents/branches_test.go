package agents

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// A clone of an upstream that moved on: the copy must start from what the
// upstream has now, not from the clone's stale main.
func TestNewCopyFromBranchPullsFirst(t *testing.T) {
	up, upRun := gitRepo(t)
	upRun("checkout", "-q", "-b", "develop")
	upRun("checkout", "-q", "main")
	clone := filepath.Join(t.TempDir(), "clone")
	upRun("clone", "-q", up, clone)
	// The upstream gains a commit the clone has not seen.
	if err := os.WriteFile(filepath.Join(up, "g"), []byte("y"), 0o600); err != nil {
		t.Fatal(err)
	}
	upRun("add", "g")
	upRun("commit", "-q", "-m", "newer")
	tip := upRun("rev-parse", "HEAD")

	ctx := context.Background()
	stale, err := createWorktree(ctx, clone, "no-pull", "main", false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(stale, "g")); err == nil {
		t.Fatal("without pull the copy should start from the clone's own main")
	}
	fresh, err := createWorktree(ctx, clone, "pulled", "main", true)
	if err != nil {
		t.Fatal(err)
	}
	head, err := gitOut(ctx, fresh, "rev-parse", "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	if got := head[:len(tip)]; got != tip {
		t.Fatalf("pulled copy at %s, upstream main at %s", got, tip)
	}
	// It does not track main: pushing it must never go to main.
	if up, _ := gitOut(ctx, fresh, "rev-parse", "--abbrev-ref", "@{upstream}"); up != "" {
		t.Fatalf("new branch tracks %q", up)
	}
}

func TestListBranchesPutsMainFirstAndHidesWorkers(t *testing.T) {
	dir, run := gitRepo(t)
	run("branch", "feat/x")
	run("branch", "develop")
	run("branch", "caprock/worker-1")
	list, err := ListBranches(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, b := range list {
		names = append(names, b.Name)
	}
	if len(names) != 3 || names[0] != "main" || names[1] != "develop" || names[2] != "feat/x" {
		t.Fatalf("order %v", names)
	}
	if !list[0].Default || !list[0].Main || list[2].Main {
		t.Fatalf("flags %+v", list)
	}
}

func TestStartPointRefusesOptionsAndUnknownBranches(t *testing.T) {
	dir, _ := gitRepo(t)
	for _, bad := range []string{"--upload-pack=x", "nope", "a b"} {
		if _, err := startPoint(context.Background(), dir, bad, false); err == nil {
			t.Fatalf("%q accepted", bad)
		}
	}
}
