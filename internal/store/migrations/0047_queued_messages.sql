-- Queued messages (ADR-053): what the chat field sent to a Claude Code session
-- Caprock started while its turn was still running. The daemon types the
-- oldest one in when the turn ends — the session's Stop hook, the turn not
-- held open by the task runner, no permission prompt waiting — one per turn.
--
-- Kept by the daemon, not the browser, so the phone and the Mac show one
-- queue and it outlives a phone going to sleep. Rows of a session that ended
-- are deleted: a message never waits for a process that is gone.
CREATE TABLE IF NOT EXISTS queued_messages (
  id         INTEGER PRIMARY KEY,
  session_id TEXT    NOT NULL,
  text       TEXT    NOT NULL,
  created_at INTEGER NOT NULL,       -- unix ms
  updated_at INTEGER NOT NULL        -- unix ms
);
CREATE INDEX IF NOT EXISTS idx_queued_messages_session ON queued_messages(session_id, id);
