package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/dspv/caprock/internal/projects"
	"github.com/dspv/caprock/internal/store"
)

// A project's copies: every worktree with its state and size, and removing
// the ones Caprock made (projects/copies.go; 03-contracts.md § Projects and
// shells). Loopback only: a paired device gets neither route (lanauth.go).

func (s *Server) handleCopies(w http.ResponseWriter, r *http.Request) {
	if !s.requireProjects(w) {
		return
	}
	id, ok := pathID(r)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such project"})
		return
	}
	v, err := s.d.Projects.Copies(r.Context(), id, s.busyIn(r.Context()))
	if err != nil {
		projectErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

func (s *Server) handleRemoveCopies(w http.ResponseWriter, r *http.Request) {
	if !s.requireProjects(w) {
		return
	}
	id, ok := pathID(r)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such project"})
		return
	}
	var body struct {
		Copies               []projects.CopyRemoval `json:"copies"`
		DeleteMergedBranches bool                   `json:"delete_merged_branches,omitempty"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&body); err != nil || len(body.Copies) == 0 || len(body.Copies) > 200 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "body is {copies: [{path, force?}] (1 to 200), delete_merged_branches?}"})
		return
	}
	ctx := context.WithoutCancel(r.Context())
	res, err := s.d.Projects.RemoveCopies(ctx, id, body.Copies, body.DeleteMergedBranches, s.busyIn(ctx))
	if err != nil {
		projectErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": res})
}

// busyIn answers what runs in a folder or below it: every session not ended
// whose working directory is there, and every shell tab started there. Read
// once per request.
func (s *Server) busyIn(ctx context.Context) projects.BusyFunc {
	type running struct{ dir, what string }
	var all []running
	if s.d.Store != nil {
		if list, err := store.ListSessions(ctx, s.d.Store.DB(), true, store.MaxSessionsPage); err == nil {
			for _, x := range list {
				if x.Cwd == "" {
					continue
				}
				name := strings.TrimSpace(x.Title)
				if name == "" {
					name = strings.TrimSpace(x.Prompt)
				}
				if r := []rune(name); len(r) > 48 {
					name = string(r[:47]) + "…"
				}
				what := "a session"
				if name != "" {
					what = fmt.Sprintf("the session %q", name)
				}
				all = append(all, running{x.Cwd, what})
			}
		}
	}
	if s.d.Shells != nil {
		for _, sh := range s.d.Shells.Shells() {
			all = append(all, running{sh.Cwd, "a shell tab"})
		}
	}
	return func(dir string, except []string) []string {
		var out []string
	next:
		for _, x := range all {
			if !insideDir(x.dir, dir) {
				continue
			}
			for _, e := range except {
				if insideDir(x.dir, e) {
					continue next
				}
			}
			out = append(out, x.what)
		}
		return out
	}
}

// insideDir reports whether child is dir or lies under it, symlinks resolved,
// case-insensitively where the file system usually is.
func insideDir(child, dir string) bool {
	if child == "" || dir == "" {
		return false
	}
	test := func(c, d string) bool {
		c, d = filepath.Clean(c), filepath.Clean(d)
		if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
			c, d = strings.ToLower(c), strings.ToLower(d)
		}
		rel, err := filepath.Rel(d, c)
		return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
	}
	if test(child, dir) {
		return true
	}
	rc, errC := filepath.EvalSymlinks(child)
	rd, errD := filepath.EvalSymlinks(dir)
	return errC == nil && errD == nil && test(rc, rd)
}
