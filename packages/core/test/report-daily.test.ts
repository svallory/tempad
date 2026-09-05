import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/database.ts";
import { dailyReport } from "../src/report/daily.ts";
import { REPORT_CONFIG, seedReportFixtures } from "./fixtures/report-golden/seed.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tempad-report-daily-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("dailyReport", () => {
  test("matches golden output byte for byte", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    seedReportFixtures(database);

    const output = dailyReport.render(database, REPORT_CONFIG, {
      from: "2026-08-31",
      to: "2026-09-02",
    });

    const golden = readFileSync(join(import.meta.dir, "fixtures/report-golden/daily.md"), "utf8");
    expect(output).toBe(golden);

    database.close();
  });

  test("a 2026-09-01T02:30Z commit is placed on the 2026-08-31 local day", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    seedReportFixtures(database);

    const output = dailyReport.render(database, REPORT_CONFIG, {
      from: "2026-08-31",
      to: "2026-08-31",
    });

    expect(output).toContain("## 2026-08-31 (Monday)");
    expect(output).toContain("aaaaaaa fix(widgets): handle midnight boundary");
    expect(output).not.toContain("bbbbbbb");

    database.close();
  });

  test("a Monday item updated at 2026-09-01T01:00Z appears under the 2026-08-31 local day", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    // No timeline; the fallback is updated_at, which must bucket by local day
    // (America/Sao_Paulo, UTC-3): 2026-09-01T01:00Z is 2026-08-31 22:00 local.
    database.exec(
      `INSERT INTO monday_items (id, board_id, board_name, group_name, name, status, assignees, timeline_start, timeline_end, time_tracked_seconds, created_at, updated_at, raw, org, project)
       VALUES (902, 1, 'Beta Project', NULL, 'Late-night update', 'Done', '[]', NULL, NULL, NULL, '2026-09-01T01:00:00.000Z', '2026-09-01T01:00:00.000Z', '{}', 'monday', 'beta-project')`,
    );

    const output = dailyReport.render(database, REPORT_CONFIG, {
      from: "2026-08-31",
      to: "2026-08-31",
    });

    expect(output).toContain("## 2026-08-31 (Monday)");
    expect(output).toContain("Late-night update");

    const outOfRange = dailyReport.render(database, REPORT_CONFIG, {
      from: "2026-09-01",
      to: "2026-09-01",
    });
    expect(outOfRange).not.toContain("Late-night update");

    database.close();
  });

  test("an empty range still renders a title line and a no-evidence line, never an empty string", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    // no seed: empty database, a single weekend day with nothing at all

    const output = dailyReport.render(database, REPORT_CONFIG, {
      from: "2026-09-05", // Saturday
      to: "2026-09-05",
    });

    expect(output).toBe("# daily report 2026-09-05 to 2026-09-05\n\nno evidence");
    expect(output.length).toBeGreaterThan(0);

    database.close();
  });

  test("named sessions are listed individually, unnamed sessions roll up into one line", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    seedReportFixtures(database);

    database.exec(
      `INSERT INTO claude_sessions (id, claude_dir, project_dir, file_path, cwd, org, project, path_meta, title, title_source, git_branch, started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
       VALUES
       ('session-2', '~/.claude', 'dir', '/tmp/session-2.jsonl', NULL, 'acme', 'widgets', NULL, 'do the thing', 'first-message', NULL, '2026-09-01T12:00:00.000Z', '2026-09-01T12:05:00.000Z', 2, 0, '[]', 'test-host', '2026-09-01T12:05:00.000Z'),
       ('session-3', '~/.claude', 'dir', '/tmp/session-3.jsonl', NULL, 'acme', 'widgets', NULL, NULL, 'none', NULL, '2026-09-01T12:10:00.000Z', '2026-09-01T12:12:00.000Z', 4, 0, '[]', 'test-host', '2026-09-01T12:12:00.000Z')`,
    );

    const output = dailyReport.render(database, REPORT_CONFIG, {
      from: "2026-09-01",
      to: "2026-09-01",
    });

    expect(output).toContain("Polish report output, 09:15 to 10:45, 3 messages");
    expect(output).not.toContain("do the thing");
    expect(output).toContain("- 2 untitled sessions (6 messages)");

    database.close();
  });

  test("a NULL title_source (pre-migration row, never re-synced) is listed individually, not rolled up", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    seedReportFixtures(database);

    database.exec(
      `INSERT INTO claude_sessions (id, claude_dir, project_dir, file_path, cwd, org, project, path_meta, title, title_source, git_branch, started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
       VALUES ('session-legacy', '~/.claude', 'dir', '/tmp/session-legacy.jsonl', NULL, 'acme', 'widgets', NULL, 'pre-migration session', NULL, NULL, '2026-09-01T12:20:00.000Z', '2026-09-01T12:25:00.000Z', 2, 0, '[]', 'test-host', '2026-09-01T12:25:00.000Z')`,
    );

    const output = dailyReport.render(database, REPORT_CONFIG, {
      from: "2026-09-01",
      to: "2026-09-01",
    });

    expect(output).toContain("pre-migration session,");
    expect(output).not.toContain("untitled sessions");

    database.close();
  });

  test("a session with both title and title_source NULL renders as (untitled session), never the string 'null'", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    seedReportFixtures(database);

    database.exec(
      `INSERT INTO claude_sessions (id, claude_dir, project_dir, file_path, cwd, org, project, path_meta, title, title_source, git_branch, started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
       VALUES ('session-no-title', '~/.claude', 'dir', '/tmp/session-no-title.jsonl', NULL, 'acme', 'widgets', NULL, NULL, NULL, NULL, '2026-09-01T12:30:00.000Z', '2026-09-01T12:35:00.000Z', 2, 0, '[]', 'test-host', '2026-09-01T12:35:00.000Z')`,
    );

    const output = dailyReport.render(database, REPORT_CONFIG, {
      from: "2026-09-01",
      to: "2026-09-01",
    });

    expect(output).toContain("(untitled session), 09:30 to 09:35, 2 messages");
    expect(output).not.toContain("- null,");

    database.close();
  });

  test("rebased copies of the same commit (same repo/subject/authored_at, different sha) print once with an (xN) suffix", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    seedReportFixtures(database);

    database.exec(
      `INSERT INTO gh_commits (sha, repo, branches, author_name, author_email, authored_at, committed_at, subject, body, files_changed, insertions, deletions)
       VALUES
       ('fffffff6666666666666666666666666666666', 'acme/widgets', '["feature/rebased"]', 'Octo Cat', 'octocat@example.com', '2026-09-01T14:00:00.000Z', '2026-09-01T14:00:00.000Z', 'feat(widgets): polish report output', NULL, 2, 10, 3),
       ('9999999777777777777777777777777777777a', 'acme/widgets', '["feature/rebased-2"]', 'Octo Cat', 'octocat@example.com', '2026-09-01T14:00:00.000Z', '2026-09-01T14:00:00.000Z', 'feat(widgets): polish report output', NULL, 2, 10, 3)`,
    );

    const output = dailyReport.render(database, REPORT_CONFIG, {
      from: "2026-09-01",
      to: "2026-09-01",
    });

    expect(output).toContain("bbbbbbb feat(widgets): polish report output (acme/widgets) (x3)");
    const occurrences = output.split("feat(widgets): polish report output").length - 1;
    expect(occurrences).toBe(1);

    database.close();
  });

  test("Quests and Side quests render as level-4 Markdown headings", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    seedReportFixtures(database);

    const output = dailyReport.render(database, REPORT_CONFIG, {
      from: "2026-09-01",
      to: "2026-09-01",
    });

    expect(output).toContain("#### Quests");
    expect(output).toContain("#### Side quests");
    expect(output).not.toMatch(/^Quests$/m);
    expect(output).not.toMatch(/^Side quests$/m);

    database.close();
  });

  test("a weekday with nothing prints no evidence, a weekend with nothing is omitted", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    // no seed: empty database

    const output = dailyReport.render(database, REPORT_CONFIG, {
      // 2026-09-03 Thursday (weekday, empty) .. 2026-09-06 Sunday (weekend, empty)
      from: "2026-09-03",
      to: "2026-09-06",
    });

    expect(output).toContain("## 2026-09-03 (Thursday)");
    expect(output).toContain("- no evidence");
    expect(output).toContain("## 2026-09-04 (Friday)");
    expect(output).not.toContain("## 2026-09-05");
    expect(output).not.toContain("## 2026-09-06");

    database.close();
  });
});
