import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/database.ts";
import { projectReport } from "../src/report/project.ts";
import { REPORT_CONFIG, seedReportFixtures } from "./fixtures/report-golden/seed.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tempad-report-project-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("projectReport", () => {
  test("a project with sessions but no commits or Monday items prints no evidence, not an empty table", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    seedReportFixtures(database);

    database.exec(
      `INSERT INTO claude_sessions (id, claude_dir, project_dir, file_path, cwd, org, project, path_meta, title, title_source, git_branch, started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
       VALUES ('session-9', '~/.claude', 'dir', '/tmp/session-9.jsonl', NULL, 'acme', 'empty-project', NULL, 'poking around', 'first-message', NULL, '2026-09-01T12:00:00.000Z', '2026-09-01T12:05:00.000Z', 1, 0, '[]', 'test-host', '2026-09-01T12:05:00.000Z')`,
    );

    const output = projectReport.render(database, REPORT_CONFIG, {
      from: "2026-08-31",
      to: "2026-09-02",
      project: "empty-project",
    });

    expect(output).toContain("### acme/empty-project\n- no evidence");
    expect(output).not.toContain("| task |");

    database.close();
  });

  test("matches golden output byte for byte", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    seedReportFixtures(database);

    const output = projectReport.render(database, REPORT_CONFIG, {
      from: "2026-08-31",
      to: "2026-09-02",
    });

    const golden = readFileSync(join(import.meta.dir, "fixtures/report-golden/project.md"), "utf8");
    expect(output).toBe(golden);

    database.close();
  });

  test("a project with a Monday item uses it as the row, not inferred branches", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    seedReportFixtures(database);

    const output = projectReport.render(database, REPORT_CONFIG, {
      from: "2026-08-31",
      to: "2026-09-02",
    });

    expect(output).toContain("### monday/beta-project");
    expect(output).toContain("Ship report polish");
  });

  test("branch rows scope the session count to sessions on that branch, not the whole project", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    seedReportFixtures(database);

    // The seeded session's git_branch is "feature/report-polish"; the "main" branch row
    // (from the other commit) has no session on it and must show 0, not the project total.
    const output = projectReport.render(database, REPORT_CONFIG, {
      from: "2026-08-31",
      to: "2026-09-02",
      project: "widgets",
    });

    expect(output).toContain(
      "| feature/report-polish | 2026-09-01T14:00:00.000Z | 2026-09-01T14:00:00.000Z | 0h 0m | 1 | 1 |",
    );
    expect(output).toContain(
      "| main | 2026-09-01T02:30:00.000Z | 2026-09-01T02:30:00.000Z | 0h 0m | 1 | 0 |",
    );

    database.close();
  });

  test("branch inference ignores pull/N/head and tag refs when a real branch is present", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    seedReportFixtures(database);

    // `branches` holds every ref containing the commit, so a mirror clone contributes
    // `pull/N/head` refs and tags. Both are longer than the real branch name here, so the
    // longest-wins rule would pick one of them if they were not filtered out first.
    database.exec(
      `INSERT INTO gh_commits (sha, repo, branches, author_name, author_email, authored_at, committed_at, subject, body, files_changed, insertions, deletions)
       VALUES ('ccccccc3333333333333333333333333333333', 'acme/widgets', '["fix/x", "pull/1234/head", "tags/v1.2.3-release"]', 'Octo Cat', 'octocat@example.com', '2026-09-01T15:30:00.000Z', '2026-09-01T15:30:00.000Z', 'fix(widgets): narrow ref set', NULL, 1, 1, 1)`,
    );

    const output = projectReport.render(database, REPORT_CONFIG, {
      from: "2026-08-31",
      to: "2026-09-02",
      project: "widgets",
    });

    expect(output).toContain("| fix/x |");
    expect(output).not.toContain("pull/1234/head");
    expect(output).not.toContain("tags/v1.2.3-release");

    database.close();
  });

  test("branch inference falls back to a pull ref when no real branch contains the commit", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    seedReportFixtures(database);

    // A merged PR whose source branch was deleted leaves the commit on `pull/N/head`
    // only. The row still has to name something, so the pull ref is used as a fallback.
    database.exec(
      `INSERT INTO gh_commits (sha, repo, branches, author_name, author_email, authored_at, committed_at, subject, body, files_changed, insertions, deletions)
       VALUES ('ddddddd4444444444444444444444444444444', 'acme/widgets', '["pull/77/head"]', 'Octo Cat', 'octocat@example.com', '2026-09-01T16:30:00.000Z', '2026-09-01T16:30:00.000Z', 'fix(widgets): orphaned pull ref', NULL, 1, 1, 1)`,
    );

    const output = projectReport.render(database, REPORT_CONFIG, {
      from: "2026-08-31",
      to: "2026-09-02",
      project: "widgets",
    });

    expect(output).toContain("| pull/77/head |");

    database.close();
  });

  test("an empty range still renders a title line and a no-evidence line, never an empty string", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    // no seed: empty database

    const output = projectReport.render(database, REPORT_CONFIG, {
      from: "2026-09-01",
      to: "2026-09-01",
    });

    expect(output).toBe("# project report 2026-09-01 to 2026-09-01\n\nno evidence");
    expect(output.length).toBeGreaterThan(0);

    database.close();
  });
});
