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
    expect(output).not.toContain("2026-09-05");
    expect(output).not.toContain("2026-09-06");

    database.close();
  });
});
