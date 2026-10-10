package api

import (
	"os"
	"path/filepath"
	"testing"
)

// The project search finds repositories one and two levels under the default
// folder, never inside a repository, a hidden folder or node_modules, and
// never outside the browse root.
func TestLocalReposScansTheDefaultFolder(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	mk := func(rel string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Join(root, filepath.FromSlash(rel)), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	mk("dev/caprock/.git")
	mk("dev/caprock-web/.git")
	mk("dev/caprock/vendor/inner/.git") // inside a repository: not a project
	mk("dev/work/api/.git")             // two levels down
	mk("dev/work/deep/er/x/.git")       // three: too deep
	mk("dev/.hidden/secret/.git")
	mk("dev/node_modules/pkg/.git")
	mk("dev/plain")
	mk("elsewhere/other/.git") // outside the default folder

	e := newEnv(t)
	e.setBrowseRoot(t, root)
	cur := e.settings.Get()
	cur.DefaultFolder = filepath.Join(root, "dev")
	if err := e.settings.Set(cur); err != nil {
		t.Fatal(err)
	}
	var got reposResponse
	if code := e.get(t, "/v1/browse/repos", &got); code != 200 {
		t.Fatalf("status %d", code)
	}
	want := []string{"caprock", "caprock-web", "api"}
	if len(got.Repos) != len(want) {
		t.Fatalf("repos = %+v, want %v", got.Repos, want)
	}
	names := map[string]string{}
	for _, r := range got.Repos {
		names[r.Name] = r.Path
	}
	for _, w := range want {
		if _, ok := names[w]; !ok {
			t.Errorf("%s not found in %+v", w, got.Repos)
		}
	}
	if names["api"] != filepath.Join(root, "dev", "work", "api") {
		t.Errorf("api path = %q", names["api"])
	}
	if got.Root != filepath.Join(root, "dev") {
		t.Errorf("root = %q", got.Root)
	}

	// A default folder outside the browse root is not scanned: the root is.
	cur.DefaultFolder = t.TempDir()
	if err := e.settings.Set(cur); err != nil {
		t.Fatal(err)
	}
	if code := e.get(t, "/v1/browse/repos", &got); code != 200 || got.Root != root {
		t.Fatalf("status %d root %q, want the browse root %q", code, got.Root, root)
	}
}

func TestScanReposKeepsToItsDepth(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "a", ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	repos, truncated := scanRepos(root, 0)
	if len(repos) != 0 || truncated {
		t.Errorf("depth 0 found %v (truncated %v)", repos, truncated)
	}
	repos, _ = scanRepos(root, 1)
	if len(repos) != 1 || repos[0].Name != "a" {
		t.Errorf("depth 1 found %v", repos)
	}
}
