// Package slashcmd lists the slash commands an agent offers in a folder, for
// the chat field's `/` picker (ADR-053; contract in 03-contracts.md § Chat
// field pickers).
//
// For Claude Code: a fixed list of its built-in commands, then the custom
// commands (`.claude/commands/**/*.md`) and skills (`.claude/skills/*/SKILL.md`)
// of the session's folder, of its repository's root when that is another
// folder, and of the user's `~/.claude`. For Codex: its built-ins and the
// user's prompts (`~/.codex/prompts/*.md`, typed as `/prompts:<name>`). Any
// other agent: none — a list that is not that agent's would type commands it
// does not have.
//
// Read-only and bounded: names and descriptions only, at most MaxFiles files
// read, at most headBytes of each.
package slashcmd

import (
	"bufio"
	"bytes"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Command is one entry of the picker.
type Command struct {
	// Name is what is typed, without the slash: "compact", "prompts:fix".
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	// Hint is the arguments it takes, from argument-hint, when it says.
	Hint string `json:"hint,omitempty"`
	// Source: "builtin", "project", "user", "project skill", "user skill".
	Source string `json:"source"`
}

// The sources, as the picker labels them.
const (
	SourceBuiltin      = "builtin"
	SourceProject      = "project"
	SourceUser         = "user"
	SourceProjectSkill = "project skill"
	SourceUserSkill    = "user skill"
)

// MaxFiles bounds how many command and skill files one listing reads.
const MaxFiles = 400

// headBytes is how much of each file is read for its front matter.
const headBytes = 4 << 10

// descMax clips a description.
const descMax = 160

// claudeBuiltins are Claude Code's own commands that do something useful
// when typed from a chat field. Commands that only make sense at the
// keyboard of the machine (/login, /logout, /exit, /terminal-setup, /ide)
// are left out.
var claudeBuiltins = []Command{
	{Name: "add-dir", Description: "Add a working directory", Hint: "<path>"},
	{Name: "agents", Description: "Manage subagents"},
	{Name: "clear", Description: "Clear the conversation and start fresh"},
	{Name: "compact", Description: "Compact the conversation, optionally with what to keep", Hint: "[instructions]"},
	{Name: "config", Description: "Open settings"},
	{Name: "context", Description: "Show what fills the context window"},
	{Name: "cost", Description: "Show this session's token usage"},
	{Name: "doctor", Description: "Check the installation"},
	{Name: "export", Description: "Export the conversation"},
	{Name: "help", Description: "Show help"},
	{Name: "hooks", Description: "Manage hooks"},
	{Name: "init", Description: "Write a CLAUDE.md for this project"},
	{Name: "mcp", Description: "Manage MCP servers"},
	{Name: "memory", Description: "Edit memory files"},
	{Name: "model", Description: "Choose the model", Hint: "[model]"},
	{Name: "permissions", Description: "View or change permission rules"},
	{Name: "pr-comments", Description: "Show a pull request's comments"},
	{Name: "resume", Description: "Resume a conversation"},
	{Name: "review", Description: "Review a pull request"},
	{Name: "rewind", Description: "Rewind the conversation or the code"},
	{Name: "status", Description: "Show version, model and account"},
	{Name: "todos", Description: "List the current todos"},
	{Name: "usage", Description: "Show plan usage limits"},
	{Name: "vim", Description: "Toggle vim editing mode"},
}

// codexBuiltins are Codex's own commands, the same way.
var codexBuiltins = []Command{
	{Name: "approvals", Description: "Choose what Codex may do without asking"},
	{Name: "compact", Description: "Summarize the conversation to free context"},
	{Name: "diff", Description: "Show the git diff, untracked files included"},
	{Name: "init", Description: "Write an AGENTS.md for this project"},
	{Name: "mcp", Description: "List the MCP tools"},
	{Name: "mention", Description: "Mention a file"},
	{Name: "model", Description: "Choose the model and reasoning effort"},
	{Name: "new", Description: "Start a new chat"},
	{Name: "review", Description: "Review the current changes"},
	{Name: "status", Description: "Show the session's settings and token usage"},
}

// List returns the commands agent ("claude" or "" for Claude Code, "codex",
// …) offers in dir, for a user whose home is home. Built-ins first, then the
// folder's, then the user's, each by name; a name already listed is not
// listed again (a project command shadows a user one of the same name, as in
// Claude Code).
func List(agent, dir, home string) []Command {
	l := &lister{seen: map[string]bool{}}
	switch agent {
	case "", "claude":
		l.add(claudeBuiltins, SourceBuiltin)
		for _, d := range projectDirs(dir) {
			l.commands(filepath.Join(d, ".claude", "commands"), SourceProject)
			l.skills(filepath.Join(d, ".claude", "skills"), SourceProjectSkill)
		}
		if home != "" {
			l.commands(filepath.Join(home, ".claude", "commands"), SourceUser)
			l.skills(filepath.Join(home, ".claude", "skills"), SourceUserSkill)
		}
	case "codex":
		l.add(codexBuiltins, SourceBuiltin)
		if home != "" {
			l.prompts(filepath.Join(home, ".codex", "prompts"))
		}
	}
	return l.out
}

type lister struct {
	out   []Command
	seen  map[string]bool
	files int
}

func (l *lister) add(cs []Command, source string) {
	for _, c := range cs {
		if l.seen[c.Name] {
			continue
		}
		l.seen[c.Name] = true
		c.Source = source
		l.out = append(l.out, c)
	}
}

// commands reads a commands folder: every .md under it, named by its file
// name (a subfolder organises, it does not rename).
func (l *lister) commands(root, source string) {
	var found []Command
	_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil //nolint:nilerr // an unreadable entry is left out
		}
		if d.IsDir() {
			if rel, _ := filepath.Rel(root, p); strings.Count(rel, string(filepath.Separator)) >= 3 {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.EqualFold(filepath.Ext(p), ".md") || !l.take() {
			return nil
		}
		name := strings.TrimSuffix(d.Name(), filepath.Ext(d.Name()))
		if !validName(name) {
			return nil
		}
		meta, body := readHead(p)
		found = append(found, Command{Name: name, Description: describe(meta["description"], body), Hint: meta["argument-hint"]})
		return nil
	})
	sortByName(found)
	l.add(found, source)
}

// skills reads a skills folder: each subfolder with a SKILL.md, named by its
// front matter's name, else by the folder.
func (l *lister) skills(root, source string) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	var found []Command
	for _, e := range entries {
		if !e.IsDir() || !l.take() {
			continue
		}
		meta, body := readHead(filepath.Join(root, e.Name(), "SKILL.md"))
		if meta == nil && body == "" {
			continue
		}
		name := meta["name"]
		if !validName(name) {
			name = e.Name()
		}
		if !validName(name) {
			continue
		}
		found = append(found, Command{Name: name, Description: describe(meta["description"], body)})
	}
	sortByName(found)
	l.add(found, source)
}

// prompts reads Codex's prompts folder: each .md is /prompts:<name>.
func (l *lister) prompts(root string) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	var found []Command
	for _, e := range entries {
		if e.IsDir() || !strings.EqualFold(filepath.Ext(e.Name()), ".md") || !l.take() {
			continue
		}
		name := strings.TrimSuffix(e.Name(), filepath.Ext(e.Name()))
		if !validName(name) {
			continue
		}
		meta, body := readHead(filepath.Join(root, e.Name()))
		found = append(found, Command{Name: "prompts:" + name, Description: describe(meta["description"], body), Hint: meta["argument-hint"]})
	}
	sortByName(found)
	l.add(found, SourceUser)
}

func (l *lister) take() bool {
	if l.files >= MaxFiles {
		return false
	}
	l.files++
	return true
}

func sortByName(cs []Command) {
	sort.SliceStable(cs, func(i, j int) bool { return cs[i].Name < cs[j].Name })
}

// validName keeps names that can be typed after a slash: no spaces, no
// control characters, not empty, not absurdly long.
func validName(name string) bool {
	if name == "" || len(name) > 80 {
		return false
	}
	for _, r := range name {
		if r <= ' ' || r == '/' || r == 0x7f {
			return false
		}
	}
	return true
}

// projectDirs is dir and, when dir is inside a repository, the repository's
// root: commands are found in either.
func projectDirs(dir string) []string {
	if dir == "" {
		return nil
	}
	dir = filepath.Clean(dir)
	out := []string{dir}
	for d := dir; ; {
		if _, err := os.Lstat(filepath.Join(d, ".git")); err == nil {
			if d != dir {
				out = append(out, d)
			}
			break
		}
		parent := filepath.Dir(d)
		if parent == d {
			break
		}
		d = parent
	}
	return out
}

// readHead reads the start of a markdown file: its front matter as flat
// key: value pairs (nil when it has none), and the first line of its body.
func readHead(path string) (map[string]string, string) {
	f, err := os.Open(path)
	if err != nil {
		return nil, ""
	}
	defer f.Close()
	buf, _ := io.ReadAll(io.LimitReader(f, headBytes))
	sc := bufio.NewScanner(bytes.NewReader(buf))
	var meta map[string]string
	first := true
	inFront := false
	for sc.Scan() {
		line := strings.TrimRight(sc.Text(), "\r")
		if first {
			first = false
			if strings.TrimSpace(line) == "---" {
				inFront = true
				meta = map[string]string{}
				continue
			}
		}
		if inFront {
			if strings.TrimSpace(line) == "---" {
				inFront = false
				continue
			}
			if k, v, ok := strings.Cut(line, ":"); ok && !strings.HasPrefix(line, " ") && !strings.HasPrefix(line, "\t") {
				meta[strings.TrimSpace(k)] = unquote(strings.TrimSpace(v))
			}
			continue
		}
		if t := strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(line), "#")); t != "" {
			return meta, t
		}
	}
	return meta, ""
}

func unquote(s string) string {
	if len(s) >= 2 && (s[0] == '"' && s[len(s)-1] == '"' || s[0] == '\'' && s[len(s)-1] == '\'') {
		return s[1 : len(s)-1]
	}
	return s
}

// describe is the front matter's description, else the body's first line,
// on one line and clipped.
func describe(desc, body string) string {
	d := desc
	if d == "" || d == ">" || d == "|" {
		d = body
	}
	d = strings.Join(strings.Fields(d), " ")
	if r := []rune(d); len(r) > descMax {
		d = string(r[:descMax-1]) + "…"
	}
	return d
}
