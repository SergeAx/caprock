---
kind: Changed
---
- **store:** an event names its session by an integer key instead of
  repeating the session's 36-character id in its row and in most indexes. A
  1 GB database came out 128 MiB smaller after a VACUUM (measured
  2026-10-19). The first start after the upgrade rewrites the events table
  once, 47 s on that database, and the file stays larger than before until
  the idle-time vacuum has given the old table's space back. A query on
  `caprock.db` joins `sessions` for a session's id (`docs/schema.md`). No
  earlier release can use the upgraded database, so there is no going back
  to one.
