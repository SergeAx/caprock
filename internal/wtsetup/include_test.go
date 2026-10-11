package wtsetup

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func git(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL="+os.DevNull, "GIT_CONFIG_NOSYSTEM=1",
		"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.com", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.com")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// repoWithWorktree makes a repository with ignored files, and a fresh
// worktree of it, and returns both.
func repoWithWorktree(t *testing.T, include string) (string, string) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	root := t.TempDir()
	repo := filepath.Join(root, "repo")
	if err := os.Mkdir(repo, 0o755); err != nil {
		t.Fatal(err)
	}
	git(t, repo, "init", "-q")
	write(t, filepath.Join(repo, ".gitignore"), ".env\n.env.local\nnode_modules/\nconfig/secrets.json\nscratch.txt\n")
	write(t, filepath.Join(repo, "README.md"), "hello\n")
	write(t, filepath.Join(repo, "config", "app.json"), "{}\n")
	git(t, repo, "add", ".")
	git(t, repo, "commit", "-q", "-m", "init")
	// Ignored files in the main checkout.
	write(t, filepath.Join(repo, ".env"), "SECRET=1\n")
	write(t, filepath.Join(repo, ".env.local"), "LOCAL=1\n")
	write(t, filepath.Join(repo, "config", "secrets.json"), `{"k":1}`)
	write(t, filepath.Join(repo, "node_modules", "dep", "index.js"), "x\n")
	write(t, filepath.Join(repo, "scratch.txt"), "ignored but not listed\n")
	// Untracked and NOT ignored: work in progress, never copied.
	write(t, filepath.Join(repo, "draft.env"), "wip\n")
	if include != "" {
		write(t, filepath.Join(repo, IncludeFile), include)
	}
	wt := filepath.Join(root, "wt")
	git(t, repo, "worktree", "add", "-q", "-b", "copy", wt)
	return repo, wt
}

func exists(path string) bool { _, err := os.Lstat(path); return err == nil }

func TestCopyIncludedCopiesIgnoredMatchesOnly(t *testing.T) {
	repo, wt := repoWithWorktree(t, ".env*\nconfig/secrets.json\n*.env\n")
	got, err := CopyIncluded(context.Background(), repo, wt)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{".env", ".env.local", filepath.Join("config", "secrets.json")} {
		if !exists(filepath.Join(wt, f)) {
			t.Errorf("%s was not copied", f)
		}
	}
	for _, f := range []string{"draft.env", "scratch.txt", filepath.Join("node_modules", "dep", "index.js")} {
		if exists(filepath.Join(wt, f)) {
			t.Errorf("%s was copied; it is not both listed and ignored", f)
		}
	}
	if got.Files != 3 || got.Bytes == 0 || got.OverLimit {
		t.Fatalf("result = %+v", got)
	}
	b, _ := os.ReadFile(filepath.Join(wt, ".env"))
	if string(b) != "SECRET=1\n" {
		t.Fatalf(".env = %q", b)
	}
	if !strings.Contains(got.Summary(), "copied 3 files from .worktreeinclude") {
		t.Fatalf("summary = %q", got.Summary())
	}
}

func TestCopyIncludedWithoutTheFileDoesNothing(t *testing.T) {
	repo, wt := repoWithWorktree(t, "")
	got, err := CopyIncluded(context.Background(), repo, wt)
	if err != nil || got.Files != 0 || got.Summary() != "" {
		t.Fatalf("got %+v, %v", got, err)
	}
	if exists(filepath.Join(wt, ".env")) {
		t.Fatal("copied without a .worktreeinclude")
	}
}

func TestCopyIncludedNeverOverwrites(t *testing.T) {
	repo, wt := repoWithWorktree(t, ".env\n")
	write(t, filepath.Join(wt, ".env"), "MINE=1\n")
	got, err := CopyIncluded(context.Background(), repo, wt)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(filepath.Join(wt, ".env"))
	if string(b) != "MINE=1\n" || got.Files != 0 || got.Skipped != 1 {
		t.Fatalf("overwrote or miscounted: %q %+v", b, got)
	}
}

func TestCopyIncludedSkipsSymlinksThatEscape(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need a privilege on Windows")
	}
	repo, wt := repoWithWorktree(t, ".env\n.env.local\n")
	outside := filepath.Join(t.TempDir(), "elsewhere")
	write(t, outside, "not yours\n")
	if err := os.Remove(filepath.Join(repo, ".env")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(repo, ".env")); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(repo, ".env.local")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("README.md", filepath.Join(repo, ".env.local")); err != nil {
		t.Fatal(err)
	}
	got, err := CopyIncluded(context.Background(), repo, wt)
	if err != nil {
		t.Fatal(err)
	}
	if exists(filepath.Join(wt, ".env")) {
		t.Fatal("a symlink pointing outside the repository was copied")
	}
	if link, err := os.Readlink(filepath.Join(wt, ".env.local")); err != nil || link != "README.md" {
		t.Fatalf("a relative in-repo symlink should be recreated: %q %v", link, err)
	}
	if got.Files != 1 || got.Skipped != 1 {
		t.Fatalf("result = %+v", got)
	}
}

func TestCopyIncludedStaysInsideAWorktreeWithAnEscapingDir(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need a privilege on Windows")
	}
	repo, wt := repoWithWorktree(t, "config/secrets.json\n")
	// The worktree's config/ is replaced by a link to somewhere else: a copy
	// into it would land outside the worktree.
	outside := t.TempDir()
	if err := os.RemoveAll(filepath.Join(wt, "config")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(wt, "config")); err != nil {
		t.Fatal(err)
	}
	got, err := CopyIncluded(context.Background(), repo, wt)
	if err != nil {
		t.Fatal(err)
	}
	if exists(filepath.Join(outside, "secrets.json")) {
		t.Fatal("wrote outside the worktree through a symlinked directory")
	}
	if got.Files != 0 || got.Skipped != 1 {
		t.Fatalf("result = %+v", got)
	}
}

func TestCopyIncludedStopsAtTheLimit(t *testing.T) {
	repo, wt := repoWithWorktree(t, "node_modules/\n")
	big := strings.Repeat("x", 1<<20)
	for i := 0; i < 3; i++ {
		write(t, filepath.Join(repo, "node_modules", "big", string(rune('a'+i))), big)
	}
	old := maxBytes
	maxBytes = 2<<20 + 10
	defer func() { maxBytes = old }()
	got, err := CopyIncluded(context.Background(), repo, wt)
	if err != nil {
		t.Fatal(err)
	}
	if !got.OverLimit || got.Bytes > maxBytes {
		t.Fatalf("limit not applied: %+v", got)
	}
}
