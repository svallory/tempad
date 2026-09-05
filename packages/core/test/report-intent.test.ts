import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/database.ts";
import {
  queryActivities,
  queryOpenQuestions,
  queryQuests,
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

describe("queryQuests", () => {
  test("an activity whose only trace matches the SQL range but clips to zero width is dropped, not a crash", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    seedReportFixtures(database);

    // The day's start boundary is "2026-09-01T03:00:00.000Z". A trace ending
    // at "2026-09-01T03:00:00Z" (no milliseconds) is lexically greater than
    // that string, so queryTraceIntervals' SQL WHERE (`t.ended_at > start`)
    // includes it -- but as an actual instant it equals `start`, so the
    // numeric clip in clippedEvidenceByActivity skips it entirely, leaving
    // the activity with zero evidence.
    database.exec(
      `INSERT INTO quests (id, owner_kind, owner_id, title, objective, confirmed, revision, state, created_at)
       VALUES ('quest-4', 'hero', 'hero-1', 'Edge quest', 'zero-width edge case', 1, 1, 'started', '2026-09-01T02:00:00.000Z')`,
    );
    database.exec(
      `INSERT INTO activities (id, quest_id, objective, opened_at, closed_at, outcome, revision)
       VALUES ('activity-4', 'quest-4', 'edge activity', '2026-09-01T02:00:00.000Z', '2026-09-01T03:00:00.000Z', NULL, 1)`,
    );
    database.exec(
      `INSERT INTO traces (id, activity_id, tool, place, source, source_ref, started_at, ended_at, who, what, why, where_text, how, confidence, classified_by, session_id, recorded_at)
       VALUES ('trace-5', 'activity-4', 'edit', '/Users/octocat/work/acme/widgets', 'session', 'session-1', '2026-09-01T02:00:00.000Z', '2026-09-01T03:00:00Z', 'hero-1', 'edge edit', 'edge case', '/Users/octocat/work/acme/widgets', 'assistant edit', 0.9, 'model', 'session-1', '2026-09-01T03:00:00.000Z')`,
    );
    database.exec(
      `INSERT INTO trace_links (trace_id, activity_id, linked_at, superseded_at, reason)
       VALUES ('trace-5', 'activity-4', '2026-09-01T03:00:00.000Z', NULL, NULL)`,
    );

    expect(() => queryQuests(database, RANGE)).not.toThrow();
    const quests = queryQuests(database, RANGE);
    expect(quests.find((quest) => quest.id === "quest-4")).toBeUndefined();

    database.close();
  });

  test("first/last evidence come from trace intervals, not activity opened_at/closed_at", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    seedReportFixtures(database);

    // activity-3 opens well before and closes well after its only trace --
    // evidence must reflect the trace, not the activity's own timestamps.
    database.exec(
      `INSERT INTO quests (id, owner_kind, owner_id, title, objective, confirmed, revision, state, created_at)
       VALUES ('quest-3', 'hero', 'hero-1', 'Third quest', 'wide activity window', 1, 1, 'started', '2026-09-01T08:00:00.000Z')`,
    );
    database.exec(
      `INSERT INTO activities (id, quest_id, objective, opened_at, closed_at, outcome, revision)
       VALUES ('activity-3', 'quest-3', 'wide window activity', '2026-09-01T08:00:00.000Z', '2026-09-01T20:00:00.000Z', NULL, 1)`,
    );
    database.exec(
      `INSERT INTO traces (id, activity_id, tool, place, source, source_ref, started_at, ended_at, who, what, why, where_text, how, confidence, classified_by, session_id, recorded_at)
       VALUES ('trace-4', 'activity-3', 'edit', '/Users/octocat/work/acme/widgets', 'session', 'session-1', '2026-09-01T15:00:00.000Z', '2026-09-01T15:10:00.000Z', 'hero-1', 'brief edit', 'quick fix', '/Users/octocat/work/acme/widgets', 'assistant edit', 0.9, 'model', 'session-1', '2026-09-01T15:10:00.000Z')`,
    );
    database.exec(
      `INSERT INTO trace_links (trace_id, activity_id, linked_at, superseded_at, reason)
       VALUES ('trace-4', 'activity-3', '2026-09-01T15:10:00.000Z', NULL, NULL)`,
    );

    const quests = queryQuests(database, RANGE);
    const quest3 = quests.find((quest) => quest.id === "quest-3");

    expect(quest3).toBeDefined();
    expect(quest3?.firstEvidence).toBe("2026-09-01T15:00:00.000Z");
    expect(quest3?.lastEvidence).toBe("2026-09-01T15:10:00.000Z");

    database.close();
  });

  test("evidence is clipped to the query range, not the trace's own full bounds", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    seedReportFixtures(database);

    // trace-1 runs 12:15-12:40Z; querying only 2026-08-31 to 2026-08-31
    // (before the trace starts) must yield no quest-1 row at all -- the
    // range must genuinely gate first/lastEvidence, not just relabel the
    // trace's own timestamps.
    const outOfRange = queryQuests(database, { ...RANGE, from: "2026-08-31", to: "2026-08-31" });
    expect(outOfRange.find((quest) => quest.id === "quest-1")).toBeUndefined();

    database.close();
  });

  test("--client excludes a quest whose traces belong to another client's session", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    seedReportFixtures(database);

    // quest-1's traces are all linked to session-1, which has no client in
    // path_meta -- filtering by any client must drop it.
    const filteredOut = queryQuests(database, { ...RANGE, client: "liuna" });
    expect(filteredOut.find((quest) => quest.id === "quest-1")).toBeUndefined();

    // Give session-1 a client and confirm quest-1 comes back through that
    // filter, proving the client actually threads down to trace resolution.
    database.exec(
      `UPDATE claude_sessions SET path_meta = '{"client":"liuna"}' WHERE id = 'session-1'`,
    );
    const filteredIn = queryQuests(database, { ...RANGE, client: "liuna" });
    expect(filteredIn.find((quest) => quest.id === "quest-1")).toBeDefined();

    const wrongClient = queryQuests(database, { ...RANGE, client: "other" });
    expect(wrongClient.find((quest) => quest.id === "quest-1")).toBeUndefined();

    database.close();
  });
});
