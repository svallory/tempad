CREATE TABLE sync_state (
  source        TEXT PRIMARY KEY,        -- 'monday' | 'github' | 'claude'
  last_sync_at  TEXT NOT NULL,           -- ISO, UTC
  cursor        TEXT                     -- source-specific opaque string
);

CREATE TABLE monday_items (
  id                   INTEGER PRIMARY KEY,
  board_id             INTEGER NOT NULL,
  board_name           TEXT NOT NULL,
  group_name           TEXT,
  name                 TEXT NOT NULL,
  status               TEXT,
  assignees            TEXT NOT NULL,     -- JSON array of {id, name}
  timeline_start       TEXT,              -- ISO date
  timeline_end         TEXT,
  time_tracked_seconds INTEGER,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  raw                  TEXT NOT NULL      -- full column_values JSON
);
CREATE INDEX monday_items_updated ON monday_items(updated_at);

CREATE TABLE gh_repos (
  full_name      TEXT PRIMARY KEY,        -- org/repo
  org            TEXT NOT NULL,
  is_personal    INTEGER NOT NULL,
  default_branch TEXT,
  mirrored_at    TEXT
);

CREATE TABLE gh_commits (
  sha            TEXT PRIMARY KEY,
  repo           TEXT NOT NULL REFERENCES gh_repos(full_name),
  branches       TEXT NOT NULL,           -- JSON array of refs containing the sha
  author_name    TEXT NOT NULL,
  author_email   TEXT NOT NULL,
  authored_at    TEXT NOT NULL,
  committed_at   TEXT NOT NULL,
  subject        TEXT NOT NULL,
  body           TEXT,
  files_changed  INTEGER,
  insertions     INTEGER,
  deletions      INTEGER
);
CREATE INDEX gh_commits_authored ON gh_commits(authored_at);

CREATE TABLE gh_pull_requests (
  repo        TEXT NOT NULL REFERENCES gh_repos(full_name),
  number      INTEGER NOT NULL,
  title       TEXT NOT NULL,
  state       TEXT NOT NULL,              -- open | closed | merged
  author      TEXT NOT NULL,
  role        TEXT NOT NULL,              -- author | reviewer
  created_at  TEXT NOT NULL,
  merged_at   TEXT,
  closed_at   TEXT,
  PRIMARY KEY (repo, number)
);

CREATE TABLE claude_sessions (
  id               TEXT PRIMARY KEY,      -- sessionId
  claude_dir       TEXT NOT NULL,
  project_dir      TEXT NOT NULL,         -- encoded folder under projects/
  file_path        TEXT NOT NULL,
  cwd              TEXT,
  org              TEXT NOT NULL,
  project          TEXT NOT NULL,
  path_meta        TEXT,                  -- JSON of extra named groups
  title            TEXT,
  git_branch       TEXT,
  started_at       TEXT NOT NULL,
  ended_at         TEXT NOT NULL,
  message_count    INTEGER NOT NULL,
  tool_call_count  INTEGER NOT NULL,
  models           TEXT NOT NULL,         -- JSON array
  host_slug        TEXT NOT NULL,
  file_mtime       TEXT NOT NULL
);
CREATE INDEX claude_sessions_started ON claude_sessions(started_at);

CREATE TABLE claude_messages (
  uuid          TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES claude_sessions(id),
  ts            TEXT NOT NULL,
  role          TEXT NOT NULL,            -- user | assistant | system
  is_sidechain  INTEGER NOT NULL,
  origin_kind   TEXT,                     -- human | agent | hook ...
  model         TEXT,
  text_preview  TEXT,                     -- first 500 chars of text content
  tool_name     TEXT,                     -- when the line is a tool_use
  tokens_in     INTEGER,
  tokens_out    INTEGER
);
CREATE INDEX claude_messages_ts ON claude_messages(ts);
CREATE INDEX claude_messages_session ON claude_messages(session_id);
