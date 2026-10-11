package gitdiff

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// Since counts what an attempt's copy changed since the commit it started
// from: its commits, its uncommitted edits and its new files, and nothing git
// ignores.
func TestSinceCountsCommittedUncommittedAndNew(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	ctx := context.Background()
	dir := t.TempDir()
	if _, err := Since(ctx, dir, ""); !errors.Is(err, ErrNotARepo) {
		t.Fatalf("non-repo: %v", err)
	}
	if Head(ctx, dir) != "" {
		t.Fatal("a folder that is not a repository has a HEAD")
	}
	run(t, dir, "init", "-q", "-b", "main")
	write := func(name, body string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("a.txt", "one\ntwo\nthree\n")
	write(".gitignore", "secret.env\n")
	run(t, dir, "add", ".")
	run(t, dir, "commit", "-q", "-m", "init")
	base := Head(ctx, dir)
	if len(base) < 40 {
		t.Fatalf("HEAD: %q", base)
	}

	// A commit after the base: two changed lines in a.txt.
	write("a.txt", "one\nTWO\nthree\n")
	run(t, dir, "commit", "-q", "-am", "edit")
	// Uncommitted: one more line in a.txt.
	write("a.txt", "one\nTWO\nthree\nfour\n")
	// New, not ignored: two lines, the last without a newline.
	write("new.go", "package x\nfunc f() {}")
	// Ignored: never counted.
	write("secret.env", "KEY=1\nKEY=2\n")
	// Binary and new: a file, no lines.
	write("blob.bin", "a\x00b")

	got, err := Since(ctx, dir, base)
	if err != nil {
		t.Fatal(err)
	}
	want := Totals{Files: 3, Additions: 2 + 2, Deletions: 1, Binary: 1}
	if got != want {
		t.Fatalf("since base: %+v, want %+v", got, want)
	}

	// Against HEAD the commit is not counted.
	got, err = Since(ctx, dir, "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	if want := (Totals{Files: 3, Additions: 1 + 2, Binary: 1}); got != want {
		t.Fatalf("since HEAD: %+v, want %+v", got, want)
	}
}
