package projects

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/agents"
)

func TestParsePorcelain(t *testing.T) {
	out := "worktree C:/src/app\nHEAD 1111\nbranch refs/heads/main\n\n" +
		"worktree C:/src/app/.caprock-worktrees/feat-x\nHEAD 2222\nbranch refs/heads/feat/x\nlocked because\n\n" +
		"worktree /gone\nHEAD 3333\ndetached\nprunable gitdir file points to non-existent location\n\n"
	got := parsePorcelain(strings.ReplaceAll(out, "\n", "\r\n"))
	if len(got) != 3 {
		t.Fatalf("got %d entries: %+v", len(got), got)
	}
	if got[0].Branch != "main" || got[0].Head != "1111" || got[0].Path != filepath.Clean(filepath.FromSlash("C:/src/app")) {
		t.Errorf("main: %+v", got[0])
	}
	if got[1].Branch != "feat/x" || !got[1].Locked {
		t.Errorf("copy: %+v", got[1])
	}
	if !got[2].Detached || !got[2].Prunable || got[2].Branch != "" {
		t.Errorf("gone: %+v", got[2])
	}
}

// copiesFixture is a repository with a remote and copies in every state the
// view tells apart.
type copiesFixture struct {
	s        *Service
	id       int64
	repo     string
	clean    string // Caprock's, merged, nothing to lose
	dirty    string // Caprock's, an untracked file
	ahead    string // Caprock's, a commit no remote has, not merged
	pushed   string // Caprock's, a commit pushed but not merged
	handMade string // made by hand, outside the repository
}

func newCopiesFixture(t *testing.T) copiesFixture {
	t.Helper()
	needGit(t)
	base := t.TempDir()
	remote := filepath.Join(base, "remote.git")
	if err := os.MkdirAll(remote, 0o755); err != nil {
		t.Fatal(err)
	}
	git(t, remote, "init", "-q", "--bare")
	repo := newRepo(t, filepath.Join(base, "repo"))
	git(t, repo, "remote", "add", "origin", remote)
	git(t, repo, "push", "-q", "origin", "main")
	hand := filepath.Join(base, "hand")
	git(t, repo, "worktree", "add", "-q", "-b", "hand", hand)
	s, _, _ := newService(t)
	start(t, s)
	ctx := context.Background()
	v, _, err := s.Add(ctx, repo)
	if err != nil {
		t.Fatal(err)
	}
	mk := func(branch string) string {
		wt, err := s.AddWorktree(ctx, v.ID, agents.WorktreeSpec{Branch: branch, Create: true})
		if err != nil {
			t.Fatal(err)
		}
		return wt.Path
	}
	f := copiesFixture{s: s, id: v.ID, repo: repo, clean: mk("clean"), dirty: mk("dirty"), ahead: mk("ahead"), pushed: mk("pushed"), handMade: hand}
	write(t, filepath.Join(f.dirty, "scratch.txt"), "unsaved\n")
	write(t, filepath.Join(f.ahead, "a.txt"), "a\n")
	git(t, f.ahead, "add", "a.txt")
	git(t, f.ahead, "commit", "-q", "-m", "ahead")
	write(t, filepath.Join(f.pushed, "p.txt"), "p\n")
	git(t, f.pushed, "add", "p.txt")
	git(t, f.pushed, "commit", "-q", "-m", "pushed")
	git(t, f.pushed, "push", "-q", "origin", "pushed")
	return f
}

func copyAt(t *testing.T, v CopiesView, path string) Copy {
	t.Helper()
	for _, c := range v.Copies {
		if sameFolder(c.Path, path) {
			return c
		}
	}
	t.Fatalf("no copy at %s in %+v", path, v.Copies)
	return Copy{}
}

func TestCopiesListsEveryWorktreeWithItsState(t *testing.T) {
	f := newCopiesFixture(t)
	ctx := context.Background()
	busy := func(dir string, _ []string) []string {
		if sameFolder(dir, f.pushed) {
			return []string{"a shell tab"}
		}
		return nil
	}
	v, err := f.s.Copies(ctx, f.id, busy)
	if err != nil {
		t.Fatal(err)
	}
	if len(v.Copies) != 6 || !v.Copies[0].Main || !sameFolder(v.Copies[0].Path, f.repo) {
		t.Fatalf("want the main checkout first and 6 in all: %+v", v.Copies)
	}
	if v.DefaultBranch != "main" || !v.HasRemote {
		t.Fatalf("default %q, remote %v", v.DefaultBranch, v.HasRemote)
	}
	main := v.Copies[0]
	if main.Caprock || main.Merged || main.Size != nil {
		t.Errorf("main checkout: %+v", main)
	}
	clean := copyAt(t, v, f.clean)
	if !clean.Caprock || !clean.Merged || clean.Dirty || clean.Unpushed != 0 || clean.CommittedAt == 0 || clean.Name == "" {
		t.Errorf("clean: %+v", clean)
	}
	dirty := copyAt(t, v, f.dirty)
	if !dirty.Dirty || dirty.Changed != 1 {
		t.Errorf("dirty: %+v", dirty)
	}
	ahead := copyAt(t, v, f.ahead)
	if ahead.Merged || ahead.Unpushed != 1 {
		t.Errorf("ahead: %+v", ahead)
	}
	pushed := copyAt(t, v, f.pushed)
	if pushed.Merged || pushed.Unpushed != 0 || len(pushed.Live) != 1 {
		t.Errorf("pushed: %+v", pushed)
	}
	if hand := copyAt(t, v, f.handMade); hand.Caprock {
		t.Errorf("a hand-made worktree is marked Caprock's: %+v", hand)
	}

	// Sizes arrive from the background walk.
	deadline := time.Now().Add(10 * time.Second)
	for v.Pending && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
		if v, err = f.s.Copies(ctx, f.id, nil); err != nil {
			t.Fatal(err)
		}
	}
	if v.Pending {
		t.Fatal("sizes never arrived")
	}
	var sum int64
	for _, c := range v.Copies {
		if c.Main {
			continue
		}
		if c.Size == nil || *c.Size <= 0 {
			t.Fatalf("no size for %s", c.Path)
		}
		sum += *c.Size
	}
	if v.Total != sum {
		t.Errorf("total %d, sum %d", v.Total, sum)
	}
}

func TestRemoveCopiesKeepsWhatWouldBeLost(t *testing.T) {
	f := newCopiesFixture(t)
	ctx := context.Background()
	busy := func(dir string, _ []string) []string {
		if sameFolder(dir, f.pushed) {
			return []string{"the session \"fix\""}
		}
		return nil
	}
	res, err := f.s.RemoveCopies(ctx, f.id, []CopyRemoval{
		{Path: f.repo, Force: true},
		{Path: f.handMade, Force: true},
		{Path: f.pushed, Force: true},
		{Path: f.dirty},
		{Path: f.ahead},
		{Path: filepath.Join(f.repo, "nowhere")},
	}, true, busy)
	if err != nil {
		t.Fatal(err)
	}
	for i, r := range res {
		if r.Removed || r.Error == "" {
			t.Errorf("%d (%s) was removed or has no reason: %+v", i, r.Path, r)
		}
	}
	if !res[3].Confirm || !strings.Contains(res[3].Error, "1 uncommitted change") {
		t.Errorf("dirty: %+v", res[3])
	}
	if !res[4].Confirm || !strings.Contains(res[4].Error, "1 commit on no remote") {
		t.Errorf("ahead: %+v", res[4])
	}
	for _, p := range []string{f.repo, f.handMade, f.pushed, f.dirty, f.ahead} {
		if _, err := os.Stat(p); err != nil {
			t.Fatalf("%s is gone: %v", p, err)
		}
	}

	// Confirmed, the dirty and unpushed ones go; the merged one goes with
	// its branch, the unmerged one's branch stays.
	res, err = f.s.RemoveCopies(ctx, f.id, []CopyRemoval{
		{Path: f.clean},
		{Path: f.dirty, Force: true},
		{Path: f.ahead, Force: true},
	}, true, busy)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range res {
		if !r.Removed || r.Error != "" {
			t.Fatalf("not removed: %+v", r)
		}
		if _, err := os.Stat(r.Path); !os.IsNotExist(err) {
			t.Fatalf("%s is still there", r.Path)
		}
	}
	if res[0].BranchDeleted != "clean" || res[2].BranchDeleted != "" {
		t.Errorf("branches: %+v", res)
	}
	if branchList := git(t, f.repo, "branch", "--list", "clean"); branchList != "" {
		t.Errorf("the merged branch is still there: %q", branchList)
	}
	git(t, f.repo, "rev-parse", "--verify", "ahead") // an unmerged branch stays
}

func TestRemoveCopiesTakesAMissingFolder(t *testing.T) {
	f := newCopiesFixture(t)
	ctx := context.Background()
	if err := os.RemoveAll(f.clean); err != nil {
		t.Fatal(err)
	}
	v, err := f.s.Copies(ctx, f.id, nil)
	if err != nil {
		t.Fatal(err)
	}
	if c := copyAt(t, v, f.clean); !c.Missing || c.Size != nil {
		t.Fatalf("missing: %+v", c)
	}
	res, err := f.s.RemoveCopies(ctx, f.id, []CopyRemoval{{Path: f.clean}}, false, nil)
	if err != nil || !res[0].Removed {
		t.Fatalf("%+v %v", res, err)
	}
	if out := git(t, f.repo, "worktree", "list", "--porcelain"); strings.Contains(out, "/clean\n") {
		t.Fatalf("still listed:\n%s", out)
	}
}

func TestMeasureStopsAtItsLimit(t *testing.T) {
	dir := t.TempDir()
	for i := 0; i < 20; i++ {
		write(t, filepath.Join(dir, "d", strings.Repeat("x", i+1)), "0123456789")
	}
	s, _, _ := newService(t)
	s.init()
	if n, capped := s.measure(dir); capped || n != 200 {
		t.Fatalf("whole: %d capped=%v", n, capped)
	}
	old := sizeMaxFiles
	sizeMaxFiles = 5
	t.Cleanup(func() { sizeMaxFiles = old })
	if n, capped := s.measure(dir); !capped || n >= 200 {
		t.Fatalf("capped: %d capped=%v", n, capped)
	}
}
