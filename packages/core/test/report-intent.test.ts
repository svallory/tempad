import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/database.ts";
import {
  queryActivities,
  queryOpenQuestions,
  querySideQuests,
} from "../src/report/intent-queries.ts";
import { REPORT_CONFIG, seedReportFixtures } from "./fixtures/report-golden/seed.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tempad-report-intent-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const RANGE = {
  from: "2026-09-01",
  to: "2026-09-01",
  timeZone: REPORT_CONFIG.tz,
};

describe("queryActivities", () => {
  test("returns the main activity with quest title, confirmation, resolved project and clipped minutes", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    seedReportFixtures(database);

    const activities = queryActivities(database, RANGE);
    const main = activities.find((activity) => activity.id === "activity-1");

    expect(main).toBeDefined();
    expect(main?.questTitle).toBe("Polish the report output");
    expect(main?.questConfirmed).toBe(true);
    expect(main?.org).toBe("acme");
    expect(main?.project).toBe("widgets");
    expect(main?.minutes).toBe(70);

    database.close();
  });

  test("returns the side quest's activity as unconfirmed", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    seedReportFixtures(database);

    const activities = queryActivities(database, RANGE);
    const side = activities.find((activity) => activity.id === "activity-2");

    expect(side?.questConfirmed).toBe(false);
    expect(side?.minutes).toBe(20);

    database.close();
  });

  test("excludes activities outside the range", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    seedReportFixtures(database);

    const activities = queryActivities(database, {
      ...RANGE,
      from: "2026-09-02",
      to: "2026-09-02",
    });
    expect(activities).toHaveLength(0);

    database.close();
  });
});

describe("querySideQuests", () => {
  test("returns the branched quest with its trigger and origin objective", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    seedReportFixtures(database);

    const sideQuests = querySideQuests(database, RANGE);
    expect(sideQuests).toHaveLength(1);
    const sideQuest = sideQuests[0];

    expect(sideQuest?.title).toBe("Investigate flaky commit grouping");
    expect(sideQuest?.trigger).toBe("noticed duplicate rebased commits during polish work");
    expect(sideQuest?.fromActivityObjective).toBe("polish daily/hourly report output");
    expect(sideQuest?.returnedAt).toBeNull();
    expect(sideQuest?.minutes).toBe(20);

    database.close();
  });
});

describe("queryOpenQuestions", () => {
  test("counts traces with an expired question or zero confidence", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    seedReportFixtures(database);

    expect(queryOpenQuestions(database, RANGE)).toBe(1);

    database.close();
  });

  test("is zero outside the range", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    seedReportFixtures(database);

    expect(queryOpenQuestions(database, { ...RANGE, from: "2026-09-02", to: "2026-09-02" })).toBe(
      0,
    );

    database.close();
  });
});
