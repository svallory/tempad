ALTER TABLE gh_repos ADD COLUMN project TEXT;
ALTER TABLE gh_repos ADD COLUMN meta TEXT;

ALTER TABLE monday_items ADD COLUMN org TEXT;
ALTER TABLE monday_items ADD COLUMN project TEXT;
ALTER TABLE monday_items ADD COLUMN meta TEXT;

ALTER TABLE claude_sessions ADD COLUMN title_source TEXT;
ALTER TABLE claude_sessions ADD COLUMN entrypoint TEXT;
ALTER TABLE claude_sessions ADD COLUMN user_type TEXT;
