import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/database.ts";
import { weeklyReport } from "../src/report/weekly.ts";
import { REPORT_CONFIG, seedReportFixtures } from "./fixtures/report-golden/seed.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tempad-report-weekly-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("weeklyReport", () => {
  test("matches golden output byte for byte", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    seedReportFixtures(database);

    const output = weeklyReport.render(database, REPORT_CONFIG, {
      from: "2026-08-31",
      to: "2026-09-04",
    });

    const golden = readFileSync(join(import.meta.dir, "fixtures/report-golden/weekly.md"), "utf8");
    expect(output).toBe(golden);

    database.close();
  });

  test("the weekly table gains a doubts column sourced from belongs questions in range", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    seedReportFixtures(database);

    database.exec(
      `INSERT INTO questions (id, trace_id, session_id, text, kind, state, turns_watched)
       VALUES ('question-belongs-1', 'trace-1', 'session-1', 'does this belong?', 'belongs', 'watching', 1)`,
    );

    const output = weeklyReport.render(database, REPORT_CONFIG, {
      from: "2026-08-31",
      to: "2026-09-04",
    });

    expect(output).toContain("doubts");
    const row = output.split("\n").find((line) => line.includes("acme/widgets"));
    expect(row).toContain("| 1 |");

    database.close();
  });

  test("the weekly table gains a short work column sourced from dismissed-stint minutes", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    seedReportFixtures(database);

    database.exec(
      `INSERT INTO stints (id, quest_id, outcome, opened_at, closed_at, dismissed_at, revision)
       VALUES ('stint-dismissed', 'quest-1', 'quick check', '2026-09-01T14:00:00.000Z', '2026-09-01T14:02:00.000Z', '2026-09-01T14:02:00.000Z', 1)`,
    );
    database.exec(
      `INSERT INTO traces (id, stint_id, tool, place, source, source_ref, started_at, ended_at, who, what, why, where_text, how, confidence, classified_by, session_id, recorded_at)
       VALUES ('trace-dismissed', 'stint-dismissed', 'edit', '/Users/octocat/work/acme/widgets', 'session', 'session-1', '2026-09-01T14:00:00.000Z', '2026-09-01T14:02:00.000Z', 'hero-1', 'quick check', 'below minimum', '/Users/octocat/work/acme/widgets', 'assistant edit', 0.9, 'model', 'session-1', '2026-09-01T14:02:00.000Z')`,
    );
    database.exec(
      `INSERT INTO trace_links (trace_id, stint_id, linked_at, superseded_at, reason)
       VALUES ('trace-dismissed', 'stint-dismissed', '2026-09-01T14:02:00.000Z', NULL, NULL)`,
    );

    const output = weeklyReport.render(database, REPORT_CONFIG, {
      from: "2026-08-31",
      to: "2026-09-04",
    });

    expect(output).toContain("short work");
    const row = output.split("\n").find((line) => line.includes("acme/widgets"));
    expect(row).toContain("0h 2m");

    database.close();
  });

  test("a weekday with no evidence prints no evidence, an empty weekend day is skipped", () => {
    const database = openDatabase(join(dir, "tempad.db"));

    const output = weeklyReport.render(database, REPORT_CONFIG, {
      from: "2026-09-03",
      to: "2026-09-06",
    });

    expect(output).toContain("## 2026-09-03 (Thursday)");
    expect(output).toContain("no evidence");
    expect(output).not.toContain("## 2026-09-05");
    expect(output).not.toContain("## 2026-09-06");

    database.close();
  });

  test("an empty database renders a title and no Week table", () => {
    const database = openDatabase(join(dir, "tempad.db"));

    const output = weeklyReport.render(database, REPORT_CONFIG, {
      from: "2026-09-05",
      to: "2026-09-05",
    });

    expect(output).toContain("# weekly report 2026-09-05 to 2026-09-05");
    expect(output).not.toContain("## Week");

    database.close();
  });
});
