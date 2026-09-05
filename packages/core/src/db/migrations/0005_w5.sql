CREATE TABLE w5_jobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'classify',
  forced       INTEGER NOT NULL DEFAULT 0,
  requested_at TEXT NOT NULL,
  claimed_at   TEXT,
  finished_at  TEXT,
  state        TEXT NOT NULL DEFAULT 'queued',
  error        TEXT
);

CREATE TABLE w5_runs (
  session_id      TEXT PRIMARY KEY,
  last_run_at     TEXT NOT NULL,
  last_message_ts TEXT
);

CREATE TABLE w5_quiet (
  until TEXT NOT NULL
);
