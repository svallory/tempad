import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db/database";
import type { W5Config } from "../../src/intent/config";
import { newUlid } from "../../src/intent/ids";
import { applyIncremental, ensureTables } from "../../src/intent/projections";
import { registerAllProjections } from "../../src/intent/projections/register";
import { EventStore } from "../../src/intent/store";
import { advanceQuestions } from "../../src/w5/questions";

registerAllProjections();

const config: W5Config = {
  model: "m",
  throttleMinutes: 10,
  watchTurns: 3,
  askMinActivityMinutes: 20,
  askBudgetMinutes: 30,
  askExpireTurns: 2,
  backfillDays: 15,
};

function seedActivityAndTrace(
  database: ReturnType<typeof openDatabase>,
  input: { activityId: string; questId: string | null; sessionId: string; isSwitch: boolean },
): string {
  database
    .query(
      "INSERT OR IGNORE INTO activities (id, quest_id, objective, opened_at, revision) VALUES (?, ?, 'objective', '2026-09-04T14:00:00.000Z', 1)",
    )
    .run(input.activityId, input.questId);
  const traceId = newUlid();
  database
    .query(
      `INSERT INTO traces (id, activity_id, tool, place, source, started_at, ended_at, who, what, why, where_text, how, confidence, classified_by, session_id, recorded_at)
       VALUES (?, ?, 'claude-code', 'p', 'w5', '2026-09-04T15:00:00.000Z', '2026-09-04T15:20:00.000Z', 'hero', 'what', 'why', 'p', 'claude-code', 0.6, 'assistant', ?, '2026-09-04T15:20:00.000Z')`,
    )
    .run(traceId, input.activityId, input.sessionId);
  return traceId;
}

function seedQuestion(
  database: ReturnType<typeof openDatabase>,
  store: EventStore,
  input: { traceId: string; sessionId: string; kind: string; isSwitch?: boolean },
): string {
  const id = newUlid();
  applyIncremental(
    database,
    store.append({
      actor: "hook",
      kind: "question.asked",
      subject: id,
      sessionId: input.sessionId,
      payload: {
        trace: input.traceId,
        kind: input.kind,
        text: input.kind,
        is_switch: input.isSwitch ?? false,
      },
    }),
  );
  return id;
}

describe("advanceQuestions", () => {
  test("watching gains turns but does not ask before watchTurns", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    const traceId = seedActivityAndTrace(database, {
      activityId: "A1",
      questId: null,
      sessionId: "s1",
      isSwitch: true,
    });
    seedQuestion(database, store, {
      traceId,
      sessionId: "s1",
      kind: "which_quest",
      isSwitch: true,
    });

    const result = advanceQuestions(store, database, config, {
      sessionId: "s1",
      now: "2026-09-04T15:21:00.000Z",
      turnsSinceLastRun: 2,
      sessionActivityMinutes: 5,
      resolvedByContext: [],
    });

    expect(result.asked).toHaveLength(0);
    const row = database.query("SELECT turns_watched, state FROM questions").get() as {
      turns_watched: number;
      state: string;
    };
    expect(row.turns_watched).toBe(2);
    expect(row.state).toBe("watching");
  });

  test("asks a which_quest question on a switch once watchTurns reached", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    const traceId = seedActivityAndTrace(database, {
      activityId: "A1",
      questId: null,
      sessionId: "s1",
      isSwitch: true,
    });
    const questionId = seedQuestion(database, store, {
      traceId,
      sessionId: "s1",
      kind: "which_quest",
      isSwitch: true,
    });

    const result = advanceQuestions(store, database, config, {
      sessionId: "s1",
      now: "2026-09-04T15:21:00.000Z",
      turnsSinceLastRun: 3,
      sessionActivityMinutes: 5,
      resolvedByContext: [],
    });

    expect(result.asked.map((q) => q.id)).toEqual([questionId]);
    const row = database.query("SELECT state, turns_at_ask FROM questions").get() as {
      state: string;
      turns_at_ask: number;
    };
    expect(row.state).toBe("asked");
    expect(row.turns_at_ask).toBe(3);
  });

  test("never asks a why question on an activity that has a quest; it expires to review", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    const traceId = seedActivityAndTrace(database, {
      activityId: "A1",
      questId: "Q1",
      sessionId: "s1",
      isSwitch: false,
    });
    seedQuestion(database, store, { traceId, sessionId: "s1", kind: "why" });

    const result = advanceQuestions(store, database, config, {
      sessionId: "s1",
      now: "2026-09-04T15:21:00.000Z",
      turnsSinceLastRun: 3,
      sessionActivityMinutes: 25,
      resolvedByContext: [],
    });

    expect(result.asked).toHaveLength(0);
    expect(result.expired).toHaveLength(1);
    const row = database.query("SELECT state FROM questions").get() as { state: string };
    expect(row.state).toBe("expired");
  });

  test("budget: no second ask within askBudgetMinutes of a prior ask in the same session", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    const traceA = seedActivityAndTrace(database, {
      activityId: "A1",
      questId: null,
      sessionId: "s1",
      isSwitch: true,
    });
    const firstQuestion = seedQuestion(database, store, {
      traceId: traceA,
      sessionId: "s1",
      kind: "which_quest",
      isSwitch: true,
    });
    advanceQuestions(store, database, config, {
      sessionId: "s1",
      now: "2026-09-04T15:21:00.000Z",
      turnsSinceLastRun: 3,
      sessionActivityMinutes: 5,
      resolvedByContext: [],
    });
    applyIncremental(
      database,
      store.append({
        actor: "hero",
        kind: "question.answered",
        subject: firstQuestion,
        at: "2026-09-04T15:22:00.000Z",
        payload: { quest: "Q1", answeredBy: "hero" },
      }),
    );

    const traceB = seedActivityAndTrace(database, {
      activityId: "A2",
      questId: null,
      sessionId: "s1",
      isSwitch: true,
    });
    seedQuestion(database, store, {
      traceId: traceB,
      sessionId: "s1",
      kind: "which_quest",
      isSwitch: true,
    });

    const result = advanceQuestions(store, database, config, {
      sessionId: "s1",
      now: "2026-09-04T15:40:00.000Z",
      turnsSinceLastRun: 3,
      sessionActivityMinutes: 5,
      resolvedByContext: [],
    });

    expect(result.asked).toHaveLength(0);
  });

  test("no two asked in a row: an unanswered asked question blocks the next ask", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    const traceA = seedActivityAndTrace(database, {
      activityId: "A1",
      questId: null,
      sessionId: "s1",
      isSwitch: true,
    });
    seedQuestion(database, store, {
      traceId: traceA,
      sessionId: "s1",
      kind: "which_quest",
      isSwitch: true,
    });
    advanceQuestions(store, database, config, {
      sessionId: "s1",
      now: "2026-09-04T15:21:00.000Z",
      turnsSinceLastRun: 3,
      sessionActivityMinutes: 5,
      resolvedByContext: [],
    });

    const traceB = seedActivityAndTrace(database, {
      activityId: "A2",
      questId: null,
      sessionId: "s1",
      isSwitch: true,
    });
    seedQuestion(database, store, {
      traceId: traceB,
      sessionId: "s1",
      kind: "which_quest",
      isSwitch: true,
    });

    const result = advanceQuestions(store, database, config, {
      sessionId: "s1",
      now: "2026-09-04T15:22:00.000Z",
      turnsSinceLastRun: 3,
      sessionActivityMinutes: 5,
      resolvedByContext: [],
    });

    expect(result.asked).toHaveLength(0);
  });

  test("quiet suppresses asking until w5_quiet.until passes", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    database.query("INSERT INTO w5_quiet (until) VALUES ('2026-09-04T16:00:00.000Z')").run();
    const traceId = seedActivityAndTrace(database, {
      activityId: "A1",
      questId: null,
      sessionId: "s1",
      isSwitch: true,
    });
    seedQuestion(database, store, {
      traceId,
      sessionId: "s1",
      kind: "which_quest",
      isSwitch: true,
    });

    const result = advanceQuestions(store, database, config, {
      sessionId: "s1",
      now: "2026-09-04T15:21:00.000Z",
      turnsSinceLastRun: 3,
      sessionActivityMinutes: 5,
      resolvedByContext: [],
    });

    expect(result.asked).toHaveLength(0);
  });

  test("expiry: an asked question past askExpireTurns expires", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    const traceId = seedActivityAndTrace(database, {
      activityId: "A1",
      questId: null,
      sessionId: "s1",
      isSwitch: true,
    });
    const questionId = seedQuestion(database, store, {
      traceId,
      sessionId: "s1",
      kind: "which_quest",
      isSwitch: true,
    });
    advanceQuestions(store, database, config, {
      sessionId: "s1",
      now: "2026-09-04T15:21:00.000Z",
      turnsSinceLastRun: 3,
      sessionActivityMinutes: 5,
      resolvedByContext: [],
    });

    const result = advanceQuestions(store, database, config, {
      sessionId: "s1",
      now: "2026-09-04T15:25:00.000Z",
      turnsSinceLastRun: 2,
      sessionActivityMinutes: 5,
      resolvedByContext: [],
    });

    expect(result.expired.map((q) => q.id)).toEqual([questionId]);
    const row = database.query("SELECT state FROM questions").get() as { state: string };
    expect(row.state).toBe("expired");
  });

  test("resolvedByContext resolves a watching question without asking it", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    const traceId = seedActivityAndTrace(database, {
      activityId: "A1",
      questId: null,
      sessionId: "s1",
      isSwitch: true,
    });
    const questionId = seedQuestion(database, store, {
      traceId,
      sessionId: "s1",
      kind: "which_quest",
      isSwitch: true,
    });

    const result = advanceQuestions(store, database, config, {
      sessionId: "s1",
      now: "2026-09-04T15:21:00.000Z",
      turnsSinceLastRun: 1,
      sessionActivityMinutes: 5,
      resolvedByContext: [questionId],
    });

    expect(result.resolved.map((q) => q.id)).toEqual([questionId]);
    const row = database.query("SELECT state, answered_by FROM questions").get() as {
      state: string;
      answered_by: string;
    };
    expect(row.state).toBe("resolved_by_context");
    expect(row.answered_by).toBe("context");
  });
});
