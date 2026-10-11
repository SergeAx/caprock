package gitdiff

import (
	"bytes"
	"context"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Totals is how much a working tree changed since a commit: files and lines,
// committed or not, untracked files included.
type Totals struct {
	Files     int `json:"files"`
	Additions int `json:"additions"`
	Deletions int `json:"deletions"`
	// Binary counts the changed files with no line counts.
	Binary int `json:"binary,omitempty"`
}

// untrackedCap bounds the untracked files read for their line counts, and
// untrackedBytes each one: a figure for a comparison, not a full diff.
const (
	untrackedCap   = 2000
	untrackedBytes = 1 << 20
)

// Since totals what the working tree at cwd changed since base — a commit, a
// branch, anything git resolves — counting commits made since, uncommitted
// edits and untracked files that git does not ignore. It never modifies the
// repository. With base empty it is measured as Diff measures (the trunk's
// fork point, else HEAD).
func Since(ctx context.Context, cwd, base string) (Totals, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	top, err := git(ctx, cwd, "rev-parse", "--show-toplevel")
	if err != nil {
		return Totals{}, ErrNotARepo
	}
	root := strings.TrimSpace(top)
	if base == "" {
		if _, err := git(ctx, root, "rev-parse", "--verify", "HEAD"); err == nil {
			base = "HEAD"
			if b, err := git(ctx, root, "rev-parse", "--abbrev-ref", "HEAD"); err == nil {
				if mb, _ := mergeBase(ctx, root, strings.TrimSpace(b)); mb != "" {
					base = mb
				}
			}
		}
	}
	var t Totals
	args := []string{"diff", "--numstat", "-M"}
	if base != "" {
		args = append(args, base)
	}
	numstat, err := git(ctx, root, args...)
	if err != nil {
		return Totals{}, err
	}
	for _, line := range strings.Split(strings.TrimSpace(numstat), "\n") {
		parts := strings.SplitN(line, "\t", 3)
		if len(parts) != 3 {
			continue
		}
		t.Files++
		if parts[0] == "-" {
			t.Binary++
			continue
		}
		a, _ := strconv.Atoi(parts[0])
		d, _ := strconv.Atoi(parts[1])
		t.Additions += a
		t.Deletions += d
	}
	if out, err := git(ctx, root, "ls-files", "--others", "--exclude-standard", "-z"); err == nil {
		read := 0
		for _, p := range strings.Split(out, "\x00") {
			if p == "" {
				continue
			}
			t.Files++
			if read >= untrackedCap {
				continue
			}
			read++
			n, binary := countLines(filepath.Join(root, filepath.FromSlash(p)))
			if binary {
				t.Binary++
			}
			t.Additions += n
		}
	}
	return t, nil
}

// countLines counts the lines of a file's first untrackedBytes, as git would
// for a new file; a NUL byte makes it binary, with no lines.
func countLines(path string) (int, bool) {
	f, err := os.Open(path)
	if err != nil {
		return 0, false
	}
	defer f.Close()
	if fi, err := f.Stat(); err != nil || !fi.Mode().IsRegular() {
		return 0, false
	}
	buf := make([]byte, untrackedBytes)
	n, _ := io.ReadFull(f, buf)
	b := buf[:n]
	if bytes.IndexByte(b, 0) >= 0 {
		return 0, true
	}
	lines := bytes.Count(b, []byte{'\n'})
	if n > 0 && b[n-1] != '\n' {
		lines++
	}
	return lines, false
}

// Head is the commit HEAD names in the repository holding cwd, or "" when
// there is none (not a repository, an unborn branch).
func Head(ctx context.Context, cwd string) string {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	out, err := git(ctx, cwd, "rev-parse", "--verify", "HEAD")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(out)
}
