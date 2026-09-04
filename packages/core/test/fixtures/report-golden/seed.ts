import type { Database } from "bun:sqlite";
import type { Config } from "../../../src/config/env.ts";

export const TIME_ZONE = "America/Sao_Paulo";

export const REPORT_CONFIG: Config = {
  mondayApiToken: "token",
  mondayUser: "1",
  ghUser: "octocat",
  ghOrgs: ["acme"],
  ghIncludePersonal: false,
  ghToken: undefined,
  gitAuthorEmails: ["octocat@example.com"],
  claudeDirs: [],
  hostSlug: "test-host",
  tz: TIME_ZONE,
  since: "2026-01-01",
  home: "/tmp/tempad-reports-test-home",
};

/**
 * Seeds a fixed dataset for report tests:
 * - repo acme/widgets, two commits: one at 2026-09-01T02:30:00Z (local 2026-08-31 23:30,
 *   proving the UTC/local day boundary crosses midnight) and one at 2026-09-01T14:00:00Z
 *   (local 2026-09-01 11:00).
 * - one Claude session spanning 12:15Z-13:45Z (local 09:15-10:45), with a sidechain message.
 * - one Monday item on board "Beta Project" (slug beta-project) with timeline 09-01..09-02.
 * - one pull request created 2026-09-01, merged 2026-09-02.
 */
export function seedReportFixtures(database: Database): void {
  database.exec(
    `INSERT INTO gh_repos (full_name, org, is_personal, default_branch, mirrored_at, project)
     VALUES ('acme/widgets', 'acme', 0, 'main', '2026-09-01T00:00:00.000Z', 'widgets')`,
  );

  database.exec(
    `INSERT INTO gh_commits (sha, repo, branches, author_name, author_email, authored_at, committed_at, subject, body, files_changed, insertions, deletions)
     VALUES
     ('aaaaaaa1111111111111111111111111111111', 'acme/widgets', '["main"]', 'Octo Cat', 'octocat@example.com', '2026-09-01T02:30:00.000Z', '2026-09-01T02:30:00.000Z', 'fix(widgets): handle midnight boundary', NULL, 1, 2, 1),
     ('bbbbbbb2222222222222222222222222222222', 'acme/widgets', '["feature/report-polish"]', 'Octo Cat', 'octocat@example.com', '2026-09-01T14:00:00.000Z', '2026-09-01T14:00:00.000Z', 'feat(widgets): polish report output', NULL, 2, 10, 3)`,
  );

  database.exec(
    `INSERT INTO gh_pull_requests (repo, number, title, state, author, role, created_at, merged_at, closed_at)
     VALUES ('acme/widgets', 42, 'Polish report output', 'merged', 'octocat', 'author', '2026-09-01T15:00:00.000Z', '2026-09-02T10:00:00.000Z', NULL)`,
  );

  database.exec(
    `INSERT INTO claude_sessions (id, claude_dir, project_dir, file_path, cwd, org, project, path_meta, title, title_source, git_branch, started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
     VALUES ('session-1', '~/.claude', '-Users-octocat-work-acme-widgets', '/tmp/session-1.jsonl', '/Users/octocat/work/acme/widgets', 'acme', 'widgets', NULL, 'Polish report output', 'custom-title', 'feature/report-polish', '2026-09-01T12:15:00.000Z', '2026-09-01T13:45:00.000Z', 3, 1, '["sonnet"]', 'test-host', '2026-09-01T13:45:00.000Z')`,
  );

  database.exec(
    `INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, origin_kind, model, text_preview, tool_name, tokens_in, tokens_out)
     VALUES
     ('msg-1', 'session-1', '2026-09-01T12:20:00.000Z', 'user', 0, 'human', NULL, 'let''s polish the report', NULL, 10, NULL),
     ('msg-2', 'session-1', '2026-09-01T12:25:00.000Z', 'assistant', 0, NULL, 'sonnet', 'sure, updating queries.ts', NULL, NULL, 50),
     ('msg-3', 'session-1', '2026-09-01T13:30:00.000Z', 'assistant', 1, 'agent', 'sonnet', 'sidechain: checking fixtures', NULL, NULL, 20)`,
  );

  database.exec(
    `INSERT INTO monday_items (id, board_id, board_name, group_name, name, status, assignees, timeline_start, timeline_end, time_tracked_seconds, created_at, updated_at, raw, org, project)
     VALUES (901, 1, 'Beta Project', 'In Progress', 'Ship report polish', 'Working on it', '[{"id":1,"name":"Octo Cat"}]', '2026-09-01', '2026-09-02', 3600, '2026-08-30T00:00:00.000Z', '2026-09-01T16:00:00.000Z', '{}', 'monday', 'beta-project')`,
  );
}
