package store

import "context"

// LivePID is a session that has not ended and the process it runs in.
type LivePID struct {
	SessionID string
	PID       int
}

// LivePIDs lists the sessions not ended that have a process id: the ones the
// resource meter can measure. Sessions without one (an older shim's rows, a
// transcript with no process behind it) are left out.
func LivePIDs(ctx context.Context, q Querier) ([]LivePID, error) {
	rows, err := q.QueryContext(ctx,
		`SELECT session_id, pid FROM sessions WHERE status != 'ended' AND pid IS NOT NULL AND pid > 0`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []LivePID
	for rows.Next() {
		var l LivePID
		if err := rows.Scan(&l.SessionID, &l.PID); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}
