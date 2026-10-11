package api

import (
	"net/http"
	"os"

	"github.com/dspv/caprock/internal/slashcmd"
	"github.com/dspv/caprock/internal/store"
)

// The chat field's pickers (ADR-053; contract in 03-contracts.md § Chat field
// pickers): `/` lists the session's slash commands and `@` its folder's
// files. Both are reads, open to every paired device as a project's file
// list is; picking one only puts text in the field.

// userHome is the user's home, where ~/.claude and ~/.codex are; a test
// points it elsewhere.
var userHome = os.UserHomeDir

// handleSessionCommands is GET /v1/sessions/{id}/commands →
// {agent, commands: [{name, description?, hint?, source}]}.
func (s *Server) handleSessionCommands(w http.ResponseWriter, r *http.Request) {
	sess, err := store.GetSession(r.Context(), s.d.Store.DB(), r.PathValue("id"))
	if err != nil {
		s.notFoundOrFail(w, err)
		return
	}
	home, _ := userHome()
	list := slashcmd.List(sess.Agent, sess.Cwd, home)
	if list == nil {
		list = []slashcmd.Command{}
	}
	agent := sess.Agent
	if agent == "" {
		agent = "claude"
	}
	writeJSON(w, http.StatusOK, map[string]any{"agent": agent, "commands": list})
}

// handleSessionFiles is GET /v1/sessions/{id}/files → {files, truncated?}:
// the session's working directory's files, as GET /v1/projects/{id}/files
// lists a project's, relative to that directory.
func (s *Server) handleSessionFiles(w http.ResponseWriter, r *http.Request) {
	if !s.requireProjects(w) {
		return
	}
	sess, err := store.GetSession(r.Context(), s.d.Store.DB(), r.PathValue("id"))
	if err != nil {
		s.notFoundOrFail(w, err)
		return
	}
	if sess.Cwd == "" {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "this session has no working directory on record"})
		return
	}
	l, err := s.d.Projects.ListDirFiles(r.Context(), sess.Cwd)
	if err != nil {
		fileFail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, l)
}
