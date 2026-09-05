import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db/database";
import { newUlid } from "../../src/intent/ids";
import { applyIncremental, ensureTables, rebuildAll } from "../../src/intent/projections";
import { registerAllProjections } from "../../src/intent/projections/register";
import { EventStore } from "../../src/intent/store";

registerAllProjections();

function seed(database: ReturnType<typeof openDatabase>) {
  ensureTables(database);
  const store = new EventStore(database);
  const heroId = newUlid();
  applyIncremental(
    database,
    store.append({ actor: "hero", kind: "hero.created", subject: heroId, payload: { name: "S" } }),
  );
  database
    .query(
      "INSERT INTO quests (id, owner_kind, owner_id, title, objective, confirmed, revision, state, created_at) VALUES ('Q1', 'hero', ?, 'Ship', 'obj', 0, 1, 'started', '2026-09-01T00:00:00.000Z')",
    )
    .run(heroId);
  database
    .query(
      "INSERT INTO activities (id, quest_id, objective, opened_at, revision) VALUES ('A1', 'Q1', 'do work', '2026-09-04T14:00:00.000Z', 1)",
    )
    .run();
  database
    .query(
      `INSERT INTO traces (id, activity_id, tool, place, source, started_at, ended_at, who, what, why, where_text, how, confidence, classified_by, session_id, recorded_at)
       VALUES ('T1', 'A1', 'claude-code', 'p', 'session', '2026-09-04T14:00:00.000Z', '2026-09-04T14:30:00.000Z', 'hero', 'work', 'ship', 'personal/p', 'claude-code', 0.9, 'assistant', 's1', '2026-09-04T14:30:00.000Z')`,
    )
    .run();
  return store;
}

describe("retracted events", () => {
  test("a retracted trace.recorded marks the trace row retracted_at", () => {
    const database = openDatabase(":memory:");
    const store = seed(database);
    applyIncremental(
      database,
      store.append({
        actor: "backfill",
        kind: "retracted",
        subject: "T1",
        payload: { retracts: "T1", reason: "duplicate backfill window" },
      }),
    );

    const trace = database.query("SELECT retracted_at FROM traces WHERE id = 'T1'").get() as {
      retracted_at: string | null;
    };
    expect(trace.retracted_at).not.toBeNull();

    const activity = database
      .query("SELECT retracted_at FROM activities WHERE id = 'A1'")
      .get() as { retracted_at: string | null };
    expect(activity.retracted_at).toBeNull();
  });

  test("a retracted activity.opened marks the activity row retracted_at", () => {
    const database = openDatabase(":memory:");
    const store = seed(database);
    applyIncremental(
      database,
      store.append({
        actor: "backfill",
        kind: "retracted",
        subject: "A1",
        payload: { retracts: "A1", reason: "orphaned by dedupe" },
      }),
    );

    const activity = database
      .query("SELECT retracted_at FROM activities WHERE id = 'A1'")
      .get() as { retracted_at: string | null };
    expect(activity.retracted_at).not.toBeNull();
  });

  test("a retracted quest.created marks the quest row retracted_at", () => {
    const database = openDatabase(":memory:");
    const store = seed(database);
    applyIncremental(
      database,
      store.append({
        actor: "backfill",
        kind: "retracted",
        subject: "Q1",
        payload: { retracts: "Q1", reason: "orphaned by dedupe" },
      }),
    );

    const quest = database.query("SELECT retracted_at FROM quests WHERE id = 'Q1'").get() as {
      retracted_at: string | null;
    };
    expect(quest.retracted_at).not.toBeNull();
  });

  test("rebuild reproduces retraction state", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    const heroId = newUlid();
    applyIncremental(
      database,
      store.append({
        actor: "hero",
        kind: "hero.created",
        subject: heroId,
        payload: { name: "S" },
      }),
    );
    applyIncremental(
      database,
      store.append({
        actor: "hook",
        kind: "activity.opened",
        subject: "A1",
        payload: { objective: "do work" },
        at: "2026-09-04T14:00:00.000Z",
      }),
    );
    applyIncremental(
      database,
      store.append({
        actor: "assistant",
        kind: "trace.recorded",
        subject: "T1",
        sessionId: "s1",
        payload: {
          activity: "A1",
          tool: "claude-code",
          place: "p",
          source: "session",
          started_at: "2026-09-04T14:00:00.000Z",
          ended_at: "2026-09-04T14:30:00.000Z",
          who: "hero",
          what: "work",
          why: "ship",
          where: "personal/p",
          how: "claude-code",
          confidence: 0.9,
          classified_by: "assistant",
        },
      }),
    );
    applyIncremental(
      database,
      store.append({
        actor: "backfill",
        kind: "retracted",
        subject: "T1",
        payload: { retracts: "T1", reason: "duplicate backfill window" },
      }),
    );

    rebuildAll(database);

    const trace = database.query("SELECT retracted_at FROM traces WHERE id = 'T1'").get() as {
      retracted_at: string | null;
    };
    expect(trace.retracted_at).not.toBeNull();
  });
});
