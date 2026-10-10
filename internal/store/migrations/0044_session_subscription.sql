-- The subscription a session ran on (ADR-048): the id of a sign-in added in
-- Settings → Subscriptions, whose configuration directory is
-- <data dir>/profiles/<id>/. Empty for the user's normal sign-in — the
-- Default subscription — and so for every session stored before this.
ALTER TABLE sessions ADD COLUMN subscription TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_sessions_subscription ON sessions(subscription) WHERE subscription <> '';
