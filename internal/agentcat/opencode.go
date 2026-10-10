package agentcat

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// OpenCode keeps three things this reads, all under xdg-basedir's layout on
// every platform (internal/opencode explains why there is no Windows branch),
// as `opencode providers list` (opencode 1.15.10, 2026-10-10) shows them:
//
//   - credentials from `opencode auth login`: <data>/opencode/auth.json, an
//     object keyed by provider id;
//   - the user's config: <config>/opencode/opencode.json(c) or config.json,
//     whose `model` is the default and `provider` the providers set up there;
//   - the models.dev catalog it cached: <cache>/opencode/models.json, keyed
//     by provider id, each with the environment variables that connect it
//     (`env`) and its models.
//
// A provider is connected when it has a credential, a config entry, or one of
// its variables set in the login shell. Its models are offered as OpenCode's
// own `provider/model` ids.

// openCodeModelCap bounds the list: a user with every provider connected
// would otherwise get a thousand rows; the field still takes a typed id.
const openCodeModelCap = 300

func xdg(env Env, key, fallback string) string {
	if v := env.get(key); v != "" {
		return v
	}
	if v := os.Getenv(key); v != "" {
		return v
	}
	return filepath.Join(env.Home, fallback)
}

type openCodeCatalog map[string]struct {
	ID     string   `json:"id"`
	Name   string   `json:"name"`
	Env    []string `json:"env"`
	Models map[string]struct {
		ID     string `json:"id"`
		Name   string `json:"name"`
		Status string `json:"status"`
	} `json:"models"`
}

// catalogCache keeps the parsed models.json while its size and time stand:
// the file is several megabytes and the picker asks on every open.
var catalogCache struct {
	sync.Mutex
	path  string
	size  int64
	mtime time.Time
	cat   openCodeCatalog
}

func readOpenCodeCatalog(path string) openCodeCatalog {
	fi, err := os.Stat(path)
	if err != nil {
		return nil
	}
	catalogCache.Lock()
	defer catalogCache.Unlock()
	if catalogCache.path == path && catalogCache.size == fi.Size() && catalogCache.mtime.Equal(fi.ModTime()) {
		return catalogCache.cat
	}
	var cat openCodeCatalog
	if !readJSON(path, &cat) {
		cat = nil
	}
	catalogCache.path, catalogCache.size, catalogCache.mtime, catalogCache.cat = path, fi.Size(), fi.ModTime(), cat
	return cat
}

// openCodeConfig reads the fields of OpenCode's config this needs. JSONC
// (comments, trailing commas) is OpenCode's own format and is accepted.
func openCodeConfig(env Env) (model string, providers []string) {
	dir := filepath.Join(xdg(env, "XDG_CONFIG_HOME", ".config"), "opencode")
	paths := []string{filepath.Join(dir, "opencode.json"), filepath.Join(dir, "opencode.jsonc"), filepath.Join(dir, "config.json")}
	if p := env.get("OPENCODE_CONFIG"); p != "" {
		paths = append(paths, p)
	}
	for _, p := range paths {
		b, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		var cfg struct {
			Model    string         `json:"model"`
			Provider map[string]any `json:"provider"`
		}
		if err := unmarshalJSONC(b, &cfg); err != nil {
			continue
		}
		if cfg.Model != "" {
			model = cfg.Model
		}
		for k := range cfg.Provider {
			providers = append(providers, k)
		}
	}
	return model, providers
}

// openCodeModels lists the models of the providers connected here, the model
// the config names, and whether anything at all is connected.
func openCodeModels(env Env) (models []Model, def string, connected bool) {
	def, fromConfig := openCodeConfig(env)
	have := map[string]bool{}
	for _, p := range fromConfig {
		have[p] = true
	}
	var auth map[string]any
	if readJSON(filepath.Join(xdg(env, "XDG_DATA_HOME", filepath.Join(".local", "share")), "opencode", "auth.json"), &auth) {
		for k := range auth {
			have[k] = true
		}
	}
	cat := readOpenCodeCatalog(filepath.Join(xdg(env, "XDG_CACHE_HOME", ".cache"), "opencode", "models.json"))
	for id, p := range cat {
		for _, v := range p.Env {
			if env.get(v) != "" {
				have[id] = true
				break
			}
		}
	}
	for id := range have {
		p, ok := cat[id]
		if !ok {
			continue
		}
		name := p.Name
		if name == "" {
			name = id
		}
		for mid, m := range p.Models {
			if m.Status == "deprecated" {
				continue
			}
			label := m.Name
			if label == "" {
				label = mid
			}
			models = append(models, Model{ID: id + "/" + mid, Label: name + " · " + label})
		}
	}
	sortModels(models)
	if len(models) > openCodeModelCap {
		models = models[:openCodeModelCap]
	}
	return models, def, len(have) > 0 || def != ""
}

func opencodeEntry(env Env, ok, win bool) Entry {
	e := Entry{ID: "opencode", Label: "OpenCode", Installed: ok, Observed: true, Prompt: true, TypedModel: true, Models: []Model{}}
	if !ok {
		// opencode.ai/docs, read 2026-10-10.
		cmd := "curl -fsSL https://opencode.ai/install | bash"
		if win {
			cmd = "npm install -g opencode-ai"
		}
		e.Setup = notInstalled("OpenCode", cmd, "https://opencode.ai/docs/")
		return e
	}
	models, def, connected := openCodeModels(env)
	if models != nil {
		e.Models = models
	}
	e.Default = def
	e.Ready = connected
	if !connected {
		// `opencode auth login`: `auth` is the alias of `providers` in
		// opencode 1.15.10's --help, and the name its docs have always used.
		e.Setup = &Setup{
			Reason:  "no_provider",
			Text:    "OpenCode has no model provider connected, so it has no models to offer.",
			Command: "opencode auth login",
			Docs:    "https://opencode.ai/docs/providers/",
		}
	}
	return e
}

// unmarshalJSONC decodes JSON with // and /* */ comments and trailing commas,
// which OpenCode's config allows.
func unmarshalJSONC(b []byte, v any) error {
	return json.Unmarshal(stripJSONC(b), v)
}

// stripJSONC removes comments and trailing commas outside strings.
func stripJSONC(b []byte) []byte {
	var out strings.Builder
	inStr, esc := false, false
	for i := 0; i < len(b); i++ {
		c := b[i]
		if inStr {
			out.WriteByte(c)
			switch {
			case esc:
				esc = false
			case c == '\\':
				esc = true
			case c == '"':
				inStr = false
			}
			continue
		}
		switch {
		case c == '"':
			inStr = true
			out.WriteByte(c)
		case c == '/' && i+1 < len(b) && b[i+1] == '/':
			for i < len(b) && b[i] != '\n' {
				i++
			}
			out.WriteByte('\n')
		case c == '/' && i+1 < len(b) && b[i+1] == '*':
			i += 2
			for i+1 < len(b) && (b[i] != '*' || b[i+1] != '/') {
				i++
			}
			i++
		case c == ',':
			// A comma followed only by space before } or ] is dropped.
			j := i + 1
			for j < len(b) && strings.IndexByte(" \t\r\n", b[j]) >= 0 {
				j++
			}
			if j < len(b) && (b[j] == '}' || b[j] == ']') {
				continue
			}
			out.WriteByte(c)
		default:
			out.WriteByte(c)
		}
	}
	return []byte(out.String())
}
