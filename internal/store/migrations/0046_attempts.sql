-- One prompt, N attempts (ADR-052): sessions New agent started on the same
-- first message, each in a new copy of the same branch, grouped so the
-- Compare view can set them side by side.
--
-- One row per session. total is how many started together (a start that
-- stopped at a failure records how many it got). base is the branch the
-- copies were made from; base_commit the commit it pointed at, which each
-- attempt's changes are measured from. Nothing here is removed with a
-- session or a copy: the record of what was tried stays.
CREATE TABLE IF NOT EXISTS attempts (
  session_id  TEXT    PRIMARY KEY,
  group_id    TEXT    NOT NULL,
  n           INTEGER NOT NULL,
  total       INTEGER NOT NULL,
  base        TEXT    NOT NULL DEFAULT '',
  base_commit TEXT    NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL          -- unix ms
);
CREATE INDEX IF NOT EXISTS idx_attempts_group ON attempts(group_id);
