package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/agentcat"
	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/license"
)

type fakeCatalog struct{ list []config.CustomAgent }

func (f *fakeCatalog) Catalog() CatalogResponse {
	return CatalogResponse{Agents: agentcat.CustomEntries(f.list, func(string) string { return "/bin/x" }, true)}
}
func (f *fakeCatalog) Custom() []config.CustomAgent { return f.list }
func (f *fakeCatalog) SetCustom(l []config.CustomAgent) error {
	f.list = l
	return nil
}

func (e *env) putCustom(t *testing.T, body string) (int, customAgentsBody) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPut, e.srv.URL+"/v1/agents/custom", bytes.NewReader([]byte(body)))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out customAgentsBody
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

// Custom agents are paid, and the server is what refuses: a lock drawn only
// in React is a lock a curl walks past.
func TestCustomAgentsNeedALicenceOnTheServer(t *testing.T) {
	e := newEnv(t)
	cat := &fakeCatalog{}
	e.api.d.Catalog = cat
	body := `{"agents": [{"name": "Aider", "command": "aider", "args": ["--yes", "{prompt}"]}]}`
	if code, _ := e.putCustom(t, body); code != http.StatusPaymentRequired {
		t.Fatalf("unlicensed: %d, want 402", code)
	}
	if len(cat.list) != 0 {
		t.Fatal("an unlicensed request stored an agent")
	}
	var got customAgentsBody
	if code := e.get(t, "/v1/agents/custom", &got); code != 200 || got.Licensed || len(got.Agents) != 0 {
		t.Fatalf("GET unlicensed: %d %+v", code, got)
	}

	cur := e.settings.Get()
	cur.LicenseKey = license.Issue(time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC), license.RandomSuffix)
	if err := e.settings.Set(cur); err != nil {
		t.Fatal(err)
	}
	code, saved := e.putCustom(t, body)
	if code != 200 || len(saved.Agents) != 1 || saved.Agents[0].ID != "aider" {
		t.Fatalf("licensed: %d %+v", code, saved)
	}
	if code, _ := e.putCustom(t, `{"agents": [{"name": "x", "command": "aider --yes"}]}`); code != http.StatusBadRequest {
		t.Errorf("a shell string as the command: %d, want 400", code)
	}
	var cat2 CatalogResponse
	if code := e.get(t, "/v1/agents/catalog", &cat2); code != 200 || len(cat2.Agents) != 1 || cat2.Agents[0].ID != "custom:aider" {
		t.Fatalf("catalog: %d %+v", code, cat2)
	}
}

func TestAgentCatalogWithoutTheDaemonPart(t *testing.T) {
	e := newEnv(t)
	if code := e.get(t, "/v1/agents/catalog", nil); code != http.StatusNotImplemented {
		t.Errorf("catalog: %d, want 501", code)
	}
}
