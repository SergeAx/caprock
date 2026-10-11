package github

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/projects"
)

func issue(n int, title string, pr bool) map[string]any {
	m := map[string]any{"number": n, "title": title, "html_url": fmt.Sprintf("https://github.com/ada/caprock/issues/%d", n),
		"state": "open", "body": "Steps:\n1. open it\n", "user": map[string]any{"login": "grace"},
		"labels": []any{map[string]any{"name": "bug", "color": "d73a4a"}}, "comments": 2, "updated_at": "2026-10-10T10:00:00Z"}
	if pr {
		m["pull_request"] = map[string]any{"url": "x"}
		m["draft"] = true
	}
	return m
}

// The picker's list: open issues and pull requests, read once and kept for
// a minute; nothing is asked while not connected.
func TestItemsListsOpenIssuesAndPullRequests(t *testing.T) {
	x := newFixture(t)
	x.f.issues = []map[string]any{issue(12, "Login fails", false), issue(13, "Fix the login", true)}
	ctx := context.Background()

	got, err := x.s.Items(ctx, 1, "")
	if err != nil || got.Connected || got.Repo == nil || got.Repo.FullName != "ada/caprock" || len(got.Items) != 0 {
		t.Fatalf("not connected: %+v %v", got, err)
	}
	if len(x.f.requests()) != 0 {
		t.Fatal("asked GitHub while not connected")
	}

	x.connect(t)
	before := len(x.f.requests())
	got, err = x.s.Items(ctx, 1, "")
	if err != nil || !got.Connected || len(got.Items) != 2 {
		t.Fatalf("%+v %v", got, err)
	}
	is, pr := got.Items[0], got.Items[1]
	if is.Number != 12 || is.PR || is.Author != "grace" || len(is.Labels) != 1 || is.Labels[0].Name != "bug" || is.Body == "" || is.Comments != 2 {
		t.Fatalf("issue %+v", is)
	}
	if !pr.PR || !pr.Draft {
		t.Fatalf("pull request %+v", pr)
	}
	reqs := x.f.requests()[before:]
	if len(reqs) != 1 || !strings.Contains(reqs[0], "/repos/ada/caprock/issues?") || !strings.Contains(reqs[0], "state=open") {
		t.Fatalf("requests %v", reqs)
	}

	// Kept for a minute: reopening the picker asks nothing.
	if _, err := x.s.Items(ctx, 1, ""); err != nil {
		t.Fatal(err)
	}
	if n := len(x.f.requests()) - before; n != 1 {
		t.Fatalf("%d requests within the minute", n)
	}
	x.advance(itemsTTL + time.Second)
	if _, err := x.s.Items(ctx, 1, ""); err != nil {
		t.Fatal(err)
	}
	if n := len(x.f.requests()) - before; n != 2 {
		t.Fatalf("%d requests after the minute", n)
	}
}

// A number is read directly; words go to GitHub's search in this repository.
func TestItemsSearch(t *testing.T) {
	x := newFixture(t)
	x.f.issues = []map[string]any{issue(12, "Login fails", false), issue(13, "Fix the login", true)}
	x.connect(t)
	ctx := context.Background()

	got, err := x.s.Items(ctx, 1, "#13")
	if err != nil || len(got.Items) != 1 || got.Items[0].Number != 13 {
		t.Fatalf("%+v %v", got, err)
	}
	if got, err := x.s.Items(ctx, 1, "99"); err != nil || len(got.Items) != 0 {
		t.Fatalf("a missing number: %+v %v", got, err)
	}
	got, err = x.s.Items(ctx, 1, "login")
	if err != nil || !got.Search || !got.More || len(got.Items) != 1 {
		t.Fatalf("%+v %v", got, err)
	}
	last := x.f.requests()[len(x.f.requests())-1]
	if !strings.Contains(last, "/search/issues?") || !strings.Contains(last, "repo%3Aada%2Fcaprock") || !strings.Contains(last, "is%3Aopen") {
		t.Fatalf("search %s", last)
	}
	if _, err := x.s.Items(ctx, 1, strings.Repeat("a", 201)); err == nil {
		t.Fatal("an overlong search went out")
	}
}

// A project whose remote is not on GitHub says so and asks nothing.
func TestItemsNotGitHub(t *testing.T) {
	x := newFixture(t)
	x.connect(t)
	before := len(x.f.requests())
	x.wt.changes[""] = projects.Changes{Branch: "main", Remote: "origin", RemoteURL: "https://gitlab.com/a/b.git"}
	got, err := x.s.Items(context.Background(), 1, "")
	if err != nil || got.Reason != "not_github" || got.Repo != nil {
		t.Fatalf("%+v %v", got, err)
	}
	x.wt.changes[""] = projects.Changes{Branch: "main"}
	if got, _ := x.s.Items(context.Background(), 1, ""); got.Reason != "no_remote" {
		t.Fatalf("%+v", got)
	}
	if len(x.f.requests()) != before {
		t.Fatal("asked GitHub about a repository not on it")
	}
}
