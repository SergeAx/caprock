package agentcat

import (
	"path/filepath"
	"sort"
)

// Grok Build (xAI's `grok`) keeps its state in GROK_HOME, default ~/.grok
// (its README, "File Locations" and "Environment Variables", grok 0.2.114,
// read 2026-10-10):
//
//   - auth.json — "Authentication credentials (auto-managed)", written by
//     `grok login`; XAI_API_KEY in the environment is the other way in;
//   - models_cache.json — the model list it last fetched, an object whose
//     `models` maps a model id to `{info: {id, name, hidden}}`.

func grokHome(env Env) string {
	if v := env.get("GROK_HOME"); v != "" {
		return v
	}
	return filepath.Join(env.Home, ".grok")
}

func grokModels(env Env) []Model {
	var cache struct {
		Models map[string]struct {
			Info struct {
				ID     string `json:"id"`
				Name   string `json:"name"`
				Hidden bool   `json:"hidden"`
			} `json:"info"`
		} `json:"models"`
	}
	if !readJSON(filepath.Join(grokHome(env), "models_cache.json"), &cache) {
		return nil
	}
	var out []Model
	for id, m := range cache.Models {
		if m.Info.Hidden {
			continue
		}
		if m.Info.ID != "" {
			id = m.Info.ID
		}
		label := m.Info.Name
		if label == "" {
			label = id
		}
		out = append(out, Model{ID: id, Label: label})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Label < out[j].Label })
	return out
}

func grokEntry(env Env, ok, win bool) Entry {
	e := Entry{ID: "grok", Label: "Grok", Installed: ok, Prompt: true, Models: []Model{}}
	if !ok {
		// docs.x.ai/build/overview, read 2026-10-10.
		cmd := "curl -fsSL https://x.ai/cli/install.sh | bash"
		if win {
			cmd = "irm https://x.ai/cli/install.ps1 | iex"
		}
		e.Setup = notInstalled("Grok", cmd, "https://docs.x.ai/build/overview")
		return e
	}
	if ms := grokModels(env); ms != nil {
		e.Models = ms
	}
	e.Ready = true
	if !exists(filepath.Join(grokHome(env), "auth.json")) && env.get("XAI_API_KEY") == "" {
		// It opens a browser to sign in on its first start, so this is a
		// hint, not a block: the session still starts.
		e.Setup = &Setup{Reason: "signin", Text: "Grok has no sign-in on this machine; it opens a browser to sign in on its first start.", Command: "grok login", Docs: "https://docs.x.ai/build/overview"}
	}
	return e
}
