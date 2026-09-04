import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/database.ts";
import { hourlyReport } from "../src/report/hourly.ts";
import { REPORT_CONFIG, seedReportFixtures } from "./fixtures/report-golden/seed.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tempad-report-hourly-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("hourlyReport", () => {
  test("matches golden output byte for byte", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    seedReportFixtures(database);

    const output = hourlyReport.render(database, REPORT_CONFIG, {
      from: "2026-08-31",
      to: "2026-09-02",
    });

    const golden = readFileSync(join(import.meta.dir, "fixtures/report-golden/hourly.md"), "utf8");
    expect(output).toBe(golden);

    database.close();
  });

  test("sidechain messages roll into the parent session's hour bucket", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    seedReportFixtures(database);

    const output = hourlyReport.render(database, REPORT_CONFIG, {
      from: "2026-09-01",
      to: "2026-09-01",
    });

    // Session runs 09:15-10:45 local with 2 messages in the 09:00 hour
    // (one of them the sidechain message counted at 13:30Z -> 10:30 local, in the 10:00 bucket)
    expect(output).toContain("Polish report output (2 messages)");
    expect(output).toContain("Polish report output (1 messages)");
  });

  test("untitled sessions in the same hour roll up into a single +N cell", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    seedReportFixtures(database);

    database.exec(
      `INSERT INTO claude_sessions (id, claude_dir, project_dir, file_path, cwd, org, project, path_meta, title, title_source, git_branch, started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
       VALUES
       ('session-2', '~/.claude', 'dir', '/tmp/session-2.jsonl', NULL, 'acme', 'widgets', NULL, NULL, 'none', NULL, '2026-09-01T12:05:00.000Z', '2026-09-01T12:06:00.000Z', 1, 0, '[]', 'test-host', '2026-09-01T12:06:00.000Z'),
       ('session-3', '~/.claude', 'dir', '/tmp/session-3.jsonl', NULL, 'acme', 'widgets', NULL, NULL, 'none', NULL, '2026-09-01T12:07:00.000Z', '2026-09-01T12:08:00.000Z', 2, 0, '[]', 'test-host', '2026-09-01T12:08:00.000Z')`,
    );
    database.exec(
      `INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, origin_kind, model, text_preview, tool_name, tokens_in, tokens_out)
       VALUES
       ('msg-4', 'session-2', '2026-09-01T12:05:30.000Z', 'user', 0, 'human', NULL, 'x', NULL, 5, NULL),
       ('msg-5', 'session-3', '2026-09-01T12:07:30.000Z', 'user', 0, 'human', NULL, 'y', NULL, 5, NULL),
       ('msg-6', 'session-3', '2026-09-01T12:07:45.000Z', 'assistant', 0, NULL, 'sonnet', 'z', NULL, NULL, 5)`,
    );

    const output = hourlyReport.render(database, REPORT_CONFIG, {
      from: "2026-09-01",
      to: "2026-09-01",
    });

    expect(output).toContain("+2 untitled (3 messages)");

    database.close();
  });

  test("a NULL title_source session is shown by name, not counted as untitled", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    seedReportFixtures(database);

    database.exec(
      `INSERT INTO claude_sessions (id, claude_dir, project_dir, file_path, cwd, org, project, path_meta, title, title_source, git_branch, started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
       VALUES ('session-legacy', '~/.claude', 'dir', '/tmp/session-legacy.jsonl', NULL, 'acme', 'widgets', NULL, 'pre-migration session', NULL, NULL, '2026-09-01T12:20:00.000Z', '2026-09-01T12:25:00.000Z', 1, 0, '[]', 'test-host', '2026-09-01T12:25:00.000Z')`,
    );
    database.exec(
      `INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, origin_kind, model, text_preview, tool_name, tokens_in, tokens_out)
       VALUES ('msg-legacy', 'session-legacy', '2026-09-01T12:21:00.000Z', 'user', 0, 'human', NULL, 'x', NULL, 5, NULL)`,
    );

    const output = hourlyReport.render(database, REPORT_CONFIG, {
      from: "2026-09-01",
      to: "2026-09-01",
    });

    expect(output).toContain("pre-migration session (1 messages)");
    expect(output).not.toContain("untitled");

    database.close();
  });

  test("a session with both title and title_source NULL renders as (untitled session), never the string 'null'", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    seedReportFixtures(database);

    database.exec(
      `INSERT INTO claude_sessions (id, claude_dir, project_dir, file_path, cwd, org, project, path_meta, title, title_source, git_branch, started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
       VALUES ('session-no-title', '~/.claude', 'dir', '/tmp/session-no-title.jsonl', NULL, 'acme', 'widgets', NULL, NULL, NULL, NULL, '2026-09-01T12:30:00.000Z', '2026-09-01T12:31:00.000Z', 1, 0, '[]', 'test-host', '2026-09-01T12:31:00.000Z')`,
    );
    database.exec(
      `INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, origin_kind, model, text_preview, tool_name, tokens_in, tokens_out)
       VALUES ('msg-no-title', 'session-no-title', '2026-09-01T12:30:30.000Z', 'user', 0, 'human', NULL, 'x', NULL, 5, NULL)`,
    );

    const output = hourlyReport.render(database, REPORT_CONFIG, {
      from: "2026-09-01",
      to: "2026-09-01",
    });

    expect(output).toContain("(untitled session) (1 messages)");
    expect(output).not.toContain("| null (1 messages)");

    database.close();
  });

  test("rebased copies of the same commit in one hour print once with an (xN) suffix", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    seedReportFixtures(database);

    database.exec(
      `INSERT INTO gh_commits (sha, repo, branches, author_name, author_email, authored_at, committed_at, subject, body, files_changed, insertions, deletions)
       VALUES ('fffffff6666666666666666666666666666666', 'acme/widgets', '["feature/rebased"]', 'Octo Cat', 'octocat@example.com', '2026-09-01T14:00:00.000Z', '2026-09-01T14:00:00.000Z', 'feat(widgets): polish report output', NULL, 2, 10, 3)`,
    );

    const output = hourlyReport.render(database, REPORT_CONFIG, {
      from: "2026-09-01",
      to: "2026-09-01",
    });

    expect(output).toContain("bbbbbbb (x2)");

    database.close();
  });

  test("a day with no evidence renders a single line", () => {
    const database = openDatabase(join(dir, "tempad.db"));

    const output = hourlyReport.render(database, REPORT_CONFIG, {
      from: "2026-09-10",
      to: "2026-09-10",
    });

    expect(output).toBe("# hourly report 2026-09-10 to 2026-09-10\n\n## 2026-09-10\nno evidence");

    database.close();
  });

  test("an empty range still renders a non-empty title line, never an empty string", () => {
    const database = openDatabase(join(dir, "tempad.db"));

    const output = hourlyReport.render(database, REPORT_CONFIG, {
      from: "2026-09-01",
      to: "2026-09-01",
    });

    expect(output.startsWith("# hourly report 2026-09-01 to 2026-09-01")).toBe(true);
    expect(output.length).toBeGreaterThan(0);

    database.close();
  });
});
