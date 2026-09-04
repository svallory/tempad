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
