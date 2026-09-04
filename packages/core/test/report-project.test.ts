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
