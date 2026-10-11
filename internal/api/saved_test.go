package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/store"
)

type savedList struct {
	Items []store.SavedPrompt `json:"items"`
	Max   int                 `json:"max"`
}

// send makes a JSON request and decodes the answer into out (when 200).
func (e *env) send(t *testing.T, method, path, body string, out any) int {
	t.Helper()
	req, err := http.NewRequest(method, e.srv.URL+path, bytes.NewReader([]byte(body)))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if out != nil && resp.StatusCode == http.StatusOK {
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			t.Fatal(err)
		}
	}
	return resp.StatusCode
}

func TestSavedPromptsRoundTrip(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	p, _, err := store.InsertProject(ctx, e.st.DB(), store.Project{Root: "/work/alpha", Name: "alpha", Kind: "repo", Source: "folder", AddedAt: 1})
	if err != nil {
		t.Fatal(err)
	}

	var got struct{ Item store.SavedPrompt }
	if code := e.send(t, http.MethodPost, "/v1/saved-prompts", `{"kind":"prompt","name":" Fix tests ","text":"Run the tests and fix what fails.\nThen say what changed."}`, &got); code != 200 {
		t.Fatalf("add a prompt: %d", code)
	}
	if got.Item.ID == 0 || got.Item.Name != "Fix tests" || got.Item.ProjectID != 0 {
		t.Fatalf("stored %+v", got.Item)
	}
	prompt := got.Item.ID
	body := `{"kind":"command","name":"Dev server","text":"pnpm dev","project_id":` + jsonInt(p.ID) + `}`
	if code := e.send(t, http.MethodPost, "/v1/saved-prompts", body, &got); code != 200 {
		t.Fatalf("add a command: %d", code)
	}
	if got.Item.ProjectRoot != "/work/alpha" || got.Item.ProjectName != "alpha" {
		t.Fatalf("the project is not joined in: %+v", got.Item)
	}
	command := got.Item.ID

	var list savedList
	if code := e.get(t, "/v1/saved-prompts", &list); code != 200 || len(list.Items) != 2 || list.Max != savedMax {
		t.Fatalf("list: %d %+v", code, list)
	}
	// The ones for every project come first.
	if list.Items[0].ID != prompt {
		t.Errorf("order: %+v", list.Items)
	}

	// A PATCH keeps what it does not name.
	if code := e.send(t, http.MethodPatch, "/v1/saved-prompts/"+jsonInt(command), `{"name":"Start the dev server"}`, &got); code != 200 {
		t.Fatalf("patch: %d", code)
	}
	if got.Item.Name != "Start the dev server" || got.Item.Text != "pnpm dev" || got.Item.ProjectID != p.ID {
		t.Fatalf("patched %+v", got.Item)
	}
	// Moved to every project (a fresh value: project_id 0 is left out of the answer).
	got = struct{ Item store.SavedPrompt }{}
	if code := e.send(t, http.MethodPatch, "/v1/saved-prompts/"+jsonInt(command), `{"project_id":0}`, &got); code != 200 || got.Item.ProjectID != 0 {
		t.Fatalf("to every project: %d %+v", code, got.Item)
	}

	if code := e.send(t, http.MethodDelete, "/v1/saved-prompts/"+jsonInt(prompt), `{}`, nil); code != http.StatusNoContent {
		t.Fatalf("delete: %d", code)
	}
	if code := e.send(t, http.MethodDelete, "/v1/saved-prompts/"+jsonInt(prompt), `{}`, nil); code != http.StatusNotFound {
		t.Fatalf("delete again: %d", code)
	}
	if code := e.send(t, http.MethodPatch, "/v1/saved-prompts/9999", `{"name":"x"}`, nil); code != http.StatusNotFound {
		t.Fatalf("patch unknown: %d", code)
	}
}

func TestSavedPromptsRefuseWhatCannotBeKept(t *testing.T) {
	e := newEnv(t)
	cases := map[string]string{
		"no kind":           `{"name":"a","text":"b"}`,
		"unknown kind":      `{"kind":"macro","name":"a","text":"b"}`,
		"no name":           `{"kind":"prompt","name":"  ","text":"b"}`,
		"two-line name":     `{"kind":"prompt","name":"a\nb","text":"b"}`,
		"long name":         `{"kind":"prompt","name":"` + strings.Repeat("n", savedNameMax+1) + `","text":"b"}`,
		"empty text":        `{"kind":"prompt","name":"a","text":" "}`,
		"NUL":               `{"kind":"prompt","name":"a","text":"b\u0000"}`,
		"two-line command":  `{"kind":"command","name":"a","text":"make\nmake test"}`,
		"long command":      `{"kind":"command","name":"a","text":"` + strings.Repeat("x", savedCommandMax+1) + `"}`,
		"long prompt":       `{"kind":"prompt","name":"a","text":"` + strings.Repeat("x", savedPromptBytes+1) + `"}`,
		"unknown project":   `{"kind":"prompt","name":"a","text":"b","project_id":42}`,
		"not json":          `kind=prompt`,
		"negative project":  `{"kind":"prompt","name":"a","text":"b","project_id":-1}`,
		"command with a CR": `{"kind":"command","name":"a","text":"ls\rrm -r x"}`,
		"name with a tab":   `{"kind":"prompt","name":"a\tb","text":"b"}`,
	}
	for name, body := range cases {
		if code := e.send(t, http.MethodPost, "/v1/saved-prompts", body, nil); code != http.StatusBadRequest {
			t.Errorf("%s: %d, want 400", name, code)
		}
	}
	var list savedList
	e.get(t, "/v1/saved-prompts", &list)
	if len(list.Items) != 0 {
		t.Fatalf("something was kept: %+v", list.Items)
	}
}

func TestSavedPromptsAreCapped(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	for i := 0; i < savedMax; i++ {
		if _, err := store.InsertSavedPrompt(ctx, e.st.DB(), store.SavedPrompt{Kind: "prompt", Name: "p", Text: "t"}, 1); err != nil {
			t.Fatal(err)
		}
	}
	if code := e.send(t, http.MethodPost, "/v1/saved-prompts", `{"kind":"prompt","name":"one more","text":"t"}`, nil); code != http.StatusConflict {
		t.Fatalf("past the cap: %d, want 409", code)
	}
}

// ?session= keeps the ones for every project and the session's own project's.
func TestSavedPromptsForASession(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	dir := t.TempDir()
	e.seed(t, dir)
	mine, _, err := store.InsertProject(ctx, e.st.DB(), store.Project{Root: store.NormalizeDir(dir), Name: "mine", Kind: "folder", Source: "folder", AddedAt: 1})
	if err != nil {
		t.Fatal(err)
	}
	other, _, err := store.InsertProject(ctx, e.st.DB(), store.Project{Root: "/elsewhere", Name: "other", Kind: "folder", Source: "folder", AddedAt: 1})
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range []store.SavedPrompt{
		{Kind: "prompt", Name: "everywhere", Text: "t"},
		{Kind: "prompt", Name: "here", Text: "t", ProjectID: mine.ID},
		{Kind: "prompt", Name: "there", Text: "t", ProjectID: other.ID},
	} {
		if _, err := store.InsertSavedPrompt(ctx, e.st.DB(), v, 1); err != nil {
			t.Fatal(err)
		}
	}
	var list savedList
	if code := e.get(t, "/v1/saved-prompts?session=s1", &list); code != 200 {
		t.Fatalf("list: %d", code)
	}
	var names []string
	for _, v := range list.Items {
		names = append(names, v.Name)
	}
	if strings.Join(names, ",") != "everywhere,here" {
		t.Fatalf("for the session: %v", names)
	}
	if code := e.get(t, "/v1/saved-prompts?session=nobody", nil); code != http.StatusNotFound {
		t.Fatalf("unknown session: %d", code)
	}
}

func jsonInt(v int64) string {
	b, _ := json.Marshal(v)
	return string(b)
}
