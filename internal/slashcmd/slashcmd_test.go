package slashcmd

import (
	"os"
	"path/filepath"
	"testing"
)

func write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func byName(cs []Command) map[string]Command {
	m := map[string]Command{}
	for _, c := range cs {
		m[c.Name] = c
	}
	return m
}

func TestClaudeCommandsFromProjectRootUserAndSkills(t *testing.T) {
	repo := t.TempDir()
	home := t.TempDir()
	sub := filepath.Join(repo, "svc", "api")
	if err := os.MkdirAll(filepath.Join(repo, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(repo, ".claude", "commands", "ship.md"), "---\ndescription: \"Ship it\"\nargument-hint: [version]\n---\nBody\n")
	write(t, filepath.Join(repo, ".claude", "commands", "frontend", "component.md"), "# Make a component\n\nText")
	write(t, filepath.Join(sub, ".claude", "commands", "local.md"), "Run the local thing")
	write(t, filepath.Join(repo, ".claude", "skills", "pdf-tools", "SKILL.md"), "---\nname: pdf\ndescription: Work with PDFs\n---\n")
	write(t, filepath.Join(home, ".claude", "commands", "ship.md"), "the user's ship, shadowed")
	write(t, filepath.Join(home, ".claude", "commands", "mine.md"), "---\ndescription: Mine\n---\n")
	write(t, filepath.Join(home, ".claude", "skills", "notes", "SKILL.md"), "# Notes skill")
	write(t, filepath.Join(home, ".claude", "commands", "has space.md"), "skipped")
	write(t, filepath.Join(home, ".claude", "commands", "readme.txt"), "not a command")

	got := List("claude", sub, home)
	m := byName(got)
	if got[0].Source != SourceBuiltin || m["compact"].Source != SourceBuiltin {
		t.Fatalf("built-ins first: %+v", got[0])
	}
	want := map[string]Command{
		"ship":      {Name: "ship", Description: "Ship it", Hint: "[version]", Source: SourceProject},
		"component": {Name: "component", Description: "Make a component", Source: SourceProject},
		"local":     {Name: "local", Description: "Run the local thing", Source: SourceProject},
		"pdf":       {Name: "pdf", Description: "Work with PDFs", Source: SourceProjectSkill},
		"mine":      {Name: "mine", Description: "Mine", Source: SourceUser},
		"notes":     {Name: "notes", Description: "Notes skill", Source: SourceUserSkill},
	}
	for name, w := range want {
		if m[name] != w {
			t.Errorf("%s = %+v, want %+v", name, m[name], w)
		}
	}
	if _, ok := m["has space"]; ok {
		t.Error("a name with a space was listed")
	}
	if _, ok := m["readme"]; ok {
		t.Error("a .txt was listed")
	}
	seen := map[string]bool{}
	for _, c := range got {
		if seen[c.Name] {
			t.Errorf("%s listed twice", c.Name)
		}
		seen[c.Name] = true
	}
}

func TestCodexPromptsAndOtherAgents(t *testing.T) {
	home := t.TempDir()
	write(t, filepath.Join(home, ".codex", "prompts", "fix.md"), "---\ndescription: Fix the build\n---\n")
	m := byName(List("codex", t.TempDir(), home))
	if m["prompts:fix"].Description != "Fix the build" || m["model"].Source != SourceBuiltin {
		t.Fatalf("codex: %+v", m)
	}
	if l := List("opencode", t.TempDir(), home); len(l) != 0 {
		t.Fatalf("opencode got %d commands", len(l))
	}
}

func TestDescribeClips(t *testing.T) {
	long := ""
	for i := 0; i < 50; i++ {
		long += "word "
	}
	if d := describe(long, ""); len([]rune(d)) != descMax {
		t.Fatalf("len %d", len([]rune(d)))
	}
	if d := describe(">", "from the body"); d != "from the body" {
		t.Fatalf("%q", d)
	}
}
