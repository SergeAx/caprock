package store

import (
	"context"
	"database/sql"
	"errors"
)

// SavedPrompt is one saved prompt or command (migration 0045, ADR-051).
type SavedPrompt struct {
	ID   int64  `json:"id"`
	Kind string `json:"kind"` // prompt | command
	Name string `json:"name"`
	Text string `json:"text"`
	// ProjectID is the project it belongs to; 0 means every project.
	ProjectID int64 `json:"project_id,omitempty"`
	// ProjectRoot and ProjectName are the project's, joined in when listed,
	// so a client can scope it to a folder without a second request.
	ProjectRoot string `json:"project_root,omitempty"`
	ProjectName string `json:"project_name,omitempty"`
	Sort        int64  `json:"sort"`
	CreatedAt   int64  `json:"created_at"`
	UpdatedAt   int64  `json:"updated_at"`
}

// Saved prompt kinds, as the CHECK constraint spells them.
const (
	SavedKindPrompt  = "prompt"
	SavedKindCommand = "command"
)

// ErrSavedNotFound is returned for an id no row has.
var ErrSavedNotFound = errors.New("no such saved prompt")

const savedCols = `s.id, s.kind, s.name, s.text, COALESCE(s.project_id, 0), COALESCE(p.root, ''), COALESCE(p.name, ''), s.sort, s.created_at, s.updated_at`

func scanSaved(sc interface{ Scan(...any) error }) (SavedPrompt, error) {
	var v SavedPrompt
	err := sc.Scan(&v.ID, &v.Kind, &v.Name, &v.Text, &v.ProjectID, &v.ProjectRoot, &v.ProjectName, &v.Sort, &v.CreatedAt, &v.UpdatedAt)
	return v, err
}

// ListSavedPrompts returns every saved prompt and command: the ones for every
// project first, then by project, then by sort and name.
func ListSavedPrompts(ctx context.Context, q Querier) ([]SavedPrompt, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+savedCols+` FROM saved_prompts s LEFT JOIN projects p ON p.id = s.project_id
		ORDER BY s.project_id IS NOT NULL, COALESCE(p.name, ''), s.sort, s.name COLLATE NOCASE, s.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SavedPrompt{}
	for rows.Next() {
		v, err := scanSaved(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// CountSavedPrompts is how many rows there are, for the cap.
func CountSavedPrompts(ctx context.Context, q Querier) (int, error) {
	var n int
	err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM saved_prompts`).Scan(&n)
	return n, err
}

// GetSavedPrompt returns one row; ErrSavedNotFound when unknown.
func GetSavedPrompt(ctx context.Context, q Querier, id int64) (SavedPrompt, error) {
	v, err := scanSaved(q.QueryRowContext(ctx, `SELECT `+savedCols+` FROM saved_prompts s LEFT JOIN projects p ON p.id = s.project_id WHERE s.id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return SavedPrompt{}, ErrSavedNotFound
	}
	return v, err
}

// nullID stores 0 (every project) as NULL.
func nullID(id int64) any {
	if id <= 0 {
		return nil
	}
	return id
}

// InsertSavedPrompt adds a row and returns it as listed.
func InsertSavedPrompt(ctx context.Context, q Querier, v SavedPrompt, now int64) (SavedPrompt, error) {
	res, err := q.ExecContext(ctx, `INSERT INTO saved_prompts (kind, name, text, project_id, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		v.Kind, v.Name, v.Text, nullID(v.ProjectID), v.Sort, now, now)
	if err != nil {
		return SavedPrompt{}, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return SavedPrompt{}, err
	}
	return GetSavedPrompt(ctx, q, id)
}

// UpdateSavedPrompt replaces a row's kind, name, text, project and sort.
func UpdateSavedPrompt(ctx context.Context, q Querier, v SavedPrompt, now int64) (SavedPrompt, error) {
	res, err := q.ExecContext(ctx, `UPDATE saved_prompts SET kind = ?, name = ?, text = ?, project_id = ?, sort = ?, updated_at = ? WHERE id = ?`,
		v.Kind, v.Name, v.Text, nullID(v.ProjectID), v.Sort, now, v.ID)
	if err != nil {
		return SavedPrompt{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return SavedPrompt{}, ErrSavedNotFound
	}
	return GetSavedPrompt(ctx, q, v.ID)
}

// DeleteSavedPrompt removes a row; ErrSavedNotFound when there was none.
func DeleteSavedPrompt(ctx context.Context, q Querier, id int64) error {
	res, err := q.ExecContext(ctx, `DELETE FROM saved_prompts WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrSavedNotFound
	}
	return nil
}
