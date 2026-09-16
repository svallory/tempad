import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/database.ts";
import { stateImpact } from "../src/intent/api.ts";
import { EventStore } from "../src/intent/store.ts";
import { dailyReport } from "../src/report/daily.ts";
import { projectReport } from "../src/report/project.ts";
import { REPORT_CONFIG, seedReportFixtures } from "./fixtures/report-golden/seed.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tempad-report-impact-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("impact rendering", () => {
  test("daily report falls back to the commit subject when no impact is stated", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    seedReportFixtures(database);
    // seedReportFixtures already states an impact for the second commit; the
    // first (aaaaaaa...) has none and must fall back to its subject.
    const output = dailyReport.render(database, REPORT_CONFIG, {
      from: "2026-08-31",
      to: "2026-08-31",
    });
    expect(output).toContain("aaaaaaa fix(widgets): handle midnight boundary");
    database.close();
  });

  test("daily report renders the impact text and theme for a PR when one is stated", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    seedReportFixtures(database);
    const store = new EventStore(database);
    stateImpact(store, database, {
      subject: "pr:acme/widgets#42",
      text: "Reports are now easier for clients to read",
      theme: "feature",
      hero: "hero",
    });
    const output = dailyReport.render(database, REPORT_CONFIG, {
      from: "2026-09-01",
      to: "2026-09-01",
    });
    expect(output).toContain("#42 [feature] Reports are now easier for clients to read, opened");
    database.close();
  });

  test("daily report renders the impact text and theme for a Monday item when one is stated", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    seedReportFixtures(database);
    const store = new EventStore(database);
    stateImpact(store, database, {
      subject: "monday:901",
      text: "Clients can now track ship progress at a glance",
      theme: "feature",
      hero: "hero",
    });
    const output = dailyReport.render(database, REPORT_CONFIG, {
      from: "2026-09-01",
      to: "2026-09-01",
    });
    expect(output).toContain(
      "[feature] Clients can now track ship progress at a glance, timeline 2026-09-01 to 2026-09-02",
    );
    database.close();
  });

  test("daily report renders the impact text and theme for a session when one is stated", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    seedReportFixtures(database);
    database.exec(
      `INSERT INTO claude_sessions (id, claude_dir, project_dir, file_path, cwd, org, project, path_meta, title, title_source, git_branch, started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
       VALUES ('3d4f5a96-77fa-478a-accc-d804f2fad104', '~/.claude', '-Users-octocat-work-acme-widgets', '/tmp/session-2.jsonl', '/Users/octocat/work/acme/widgets', 'acme', 'widgets', NULL, 'Ops session on Coolify', 'custom-title', 'main', '2026-09-01T16:00:00.000Z', '2026-09-01T17:00:00.000Z', 2, 0, '["sonnet"]', 'test-host', '2026-09-01T17:00:00.000Z')`,
    );
    const store = new EventStore(database);
    stateImpact(store, database, {
      subject: "session:3d4f5a96-77fa-478a-accc-d804f2fad104",
      text: "Restored production access after outage",
      theme: "fix",
      hero: "hero",
    });
    const output = dailyReport.render(database, REPORT_CONFIG, {
      from: "2026-09-01",
      to: "2026-09-01",
    });
    expect(output).toContain(
      "- [fix] Restored production access after outage, 13:00 to 14:00, 2 messages",
    );
    database.close();
  });

  test("daily report renders a session's impact as its own line even when the session has no custom title", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    seedReportFixtures(database);
    database.exec(
      `INSERT INTO claude_sessions (id, claude_dir, project_dir, file_path, cwd, org, project, path_meta, title, title_source, git_branch, started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
       VALUES ('3d4f5a96-77fa-478a-accc-d804f2fad104', '~/.claude', '-Users-octocat-work-acme-widgets', '/tmp/session-2.jsonl', '/Users/octocat/work/acme/widgets', 'acme', 'widgets', NULL, 'generic session title', 'generated', 'main', '2026-09-01T16:00:00.000Z', '2026-09-01T17:00:00.000Z', 2, 0, '["sonnet"]', 'test-host', '2026-09-01T17:00:00.000Z')`,
    );
    const store = new EventStore(database);
    stateImpact(store, database, {
      subject: "session:3d4f5a96-77fa-478a-accc-d804f2fad104",
      text: "Restored production access after outage",
      theme: "fix",
      hero: "hero",
    });
    const output = dailyReport.render(database, REPORT_CONFIG, {
      from: "2026-09-01",
      to: "2026-09-01",
    });
    expect(output).toContain(
      "- [fix] Restored production access after outage, 13:00 to 14:00, 2 messages",
    );
    expect(output).not.toContain("untitled sessions");
    database.close();
  });

  test("project report falls back to the branch label when the commit has no impact", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    seedReportFixtures(database);
    const output = projectReport.render(database, REPORT_CONFIG, {
      from: "2026-08-31",
      to: "2026-09-02",
    });
    expect(output).toContain("| main | 2026-08-31 23:30 |");
    database.close();
  });
});
