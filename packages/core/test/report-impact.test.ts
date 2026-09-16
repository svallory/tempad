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
