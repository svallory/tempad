import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db/database";
import { newUlid } from "../../src/intent/ids";
import { applyIncremental, ensureTables } from "../../src/intent/projections";
import { registerAllProjections } from "../../src/intent/projections/register";
import { EventStore } from "../../src/intent/store";
import { dedupe } from "../../src/w5/dedupe";

registerAllProjections();

function recordTrace(
  store: EventStore,
  database: ReturnType<typeof openDatabase>,
  input: {
    id: string;
    activityId: string;
    sessionId: string;
    startedAt: string;
    endedAt: string;
  },
): void {
  applyIncremental(
    database,
    store.append({
      actor: "backfill",
      kind: "trace.recorded",
      subject: input.id,
      sessionId: input.sessionId,
      payload: {
        activity: input.activityId,
        tool: "claude-code",
        place: "p",
        source: "session",
        started_at: input.startedAt,
        ended_at: input.endedAt,
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
}

function openActivity(
  store: EventStore,
  database: ReturnType<typeof openDatabase>,
  id: string,
  quest: string | undefined,
  at: string,
): void {
  applyIncremental(
    database,
    store.append({
      actor: "hook",
      kind: "activity.opened",
      subject: id,
      payload: { objective: "work", quest },
      at,
    }),
  );
}

function createQuest(
  store: EventStore,
  database: ReturnType<typeof openDatabase>,
  id: string,
  heroId: string,
  confirmed: boolean,
): void {
  applyIncremental(
    database,
    store.append({
      actor: "hook",
      kind: "quest.created",
      subject: id,
      payload: {
        owner: { kind: "hero", id: heroId },
        title: "Ship",
        objective: "obj",
        commitment: "focused",
        confirmed,
      },
    }),
  );
}

function seedHero(database: ReturnType<typeof openDatabase>, store: EventStore): string {
  ensureTables(database);
  const heroId = newUlid();
  applyIncremental(
    database,
    store.append({ actor: "hero", kind: "hero.created", subject: heroId, payload: { name: "S" } }),
  );
  return heroId;
}

describe("w5 dedupe", () => {
  test("--dry-run reports counts without writing", () => {
    const database = openDatabase(":memory:");
    const store = new EventStore(database);
    const heroId = seedHero(database, store);
    createQuest(store, database, "Q1", heroId, false);
    openActivity(store, database, "A1", "Q1", "2026-08-31T14:00:00.000Z");
    recordTrace(store, database, {
      id: "T1",
      activityId: "A1",
      sessionId: "s1",
      startedAt: "2026-08-31T14:00:00.000Z",
      endedAt: "2026-08-31T14:30:00.000Z",
    });
    recordTrace(store, database, {
      id: "T2",
      activityId: "A1",
      sessionId: "s1",
      startedAt: "2026-08-31T14:00:00.000Z",
      endedAt: "2026-08-31T14:30:00.000Z",
    });

    const result = dedupe(database, { dryRun: true });
    expect(result).toEqual({ traces: 1, activities: 0, quests: 0 });

    const liveTraces = database
      .query("SELECT COUNT(*) as n FROM traces WHERE retracted_at IS NULL")
      .get() as { n: number };
    expect(liveTraces.n).toBe(2);
  });

  test("without --dry-run: keeps earliest trace; a duplicate on its own activity/quest orphans both, cascading", () => {
    const database = openDatabase(":memory:");
    const store = new EventStore(database);
    const heroId = seedHero(database, store);
    // The window was classified twice by two crashed-then-relaunched backfill
    // runs, each opening its own activity (and quest) for it -- the real
    // incident's shape, per the brief's Facts section.
    createQuest(store, database, "Q1", heroId, false);
    createQuest(store, database, "Q2", heroId, false);
    openActivity(store, database, "A1", "Q1", "2026-08-31T14:00:00.000Z");
    openActivity(store, database, "A2", "Q2", "2026-08-31T14:00:05.000Z");
    recordTrace(store, database, {
      id: "T1",
      activityId: "A1",
      sessionId: "s1",
      startedAt: "2026-08-31T14:00:00.000Z",
      endedAt: "2026-08-31T14:30:00.000Z",
    });
    recordTrace(store, database, {
      id: "T2",
      activityId: "A2",
      sessionId: "s1",
      startedAt: "2026-08-31T14:00:00.000Z",
      endedAt: "2026-08-31T14:30:00.000Z",
    });

    const result = dedupe(database, { dryRun: false });
    expect(result).toEqual({ traces: 1, activities: 1, quests: 1 });

    const trace1 = database.query("SELECT retracted_at FROM traces WHERE id = 'T1'").get() as {
      retracted_at: string | null;
    };
    expect(trace1.retracted_at).toBeNull();

    const trace2 = database.query("SELECT retracted_at FROM traces WHERE id = 'T2'").get() as {
      retracted_at: string | null;
    };
    expect(trace2.retracted_at).not.toBeNull();

    const activity1 = database
      .query("SELECT retracted_at FROM activities WHERE id = 'A1'")
      .get() as { retracted_at: string | null };
    expect(activity1.retracted_at).toBeNull();

    const activity2 = database
      .query("SELECT retracted_at FROM activities WHERE id = 'A2'")
      .get() as { retracted_at: string | null };
    expect(activity2.retracted_at).not.toBeNull();

    const quest1 = database.query("SELECT retracted_at FROM quests WHERE id = 'Q1'").get() as {
      retracted_at: string | null;
    };
    expect(quest1.retracted_at).toBeNull();

    const quest2 = database.query("SELECT retracted_at FROM quests WHERE id = 'Q2'").get() as {
      retracted_at: string | null;
    };
    expect(quest2.retracted_at).not.toBeNull();

    // Idempotent: running again finds nothing left to dedupe.
    const second = dedupe(database, { dryRun: false });
    expect(second).toEqual({ traces: 0, activities: 0, quests: 0 });
  });

  test("an activity with a surviving live trace is not retracted", () => {
    const database = openDatabase(":memory:");
    const store = new EventStore(database);
    const heroId = seedHero(database, store);
    createQuest(store, database, "Q1", heroId, false);
    openActivity(store, database, "A1", "Q1", "2026-08-31T14:00:00.000Z");
    recordTrace(store, database, {
      id: "T1",
      activityId: "A1",
      sessionId: "s1",
      startedAt: "2026-08-31T14:00:00.000Z",
      endedAt: "2026-08-31T14:30:00.000Z",
    });
    recordTrace(store, database, {
      id: "T2",
      activityId: "A1",
      sessionId: "s1",
      startedAt: "2026-08-31T14:00:00.000Z",
      endedAt: "2026-08-31T14:30:00.000Z",
    });
    // A distinct, non-duplicate trace on the same activity -- it must keep
    // the activity (and its quest) alive after the duplicate is retracted.
    recordTrace(store, database, {
      id: "T3",
      activityId: "A1",
      sessionId: "s1",
      startedAt: "2026-08-31T15:00:00.000Z",
      endedAt: "2026-08-31T15:30:00.000Z",
    });

    const result = dedupe(database, { dryRun: false });
    expect(result).toEqual({ traces: 1, activities: 0, quests: 0 });

    const activity = database
      .query("SELECT retracted_at FROM activities WHERE id = 'A1'")
      .get() as { retracted_at: string | null };
    expect(activity.retracted_at).toBeNull();
  });

  test("a confirmed quest is not retracted even if its only activity is orphaned", () => {
    const database = openDatabase(":memory:");
    const store = new EventStore(database);
    const heroId = seedHero(database, store);
    // Q1 (confirmed) is the *later* run's quest -- its lone trace T2 is the
    // duplicate that gets retracted, orphaning A1/Q1. Q2 (unconfirmed) holds
    // the kept trace T1.
    createQuest(store, database, "Q1", heroId, true);
    createQuest(store, database, "Q2", heroId, false);
    openActivity(store, database, "A2", "Q2", "2026-08-31T14:00:00.000Z");
    openActivity(store, database, "A1", "Q1", "2026-08-31T14:00:05.000Z");
    recordTrace(store, database, {
      id: "T1",
      activityId: "A2",
      sessionId: "s1",
      startedAt: "2026-08-31T14:00:00.000Z",
      endedAt: "2026-08-31T14:30:00.000Z",
    });
    recordTrace(store, database, {
      id: "T2",
      activityId: "A1",
      sessionId: "s1",
      startedAt: "2026-08-31T14:00:00.000Z",
      endedAt: "2026-08-31T14:30:00.000Z",
    });

    const result = dedupe(database, { dryRun: false });
    expect(result).toEqual({ traces: 1, activities: 1, quests: 0 });

    const activity1 = database
      .query("SELECT retracted_at FROM activities WHERE id = 'A1'")
      .get() as { retracted_at: string | null };
    expect(activity1.retracted_at).not.toBeNull();

    const quest1 = database.query("SELECT retracted_at FROM quests WHERE id = 'Q1'").get() as {
      retracted_at: string | null;
    };
    expect(quest1.retracted_at).toBeNull();
  });
});
