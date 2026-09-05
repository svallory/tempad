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
