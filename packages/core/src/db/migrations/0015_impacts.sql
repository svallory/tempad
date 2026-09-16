CREATE TABLE IF NOT EXISTS impacts (
  subject TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('pr', 'commit', 'monday')),
  text TEXT NOT NULL,
  theme TEXT,
  revision INTEGER NOT NULL,
  stated_at TEXT NOT NULL,
  event_id INTEGER NOT NULL,
  retracted_at TEXT
);
