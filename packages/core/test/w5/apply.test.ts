import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db/database";
import { newUlid } from "../../src/intent/ids";
import { applyIncremental, ensureTables } from "../../src/intent/projections";
import { registerAllProjections } from "../../src/intent/projections/register";
import { EventStore } from "../../src/intent/store";
import { applyResult } from "../../src/w5/apply";
import type { ClassifierResult, ClassifierWindow } from "../../src/w5/classifier";

registerAllProjections();

function seed(database: ReturnType<typeof openDatabase>) {
  ensureTables(database);
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
  const questId = "Q1";
  database
    .query(
      "INSERT INTO quests (id, owner_kind, owner_id, title, objective, confirmed, revision, state, created_at) VALUES (?, 'hero', ?, 'Ship marko-ui', '86 components', 1, 1, 'started', '2026-09-01T00:00:00.000Z')",
    )
    .run(questId, heroId);
  database
    .query(
      "INSERT INTO activities (id, quest_id, objective, opened_at, revision) VALUES ('A1', ?, 'fixing walk order', '2026-09-04T14:00:00.000Z', 1)",
    )
    .run(questId);
  database
    .query(
      `INSERT INTO traces (id, activity_id, tool, place, source, started_at, ended_at, who, what, why, where_text, how, confidence, classified_by, session_id, recorded_at)
       VALUES ('T0', 'A1', 'claude-code', 'marko-ui', 'session', '2026-09-04T14:00:00.000Z', '2026-09-04T14:30:00.000Z', 'hero', 'fixing walk order', 'ship', 'personal/marko-ui', 'claude-code', 0.9, 'assistant', 's1', '2026-09-04T14:30:00.000Z')`,
    )
    .run();
  return { store, heroId, questId };
}

const window: ClassifierWindow = {
  sessionId: "s1",
  title: "marko-ui",
  cwd: "/w/marko-ui",
  gitBranch: "main",
  org: "personal",
  project: "marko-ui",
  messages: [],
  openQuests: [
    { id: "Q1", title: "Ship marko-ui", objective: "86 components", lastActivityAt: null },
  ],
  sessionOpenActivities: [
    {
      activityId: "A1",
      what: "fixing walk order",
      why: "ship",
      questId: "Q1",
      questTitle: "Ship marko-ui",
      openedAt: "2026-09-04T14:00:00.000Z",
      lastTraceEndedAt: "2026-09-04T14:30:00.000Z",
    },
  ],
  recentActivities: [],
  recentSideQuests: [],
  overlapMessages: [],
  previousSessionNote: null,
};

const good: ClassifierResult = {
  segments: [
    {
      startedAt: "2026-09-04T15:00:00.000Z",
      endedAt: "2026-09-04T15:20:00.000Z",
      what: "fix walk order",
      why: "ship marko-ui",
      matchedQuest: "Q1",
      proposedQuest: null,
      matchedActivity: "A1",
      continuesActivity: null,
      newActivityReason: null,
      isSwitch: false,
      trigger: null,
      confidence: 0.9,
      questions: [],
    },
    {
      startedAt: "2026-09-04T15:20:00.000Z",
      endedAt: "2026-09-04T15:20:00.000Z",
      what: "compare Astryx",
      why: "unknown",
      matchedQuest: null,
      proposedQuest: {
        title: "Compare Astryx",
        objective: "see what they claim",
        commitment: "exploratory",
      },
      matchedActivity: null,
      continuesActivity: null,
      newActivityReason: "a comparison unrelated to the walk order work",
      isSwitch: true,
      trigger: "what does Astryx do for agents?",
      confidence: 0.6,
      questions: ["which_quest"],
    },
  ],
  sessionNote: null,
};

const [baseMatched, baseNew] = good.segments as [
  (typeof good.segments)[number],
  (typeof good.segments)[number],
];

describe("applyResult", () => {
  test("reuses activity, opens new unconfirmed quest, branches, watches question", () => {
    const database = openDatabase(":memory:");
    const { store } = seed(database);

    const summary = applyResult(store, database, window, good, {
      actor: "hook",
      askingEnabled: true,
      now: "2026-09-04T15:21:00.000Z",
      log: () => {},
    });

    expect(summary.traces).toBe(2);
    expect(summary.activitiesOpened).toBe(1);
    expect(summary.questsProposed).toBe(1);
    expect(summary.branches).toBe(1);
    expect(summary.questionsWatching).toBe(1);

    const traceRows = database
      .query("SELECT activity_id FROM traces ORDER BY recorded_at")
      .all() as {
      activity_id: string;
    }[];
    expect(traceRows[0]?.activity_id).toBe("A1");
    expect(traceRows).toHaveLength(3);

    const appliedSources = database
      .query("SELECT DISTINCT source FROM traces WHERE id != 'T0'")
      .all() as { source: string }[];
    expect(appliedSources.map((row) => row.source)).toEqual(["session"]);

    const newQuest = database
      .query("SELECT title, confirmed, trigger FROM quests WHERE title = 'Compare Astryx'")
      .get() as { title: string; confirmed: number; trigger: string | null };
    expect(newQuest.confirmed).toBe(0);
    expect(newQuest.trigger).toBe("what does Astryx do for agents?");

    const question = database.query("SELECT state FROM questions").get() as { state: string };
    expect(question.state).toBe("watching");
  });

  test("a switch between segment 2 and 3 branches from segment 2's activity, not window.previousTrace", () => {
    const database = openDatabase(":memory:");
    const { store } = seed(database);

    const chained: ClassifierResult = {
      segments: [
        {
          startedAt: "2026-09-04T15:00:00.000Z",
          endedAt: "2026-09-04T15:10:00.000Z",
          what: "compare Astryx",
          why: "unknown",
          matchedQuest: null,
          proposedQuest: {
            title: "Compare Astryx",
            objective: "see what they claim",
            commitment: "exploratory",
          },
          matchedActivity: null,
          continuesActivity: null,
          newActivityReason: "a comparison unrelated to the walk order work",
          isSwitch: true,
          trigger: "what does Astryx do for agents?",
          confidence: 0.6,
          questions: [],
        },
        {
          startedAt: "2026-09-04T15:10:00.000Z",
          endedAt: "2026-09-04T15:20:00.000Z",
          what: "read Astryx docs",
          why: "unknown",
          matchedQuest: null,
          proposedQuest: null,
          matchedActivity: null,
          continuesActivity: null,
          newActivityReason: "still reading docs on the new topic",
          isSwitch: false,
          trigger: null,
          confidence: 0.7,
          questions: [],
        },
        {
          startedAt: "2026-09-04T15:20:00.000Z",
          endedAt: "2026-09-04T15:30:00.000Z",
          what: "check email",
          why: "unknown",
          matchedQuest: null,
          proposedQuest: {
            title: "Check email",
            objective: "clear inbox",
            commitment: "personal",
          },
          matchedActivity: null,
          continuesActivity: null,
          newActivityReason: "an unrelated personal errand",
          isSwitch: true,
          trigger: "let me check email real quick",
          confidence: 0.5,
          questions: [],
        },
      ],
      sessionNote: null,
    };

    const summary = applyResult(store, database, window, chained, {
      actor: "hook",
      askingEnabled: false,
      now: "2026-09-04T15:31:00.000Z",
      log: () => {},
    });

    // Two switches happened (Q1 -> Compare Astryx, Compare Astryx -> Check email).
    // With the bug (comparing against the static window.previousTrace = A1/Q1),
    // only one branch would be recorded because segment 3's questId (Check email)
    // differs from A1's quest (Q1) too, but the branch's from_activity would
    // wrongly point at A1 instead of the activity opened for segment 1/2.
    expect(summary.branches).toBe(2);

    const secondActivity = database
      .query("SELECT id FROM activities WHERE objective = 'read Astryx docs'")
      .get() as { id: string };
    const emailQuest = database
      .query("SELECT id, origin_activity_id FROM quests WHERE title = 'Check email'")
      .get() as { id: string; origin_activity_id: string };

    expect(emailQuest.origin_activity_id).toBe(secondActivity.id);
  });

  test("askingEnabled false records no question row", () => {
    const database = openDatabase(":memory:");
    const { store } = seed(database);

    applyResult(store, database, window, good, {
      actor: "backfill",
      askingEnabled: false,
      now: "2026-09-04T15:21:00.000Z",
      log: () => {},
    });

    const count = database.query("SELECT COUNT(*) as count FROM questions").get() as {
      count: number;
    };
    expect(count.count).toBe(0);
  });

  test("matchedActivity with a conflicting quest keeps the activity's quest and counts a conflict", () => {
    const database = openDatabase(":memory:");
    const { store, heroId } = seed(database);
    database
      .query(
        "INSERT INTO quests (id, owner_kind, owner_id, title, objective, confirmed, revision, state, created_at) VALUES ('Q9', 'hero', ?, 'Other quest', 'other', 1, 1, 'started', '2026-09-01T00:00:00.000Z')",
      )
      .run(heroId);

    const conflicting: ClassifierResult = {
      segments: [
        {
          ...baseMatched,
          matchedQuest: "Q9",
          matchedActivity: "A1",
          continuesActivity: null,
          newActivityReason: null,
        },
      ],
      sessionNote: null,
    };

    const logs: string[] = [];
    const summary = applyResult(store, database, window, conflicting, {
      actor: "hook",
      askingEnabled: false,
      now: "2026-09-04T15:21:00.000Z",
      log: (line) => logs.push(line),
    });

    expect(summary.questConflicts).toBe(1);
    expect(summary.activitiesOpened).toBe(0);
    expect(logs).toHaveLength(1);

    const activity = database.query("SELECT quest_id FROM activities WHERE id = 'A1'").get() as {
      quest_id: string;
    };
    expect(activity.quest_id).toBe("Q1");

    const trace = database.query("SELECT activity_id FROM traces WHERE id != 'T0'").get() as {
      activity_id: string;
    };
    expect(trace.activity_id).toBe("A1");
  });

  test("continuesActivity opens a new activity linked to the closed one, keeping its quest", () => {
    const database = openDatabase(":memory:");
    const { store } = seed(database);
    database
      .query(
        `INSERT INTO activities (id, quest_id, objective, opened_at, closed_at, close_reason, revision)
         VALUES ('A0', 'Q1', 'fixing walk order', '2026-09-04T10:00:00.000Z', '2026-09-04T11:00:00.000Z', 'session_end', 1)`,
      )
      .run();

    const continuing: ClassifierResult = {
      segments: [
        {
          ...baseMatched,
          matchedQuest: "Q1",
          matchedActivity: null,
          continuesActivity: "A0",
          newActivityReason: null,
        },
      ],
      sessionNote: null,
    };

    const summary = applyResult(store, database, window, continuing, {
      actor: "hook",
      askingEnabled: false,
      now: "2026-09-04T15:21:00.000Z",
      log: () => {},
    });

    expect(summary.activitiesOpened).toBe(1);
    expect(summary.questConflicts).toBe(0);

    const opened = database
      .query("SELECT id, quest_id, continues FROM activities WHERE continues IS NOT NULL")
      .get() as { id: string; quest_id: string | null; continues: string };
    expect(opened.continues).toBe("A0");
    expect(opened.quest_id).toBe("Q1");
  });

  test("a switch to a different activity closes the previous one with reason switch", () => {
    const database = openDatabase(":memory:");
    const { store } = seed(database);

    const switching: ClassifierResult = {
      segments: [
        {
          ...baseMatched,
          startedAt: "2026-09-04T15:00:00.000Z",
          endedAt: "2026-09-04T15:10:00.000Z",
          matchedQuest: "Q1",
          matchedActivity: "A1",
          continuesActivity: null,
          newActivityReason: null,
          isSwitch: false,
        },
        {
          ...baseNew,
          startedAt: "2026-09-04T15:10:00.000Z",
          endedAt: "2026-09-04T15:20:00.000Z",
          matchedActivity: null,
          continuesActivity: null,
          newActivityReason: "a different objective entirely",
          isSwitch: true,
          questions: [],
        },
      ],
      sessionNote: null,
    };

    applyResult(store, database, window, switching, {
      actor: "hook",
      askingEnabled: false,
      now: "2026-09-04T15:21:00.000Z",
      log: () => {},
    });

    const closed = database
      .query("SELECT closed_at, close_reason FROM activities WHERE id = 'A1'")
      .get() as { closed_at: string | null; close_reason: string | null };
    expect(closed.closed_at).toBe("2026-09-04T15:10:00.000Z");
    expect(closed.close_reason).toBe("switch");
  });

  test("a segment entirely inside the overlap range records no trace", () => {
    const database = openDatabase(":memory:");
    const { store } = seed(database);

    const overlapWindow: ClassifierWindow = {
      ...window,
      overlapMessages: [
        { ts: "2026-09-04T14:40:00.000Z", role: "user", text: "tail one" },
        { ts: "2026-09-04T14:50:00.000Z", role: "user", text: "tail two" },
      ],
    };

    const insideOverlap: ClassifierResult = {
      segments: [
        {
          ...baseMatched,
          startedAt: "2026-09-04T14:40:00.000Z",
          endedAt: "2026-09-04T14:50:00.000Z",
          matchedActivity: "A1",
          continuesActivity: null,
          newActivityReason: null,
        },
      ],
      sessionNote: null,
    };

    const summary = applyResult(store, database, overlapWindow, insideOverlap, {
      actor: "hook",
      askingEnabled: false,
      now: "2026-09-04T15:21:00.000Z",
      log: () => {},
    });

    expect(summary.traces).toBe(0);
    expect(summary.overlapDropped).toBe(1);
    const count = database.query("SELECT COUNT(*) as count FROM traces").get() as { count: number };
    expect(count.count).toBe(1);
  });

  test("matchedActivity naming an id absent from the slice opens a new activity and counts it", () => {
    const database = openDatabase(":memory:");
    const { store } = seed(database);

    const hallucinated: ClassifierResult = {
      segments: [{ ...baseMatched, matchedActivity: "A-does-not-exist", matchedQuest: "Q1" }],
      sessionNote: null,
    };

    const logs: string[] = [];
    const summary = applyResult(store, database, window, hallucinated, {
      actor: "hook",
      askingEnabled: false,
      now: "2026-09-04T15:21:00.000Z",
      log: (line) => logs.push(line),
    });

    expect(summary.unknownActivityIds).toBe(1);
    expect(summary.activitiesOpened).toBe(1);
    expect(summary.questConflicts).toBe(0);
    expect(logs).toHaveLength(1);

    const trace = database.query("SELECT activity_id FROM traces WHERE id != 'T0'").get() as {
      activity_id: string;
    };
    expect(trace.activity_id).not.toBe("A-does-not-exist");
  });

  test("matchedActivity naming an activity that is closed or retracted is not reused", () => {
    const database = openDatabase(":memory:");
    const { store } = seed(database);
    database
      .query(
        `INSERT INTO activities (id, quest_id, objective, opened_at, closed_at, close_reason, revision)
         VALUES ('A-closed', 'Q1', 'already finished', '2026-09-04T10:00:00.000Z', '2026-09-04T11:00:00.000Z', 'idle', 1)`,
      )
      .run();
    database
      .query(
        `INSERT INTO activities (id, quest_id, objective, opened_at, retracted_at, revision)
         VALUES ('A-retracted', 'Q1', 'wrong call', '2026-09-04T12:00:00.000Z', '2026-09-04T12:30:00.000Z', 1)`,
      )
      .run();

    const closedWindow: ClassifierWindow = {
      ...window,
      sessionOpenActivities: [
        ...window.sessionOpenActivities,
        {
          activityId: "A-retracted",
          what: "wrong call",
          why: "unknown",
          questId: "Q1",
          questTitle: "Ship marko-ui",
          openedAt: "2026-09-04T12:00:00.000Z",
          lastTraceEndedAt: "2026-09-04T12:30:00.000Z",
        },
      ],
    };

    const summary = applyResult(
      store,
      database,
      closedWindow,
      {
        segments: [
          { ...baseMatched, matchedActivity: "A-closed", matchedQuest: "Q1" },
          {
            ...baseNew,
            matchedActivity: "A-retracted",
            continuesActivity: null,
            newActivityReason: null,
            matchedQuest: "Q1",
            proposedQuest: null,
            isSwitch: false,
            questions: [],
          },
        ],
        sessionNote: null,
      },
      { actor: "hook", askingEnabled: false, now: "2026-09-04T15:21:00.000Z", log: () => {} },
    );

    expect(summary.unknownActivityIds).toBe(2);
    const reused = database
      .query(
        "SELECT COUNT(*) as count FROM traces WHERE activity_id IN ('A-closed', 'A-retracted')",
      )
      .get() as { count: number };
    expect(reused.count).toBe(0);
  });

  test("continuesActivity pointing at a still-open activity reuses it instead of opening a second", () => {
    const database = openDatabase(":memory:");
    const { store } = seed(database);

    const summary = applyResult(
      store,
      database,
      window,
      {
        segments: [
          { ...baseMatched, matchedActivity: null, continuesActivity: "A1", matchedQuest: "Q1" },
        ],
        sessionNote: null,
      },
      { actor: "hook", askingEnabled: false, now: "2026-09-04T15:21:00.000Z", log: () => {} },
    );

    // The objective never stopped, so this is a plain reuse: no new row, no continues link.
    expect(summary.activitiesOpened).toBe(0);
    expect(summary.unknownActivityIds).toBe(0);

    const activityCount = database.query("SELECT COUNT(*) as count FROM activities").get() as {
      count: number;
    };
    expect(activityCount.count).toBe(1);

    const trace = database.query("SELECT activity_id FROM traces WHERE id != 'T0'").get() as {
      activity_id: string;
    };
    expect(trace.activity_id).toBe("A1");
  });

  test("continuesActivity naming an unknown id opens a new activity with no continues link", () => {
    const database = openDatabase(":memory:");
    const { store } = seed(database);

    const summary = applyResult(
      store,
      database,
      window,
      {
        segments: [
          {
            ...baseMatched,
            matchedActivity: null,
            continuesActivity: "A-nope",
            matchedQuest: "Q1",
          },
        ],
        sessionNote: null,
      },
      { actor: "hook", askingEnabled: false, now: "2026-09-04T15:21:00.000Z", log: () => {} },
    );

    expect(summary.unknownActivityIds).toBe(1);
    expect(summary.activitiesOpened).toBe(1);

    const linked = database
      .query("SELECT COUNT(*) as count FROM activities WHERE continues IS NOT NULL")
      .get() as { count: number };
    expect(linked.count).toBe(0);
  });
});
