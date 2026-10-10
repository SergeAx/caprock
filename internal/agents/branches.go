package agents

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Branch is one branch a new copy can start from: local, on a remote, or both,
// listed under its short name ("main", not "origin/main").
type Branch struct {
	Name string `json:"name"`
	// Main marks the branches people start from: the remote's default branch,
	// main, master, develop, dev, trunk. They are listed first.
	Main bool `json:"main,omitempty"`
	// Default is the remote's default branch (origin/HEAD), else main or master.
	Default bool `json:"default,omitempty"`
	Local   bool `json:"local,omitempty"`
	// Remote is the remote that has it ("origin"), empty for a local-only branch.
	Remote string `json:"remote,omitempty"`
	// CommittedMs is the newest commit on it, local or remote, for ordering.
	CommittedMs int64 `json:"committed_ms"`
}

var mainNames = map[string]int{"main": 0, "master": 1, "develop": 2, "dev": 3, "trunk": 4}

// ListBranches lists repo's branches for the New copy picker: main branches
// first (the default one at the top), then the rest by their newest commit.
// Caprock's own worker branches (caprock/…) are left out: nobody starts from
// another agent's scratch branch by choice, and they crowded the list.
func ListBranches(ctx context.Context, repo string) ([]Branch, error) {
	out, err := gitOut(ctx, repo, "for-each-ref", "--format=%(refname)%09%(committerdate:unix)", "refs/heads", "refs/remotes")
	if err != nil {
		return nil, errors.New("not a git repository")
	}
	def := defaultBranch(ctx, repo)
	byName := map[string]*Branch{}
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		ref, when, ok := strings.Cut(line, "\t")
		if !ok {
			continue
		}
		ts, _ := strconv.ParseInt(when, 10, 64)
		var name, remote string
		switch {
		case strings.HasPrefix(ref, "refs/heads/"):
			name = strings.TrimPrefix(ref, "refs/heads/")
		case strings.HasPrefix(ref, "refs/remotes/"):
			rest := strings.TrimPrefix(ref, "refs/remotes/")
			r, n, ok := strings.Cut(rest, "/")
			if !ok || n == "HEAD" {
				continue
			}
			name, remote = n, r
		default:
			continue
		}
		if strings.HasPrefix(name, "caprock/") {
			continue
		}
		b := byName[name]
		if b == nil {
			b = &Branch{Name: name}
			byName[name] = b
		}
		if remote == "" {
			b.Local = true
		} else if b.Remote == "" || remote == "origin" {
			b.Remote = remote
		}
		if ms := ts * 1000; ms > b.CommittedMs {
			b.CommittedMs = ms
		}
	}
	if def == "" {
		for _, n := range []string{"main", "master"} {
			if byName[n] != nil {
				def = n
				break
			}
		}
	}
	list := make([]Branch, 0, len(byName))
	for _, b := range byName {
		_, b.Main = mainNames[b.Name]
		if b.Name == def {
			b.Main, b.Default = true, true
		}
		list = append(list, *b)
	}
	sort.SliceStable(list, func(i, j int) bool {
		a, b := list[i], list[j]
		if a.Default != b.Default {
			return a.Default
		}
		if a.Main != b.Main {
			return a.Main
		}
		if a.Main {
			return mainNames[a.Name] < mainNames[b.Name]
		}
		return a.CommittedMs > b.CommittedMs
	})
	return list, nil
}

// defaultBranch is origin's default branch (refs/remotes/origin/HEAD), empty
// when the remote's HEAD was never recorded.
func defaultBranch(ctx context.Context, repo string) string {
	out, err := gitOut(ctx, repo, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD")
	if err != nil {
		return ""
	}
	_, name, _ := strings.Cut(strings.TrimSpace(out), "/")
	return name
}

// startPoint is what a new copy from base starts at. With pull, the remote
// that has base is fetched first and its tip used, so the copy starts from
// what is on the server now rather than from a stale local branch.
func startPoint(ctx context.Context, repo, base string, pull bool) (string, error) {
	if base == "" {
		return "", nil
	}
	if strings.HasPrefix(base, "-") || strings.ContainsAny(base, " \t\n~^:?*[\\") {
		return "", fmt.Errorf("agents: %q is not a branch name", base)
	}
	remote := ""
	if out, err := gitOut(ctx, repo, "for-each-ref", "--format=%(refname)", "refs/remotes/*/"+base); err == nil {
		for _, ref := range strings.Fields(out) {
			r := strings.TrimSuffix(strings.TrimPrefix(ref, "refs/remotes/"), "/"+base)
			if remote == "" || r == "origin" {
				remote = r
			}
		}
	}
	if pull && remote != "" {
		fctx, cancel := context.WithTimeout(ctx, 60*time.Second)
		defer cancel()
		if _, err := gitOut(fctx, repo, "fetch", "--quiet", remote, "refs/heads/"+base+":refs/remotes/"+remote+"/"+base); err != nil {
			return "", fmt.Errorf("agents: could not pull %s from %s: %v", base, remote, err)
		}
	}
	point := base
	if remote != "" && (pull || !branchExists(ctx, repo, base)) {
		point = remote + "/" + base
	}
	if _, err := gitOut(ctx, repo, "rev-parse", "--verify", "--quiet", point+"^{commit}"); err != nil {
		return "", fmt.Errorf("agents: no branch %s here", base)
	}
	return point, nil
}
