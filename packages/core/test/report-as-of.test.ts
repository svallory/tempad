import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/database.ts";
import { dailyReport } from "../src/report/daily.ts";
import { REPORT_CONFIG, seedReportFixtures } from "./fixtures/report-golden/seed.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tempad-report-as-of-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("--as-of", () => {
  test("the report title gains a (as of <date>) suffix", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    seedReportFixtures(database);

    const output = dailyReport.render(database, REPORT_CONFIG, {
      from: "2026-09-01",
      to: "2026-09-01",
      asOf: "2026-09-01T12:00:00.000Z",
    });

    expect(output).toContain(
      "# daily report 2026-09-01 to 2026-09-01 (as of 2026-09-01T12:00:00.000Z)",
    );

    database.close();
  });

  test("without --as-of the title has no suffix", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    seedReportFixtures(database);

    const output = dailyReport.render(database, REPORT_CONFIG, {
      from: "2026-09-01",
      to: "2026-09-01",
    });

    expect(output).toContain("# daily report 2026-09-01 to 2026-09-01\n");
    expect(output).not.toContain("as of");

    database.close();
  });

  test("intent tables render from events, not from the live projections", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    // seedReportFixtures inserts quest/activity/trace rows directly into the
    // projection tables (see its docstring), not through events -- the same
    // shortcut every other report-golden fixture takes. `--as-of` replays
    // `events`, so it correctly sees none of that seeded intent data.
    seedReportFixtures(database);

    const output = dailyReport.render(database, REPORT_CONFIG, {
      from: "2026-09-01",
      to: "2026-09-01",
      asOf: "2026-09-01T13:00:00.000Z",
    });

    expect(output).not.toContain("Investigate flaky commit grouping");
    expect(output).not.toContain("Quests");
    // mirrors (commits, sessions, Monday items) are unaffected by --as-of
    expect(output).toContain("Polish report output, 09:15 to 10:45, 3 messages");

    database.close();
  });
});

describe("--client", () => {
  test("filters sessions to path_meta.client, unaffected sessions still show", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    seedReportFixtures(database);

    database.exec(
      `INSERT INTO claude_sessions (id, claude_dir, project_dir, file_path, cwd, org, project, path_meta, title, title_source, git_branch, started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
       VALUES ('session-liuna', '~/.claude', 'dir', '/tmp/session-liuna.jsonl', NULL, 'acme', 'widgets', '{"client":"liuna"}', 'client work', 'custom-title', NULL, '2026-09-01T14:00:00.000Z', '2026-09-01T14:30:00.000Z', 2, 0, '[]', 'test-host', '2026-09-01T14:30:00.000Z')`,
    );

    const filtered = dailyReport.render(database, REPORT_CONFIG, {
      from: "2026-09-01",
      to: "2026-09-01",
      client: "liuna",
    });
    expect(filtered).toContain("client work");
    expect(filtered).not.toContain("Polish report output, 09:15");

    database.close();
  });
});
