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
  previousTrace: { activityId: "A1", what: "fixing walk order", questId: "Q1" },
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
      isSwitch: true,
      trigger: "what does Astryx do for agents?",
      confidence: 0.6,
      questions: ["which_quest"],
    },
  ],
};

describe("applyResult", () => {
  test("reuses activity, opens new unconfirmed quest, branches, watches question", () => {
    const database = openDatabase(":memory:");
    const { store } = seed(database);

    const summary = applyResult(store, database, window, good, {
      actor: "hook",
      askingEnabled: true,
      now: "2026-09-04T15:21:00.000Z",
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
          isSwitch: true,
          trigger: "let me check email real quick",
          confidence: 0.5,
          questions: [],
        },
      ],
    };

    const summary = applyResult(store, database, window, chained, {
      actor: "hook",
      askingEnabled: false,
      now: "2026-09-04T15:31:00.000Z",
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
    });

    const count = database.query("SELECT COUNT(*) as count FROM questions").get() as {
      count: number;
    };
    expect(count.count).toBe(0);
  });
});
