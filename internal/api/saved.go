package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/dspv/caprock/internal/store"
)

// Saved prompts and commands (ADR-051, contract in 03-contracts.md § Saved
// prompts and commands): a name and a text, for every project or for one. A
// prompt is typed into a session Caprock started, through the same input path
// as the keyboard; a command is typed and run in a new shell tab. The list is
// read by every paired device (the phone's chips); it is changed only on the
// machine — the write routes are in neither of lanauth.go's lists.

// Limits on what is kept. A saved prompt is a short instruction, not a brief;
// a command is one line.
const (
	savedMax         = 200
	savedNameMax     = 80
	savedPromptBytes = 8 << 10
	savedCommandMax  = 1 << 10
)

// savedBody is POST /v1/saved-prompts and PATCH /v1/saved-prompts/{id}; on a
// PATCH an absent field keeps its value.
type savedBody struct {
	Kind      *string `json:"kind"`
	Name      *string `json:"name"`
	Text      *string `json:"text"`
	ProjectID *int64  `json:"project_id"`
	Sort      *int64  `json:"sort"`
}

// apply copies what the body names onto v.
func (b savedBody) apply(v *store.SavedPrompt) {
	if b.Kind != nil {
		v.Kind = strings.TrimSpace(*b.Kind)
	}
	if b.Name != nil {
		v.Name = strings.TrimSpace(*b.Name)
	}
	if b.Text != nil {
		v.Text = strings.TrimSpace(*b.Text)
	}
	if b.ProjectID != nil {
		v.ProjectID = *b.ProjectID
	}
	if b.Sort != nil {
		v.Sort = *b.Sort
	}
}

// validSaved says what is wrong with v, or "".
func validSaved(v store.SavedPrompt) string {
	switch v.Kind {
	case store.SavedKindPrompt, store.SavedKindCommand:
	default:
		return `kind must be "prompt" or "command"`
	}
	if v.Name == "" {
		return "give it a name"
	}
	if utf8.RuneCountInString(v.Name) > savedNameMax {
		return fmt.Sprintf("the name is longer than %d characters", savedNameMax)
	}
	for _, r := range v.Name {
		if unicode.IsControl(r) {
			return "the name must be one line"
		}
	}
	if v.Text == "" {
		if v.Kind == store.SavedKindCommand {
			return "the command is empty"
		}
		return "the prompt is empty"
	}
	if strings.ContainsRune(v.Text, 0) || !utf8.ValidString(v.Text) {
		return "the text holds a character that cannot be typed"
	}
	if v.Kind == store.SavedKindCommand {
		if strings.ContainsAny(v.Text, "\r\n") {
			return "a command is one line; chain several with && or ;"
		}
		if len(v.Text) > savedCommandMax {
			return fmt.Sprintf("the command is longer than %d bytes", savedCommandMax)
		}
	} else if len(v.Text) > savedPromptBytes {
		return fmt.Sprintf("the prompt is longer than %d KiB", savedPromptBytes>>10)
	}
	if v.ProjectID < 0 {
		return "project_id is a project's id, or 0 for every project"
	}
	return ""
}

// savedRequest decodes a body and validates the row it makes; ok is false
// once it has answered.
func (s *Server) savedRequest(w http.ResponseWriter, r *http.Request, v *store.SavedPrompt) bool {
	var b savedBody
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&b); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "body is {kind, name, text, project_id?, sort?}"})
		return false
	}
	b.apply(v)
	if msg := validSaved(*v); msg != "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": msg})
		return false
	}
	if v.ProjectID > 0 {
		if _, err := store.GetProject(r.Context(), s.d.Store.DB(), v.ProjectID); err != nil {
			if errors.Is(err, store.ErrProjectNotFound) {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "no such project"})
			} else {
				s.fail(w, err)
			}
			return false
		}
	}
	return true
}

// handleSavedPrompts lists them. ?session=<id> keeps the ones for every
// project and those of the project that session's folder lies in.
func (s *Server) handleSavedPrompts(w http.ResponseWriter, r *http.Request) {
	list, err := store.ListSavedPrompts(r.Context(), s.d.Store.DB())
	if err != nil {
		s.fail(w, err)
		return
	}
	if id := r.URL.Query().Get("session"); id != "" {
		sess, err := store.GetSession(r.Context(), s.d.Store.DB(), id)
		if err != nil {
			s.notFoundOrFail(w, err)
			return
		}
		list = savedFor(list, sess.Cwd)
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": list, "max": savedMax})
}

// savedFor keeps the rows for every project and those whose project root
// holds dir.
func savedFor(list []store.SavedPrompt, dir string) []store.SavedPrompt {
	out := []store.SavedPrompt{}
	for _, v := range list {
		if v.ProjectID == 0 || (dir != "" && v.ProjectRoot != "" && store.DirWithin(dir, v.ProjectRoot)) {
			out = append(out, v)
		}
	}
	return out
}

func (s *Server) handleAddSavedPrompt(w http.ResponseWriter, r *http.Request) {
	var v store.SavedPrompt
	if !s.savedRequest(w, r, &v) {
		return
	}
	n, err := store.CountSavedPrompts(r.Context(), s.d.Store.DB())
	if err != nil {
		s.fail(w, err)
		return
	}
	if n >= savedMax {
		writeJSON(w, http.StatusConflict, map[string]string{"error": fmt.Sprintf("%d saved prompts and commands is the most Caprock keeps; delete one first", savedMax)})
		return
	}
	out, err := store.InsertSavedPrompt(r.Context(), s.d.Store.DB(), v, s.d.Now().UnixMilli())
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"item": out})
}

// savedID reads {id}; ok is false once it has answered.
func savedID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such saved prompt"})
		return 0, false
	}
	return id, true
}

func (s *Server) handlePatchSavedPrompt(w http.ResponseWriter, r *http.Request) {
	id, ok := savedID(w, r)
	if !ok {
		return
	}
	v, err := store.GetSavedPrompt(r.Context(), s.d.Store.DB(), id)
	if err != nil {
		s.savedErr(w, err)
		return
	}
	if !s.savedRequest(w, r, &v) {
		return
	}
	out, err := store.UpdateSavedPrompt(r.Context(), s.d.Store.DB(), v, s.d.Now().UnixMilli())
	if err != nil {
		s.savedErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"item": out})
}

func (s *Server) handleDeleteSavedPrompt(w http.ResponseWriter, r *http.Request) {
	id, ok := savedID(w, r)
	if !ok {
		return
	}
	if err := store.DeleteSavedPrompt(r.Context(), s.d.Store.DB(), id); err != nil {
		s.savedErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) savedErr(w http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrSavedNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	s.fail(w, err)
}
