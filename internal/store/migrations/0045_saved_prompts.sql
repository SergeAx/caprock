-- Saved prompts and commands (ADR-051): short text the user sends to an agent
-- Caprock started, or a one-line shell command run in a new shell tab, each
-- with a name, for every project or for one.
--
-- project_id NULL means every project. A project taken off the list
-- (projects.archived_at) keeps its rows; nothing here is deleted with it.
-- Edited on the machine only; a paired device reads them (the phone's chips).
CREATE TABLE IF NOT EXISTS saved_prompts (
  id         INTEGER PRIMARY KEY,
  kind       TEXT    NOT NULL CHECK (kind IN ('prompt','command')),
  name       TEXT    NOT NULL,
  text       TEXT    NOT NULL,
  project_id INTEGER,                -- NULL = every project
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,       -- unix ms
  updated_at INTEGER NOT NULL        -- unix ms
);
CREATE INDEX IF NOT EXISTS idx_saved_prompts_project ON saved_prompts(project_id);
