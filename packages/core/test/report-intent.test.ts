import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/database.ts";
import { declareQuest } from "../src/intent/declarations.ts";
import { newUlid } from "../src/intent/ids.ts";
import { applyIncremental } from "../src/intent/projections/index.ts";
import { EventStore } from "../src/intent/store.ts";
import {
  attributeNonClaudeEvidence,
  queryStints,
  queryOpenQuestions,
  queryQuests,
  querySideQuestDoubts,
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

    const stints = queryStints(database, RANGE);
    const main = stints.find((stint) => stint.id === "activity-1");

    expect(main).toBeDefined();
    expect(main?.questTitle).toBe("Polish the report output");
    expect(main?.questConfirmed).toBe(true);
    expect(main?.org).toBe("acme");
    expect(main?.project).toBe("widgets");
    expect(main?.minutes).toBe(70);
    expect(main?.questOriginKind).toBe("inferred");

    database.close();
  });

  test("returns the side quest's activity as unconfirmed", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    seedReportFixtures(database);

    const stints = queryStints(database, RANGE);
    const side = stints.find((stint) => stint.id === "activity-2");

    expect(side?.questConfirmed).toBe(false);
    expect(side?.minutes).toBe(20);

    database.close();
  });

  test("excludes activities outside the range", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    seedReportFixtures(database);

    const stints = queryStints(database, {
      ...RANGE,
      from: "2026-09-02",
      to: "2026-09-02",
    });
    expect(stints).toHaveLength(0);

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
    expect(sideQuest?.fromStintAim).toBe("polish daily/hourly report output");
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

  test("carries the quest's origin_kind", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    seedReportFixtures(database);

    const quests = queryQuests(database, RANGE);
    const quest1 = quests.find((quest) => quest.id === "quest-1");
    expect(quest1?.originKind).toBe("inferred");

    database.close();
  });
});

describe("attributeNonClaudeEvidence", () => {
  test("attributes a commit to the declaring session active at authored_at, and leaves an unmatched commit unattributed", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    seedReportFixtures(database);

    const store = new EventStore(database);
    const heroId = newUlid();
    applyIncremental(
      database,
      store.append({
        actor: "hero",
        kind: "hero.created",
        subject: heroId,
        payload: { name: "Saulo" },
      }),
    );
    declareQuest(store, database, {
      sessionId: "session-1",
      newQuest: { title: "Ship p", aim: "ship it", commitment: "personal" },
      plan: [],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-01T12:00:00.000Z",
      heroId,
    });

    // "bbbbbbb2222..." (authored 2026-09-01T14:00Z) falls outside session-1's
    // 12:15Z-13:45Z window, so it has no overlapping session and stays
    // unattributed.
    database.exec(
      `INSERT INTO gh_commits (sha, repo, branches, author_name, author_email, authored_at, committed_at, subject, body, files_changed, insertions, deletions)
       VALUES ('ccccccc9999999999999999999999999999999', 'acme/widgets', '["feature/report-polish"]', 'Octo Cat', 'octocat@example.com', '2026-09-01T12:30:00.000Z', '2026-09-01T12:30:00.000Z', 'feat(widgets): inside declared window', NULL, 1, 1, 1)`,
    );

    const rows = attributeNonClaudeEvidence(database, {
      from: "2026-09-01",
      to: "2026-09-01",
      timeZone: REPORT_CONFIG.tz,
    });

    const inRange = rows.find((row) => row.id === "ccccccc9999999999999999999999999999999");
    expect(inRange?.questTitle).toBe("Ship p");

    const noSession = rows.find((row) => row.id === "bbbbbbb2222222222222222222222222222222");
    expect(noSession?.questId).toBeNull();

    database.close();
  });

  test("a commit inside an overlapping session's window is unattributed when that session never declared", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    seedReportFixtures(database);

    // session-1 overlaps this commit's authored_at (12:30Z, inside 12:15-13:45Z)
    // but has no quest.declared event at all, so attribution must stay null.
    database.exec(
      `INSERT INTO gh_commits (sha, repo, branches, author_name, author_email, authored_at, committed_at, subject, body, files_changed, insertions, deletions)
       VALUES ('ddddddd8888888888888888888888888888888', 'acme/widgets', '["feature/report-polish"]', 'Octo Cat', 'octocat@example.com', '2026-09-01T12:30:00.000Z', '2026-09-01T12:30:00.000Z', 'feat(widgets): no declaration yet', NULL, 1, 1, 1)`,
    );

    const rows = attributeNonClaudeEvidence(database, {
      from: "2026-09-01",
      to: "2026-09-01",
      timeZone: REPORT_CONFIG.tz,
    });

    const row = rows.find((r) => r.id === "ddddddd8888888888888888888888888888888");
    expect(row?.questId).toBeNull();
    expect(row?.questTitle).toBeNull();

    database.close();
  });

  test("tie rule: when two sessions in the same org/project overlap a commit, the latest-started session's declaration wins", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    seedReportFixtures(database);

    // session-1 (seeded) runs 12:15Z-13:45Z. Add a second, later-started
    // session in the same org/project that also overlaps 12:30Z.
    database.exec(
      `INSERT INTO claude_sessions (id, claude_dir, project_dir, file_path, cwd, org, project, path_meta, title, git_branch, started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
       VALUES ('session-later', '~/.claude', 'dir', '/tmp/session-later.jsonl', NULL, 'acme', 'widgets', NULL, 'later session', NULL, '2026-09-01T12:20:00.000Z', '2026-09-01T13:00:00.000Z', 1, 0, '[]', 'test-host', '2026-09-01T13:00:00.000Z')`,
    );

    const store = new EventStore(database);
    const heroId = newUlid();
    applyIncremental(
      database,
      store.append({
        actor: "hero",
        kind: "hero.created",
        subject: heroId,
        payload: { name: "Saulo" },
      }),
    );
    declareQuest(store, database, {
      sessionId: "session-1",
      newQuest: { title: "Early quest", aim: "early", commitment: "personal" },
      plan: [],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-01T12:00:00.000Z",
      heroId,
    });
    declareQuest(store, database, {
      sessionId: "session-later",
      newQuest: { title: "Late quest", aim: "late", commitment: "personal" },
      plan: [],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-01T12:21:00.000Z",
      heroId,
    });

    database.exec(
      `INSERT INTO gh_commits (sha, repo, branches, author_name, author_email, authored_at, committed_at, subject, body, files_changed, insertions, deletions)
       VALUES ('eeeeeee7777777777777777777777777777777', 'acme/widgets', '["feature/report-polish"]', 'Octo Cat', 'octocat@example.com', '2026-09-01T12:30:00.000Z', '2026-09-01T12:30:00.000Z', 'feat(widgets): tied overlap', NULL, 1, 1, 1)`,
    );

    const rows = attributeNonClaudeEvidence(database, {
      from: "2026-09-01",
      to: "2026-09-01",
      timeZone: REPORT_CONFIG.tz,
    });

    const row = rows.find((r) => r.id === "eeeeeee7777777777777777777777777777777");
    expect(row?.questTitle).toBe("Late quest");

    database.close();
  });
});

describe("querySideQuestDoubts", () => {
  test("counts 'belongs' questions tied to a trace/session in range", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    seedReportFixtures(database);

    database.exec(
      `INSERT INTO questions (id, trace_id, session_id, text, kind, state, turns_watched)
       VALUES ('question-belongs-1', 'trace-1', 'session-1', 'does this belong to the declared quest?', 'belongs', 'watching', 1)`,
    );

    expect(querySideQuestDoubts(database, RANGE)).toBe(1);

    database.close();
  });

  test("is zero outside the range", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    seedReportFixtures(database);

    database.exec(
      `INSERT INTO questions (id, trace_id, session_id, text, kind, state, turns_watched)
       VALUES ('question-belongs-1', 'trace-1', 'session-1', 'does this belong to the declared quest?', 'belongs', 'watching', 1)`,
    );

    expect(querySideQuestDoubts(database, { ...RANGE, from: "2026-09-02", to: "2026-09-02" })).toBe(
      0,
    );

    database.close();
  });
});
