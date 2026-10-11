package store

import (
	"context"
	"strconv"
	"strings"
)

// Attempt is one of several sessions started on the same first message, each
// in a new copy of the same branch (migration 0046, ADR-052).
type Attempt struct {
	SessionID string `json:"session_id"`
	GroupID   string `json:"group_id"`
	N         int    `json:"n"`
	Total     int    `json:"total"`
	// Base is the branch the copies started from; BaseCommit the commit it
	// pointed at, which each attempt's changes are measured from.
	Base       string `json:"base,omitempty"`
	BaseCommit string `json:"base_commit,omitempty"`
	CreatedAt  int64  `json:"created_at"`
}

// InsertAttempt records that a session is attempt n of total in a group.
func InsertAttempt(ctx context.Context, q Querier, a Attempt) error {
	_, err := q.ExecContext(ctx, `INSERT OR REPLACE INTO attempts (session_id, group_id, n, total, base, base_commit, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		a.SessionID, a.GroupID, a.N, a.Total, a.Base, a.BaseCommit, a.CreatedAt)
	return err
}

// SetAttemptTotal says how many of a group started, when fewer did than asked.
func SetAttemptTotal(ctx context.Context, q Querier, group string, total int) error {
	_, err := q.ExecContext(ctx, `UPDATE attempts SET total = ? WHERE group_id = ?`, total, group)
	return err
}

// AttemptGroup returns a group's attempts in order; empty for an unknown one.
func AttemptGroup(ctx context.Context, q Querier, group string) ([]Attempt, error) {
	rows, err := q.QueryContext(ctx, `SELECT session_id, group_id, n, total, base, base_commit, created_at FROM attempts WHERE group_id = ? ORDER BY n`, group)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Attempt{}
	for rows.Next() {
		var a Attempt
		if err := rows.Scan(&a.SessionID, &a.GroupID, &a.N, &a.Total, &a.Base, &a.BaseCommit, &a.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// attemptCol is the session's attempt as one string, "<group> <n> <total>",
// or "" — read with the session's other columns (sessionCols).
const attemptCol = `COALESCE((SELECT a.group_id || ' ' || a.n || ' ' || a.total FROM attempts a WHERE a.session_id = sessions.session_id), '')`

// setAttempt fills a session's attempt fields from attemptCol's value.
func (s *Session) setAttempt(v string) {
	parts := strings.Fields(v)
	if len(parts) != 3 {
		return
	}
	n, err1 := strconv.Atoi(parts[1])
	total, err2 := strconv.Atoi(parts[2])
	if err1 != nil || err2 != nil {
		return
	}
	s.AttemptGroup, s.Attempt, s.Attempts = parts[0], n, total
}
