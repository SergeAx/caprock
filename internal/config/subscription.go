package config

// Subscription is a second (third, …) sign-in to Claude Code or Codex that
// Caprock keeps in a configuration directory of its own (ADR-048).
//
// The user's normal sign-in — the one `claude` or `codex` uses with no
// environment variable — is the Default subscription. It is not stored here:
// it always exists, and nothing about it is Caprock's to keep.
type Subscription struct {
	// ID names the subscription on a session (sessions.subscription) and its
	// directory, `<data dir>/profiles/<id>/`: lowercase letters and digits.
	ID string `json:"id"`
	// Label is what the user calls it ("Work Max", "Personal").
	Label string `json:"label"`
	// Agent is "claude" or "codex".
	Agent string `json:"agent"`
	// CreatedAt is when it was added, in Unix ms.
	CreatedAt int64 `json:"created_at"`
}
