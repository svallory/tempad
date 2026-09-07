import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db/database";
import { newUlid } from "../../src/intent/ids";
import { ensureTables } from "../../src/intent/projections";
import { registerAllProjections } from "../../src/intent/projections/register";
import { EventStore } from "../../src/intent/store";
import { closeIdleStints, closeSessionStints, openStintContinuing } from "../../src/w5/lifecycle";

registerAllProjections();

function seedStintWithTrace(
  database: ReturnType<typeof openDatabase>,
  input: { stintId: string; sessionId: string; endedAt: string },
) {
  database
    .query(
      "INSERT INTO stints (id, quest_id, outcome, opened_at, revision) VALUES (?, NULL, 'work', '2026-09-06T09:00:00.000Z', 1)",
    )
    .run(input.stintId);
  database
    .query(
      `INSERT INTO traces (id, stint_id, tool, place, source, started_at, ended_at, who, what, why, where_text, how, confidence, classified_by, session_id, recorded_at)
       VALUES (?, ?, 'claude-code', 'p', 'session', '2026-09-06T09:00:00.000Z', ?, 'hero', 'work', 'ship', 'org/p', 'claude-code', 0.9, 'assistant', ?, '2026-09-06T09:00:00.000Z')`,
    )
    .run(newUlid(), input.stintId, input.endedAt, input.sessionId);
}

describe("lifecycle", () => {
  test("closeIdleActivities closes only stints idle past the threshold", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    seedStintWithTrace(database, {
      stintId: "A-old",
      sessionId: "s1",
      endedAt: "2026-09-06T09:10:00.000Z",
    });
    seedStintWithTrace(database, {
      stintId: "A-recent",
      sessionId: "s1",
      endedAt: "2026-09-06T09:55:00.000Z",
    });

    const result = closeIdleStints(store, database, {
      sessionId: "s1",
      windowStartedAt: "2026-09-06T10:00:00.000Z",
      idleMinutes: 45,
      stintMinMinutes: 5,
    });

    expect(result.closed).toEqual(["A-old"]);
    const rows = database
      .query("SELECT id, closed_at, close_reason FROM stints ORDER BY id")
      .all() as { id: string; closed_at: string | null; close_reason: string | null }[];
    expect(rows.find((r) => r.id === "A-old")).toEqual({
      id: "A-old",
      closed_at: "2026-09-06T09:10:00.000Z",
      close_reason: "idle",
    });
    expect(rows.find((r) => r.id === "A-recent")?.closed_at).toBeNull();
  });

  test("closeSessionActivities closes every open stint of the session and clears the note", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    seedStintWithTrace(database, {
      stintId: "A1",
      sessionId: "s1",
      endedAt: "2026-09-06T09:10:00.000Z",
    });
    seedStintWithTrace(database, {
      stintId: "A2",
      sessionId: "s1",
      endedAt: "2026-09-06T09:20:00.000Z",
    });
    database
      .query(
        "INSERT INTO w5_runs (session_id, last_run_at, session_note) VALUES ('s1', '2026-09-06T09:20:00.000Z', 'heading toward X')",
      )
      .run();

    const result = closeSessionStints(store, database, {
      sessionId: "s1",
      now: "2026-09-06T09:30:00.000Z",
      stintMinMinutes: 5,
    });

    expect(result.closed.sort()).toEqual(["A1", "A2"]);
    const reasons = database.query("SELECT close_reason FROM stints").all() as {
      close_reason: string;
    }[];
    expect(reasons.every((r) => r.close_reason === "session_end")).toBe(true);
    const note = database
      .query("SELECT session_note FROM w5_runs WHERE session_id = 's1'")
      .get() as {
      session_note: string | null;
    };
    expect(note.session_note).toBeNull();
  });

  test("closeIdleStints dismisses a stint whose live trace minutes are below stintMinMinutes", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    seedStintWithTrace(database, {
      stintId: "A-short",
      sessionId: "s1",
      endedAt: "2026-09-06T09:02:00.000Z",
    });

    const result = closeIdleStints(store, database, {
      sessionId: "s1",
      windowStartedAt: "2026-09-06T10:00:00.000Z",
      idleMinutes: 45,
      stintMinMinutes: 5,
    });

    expect(result.closed).toEqual(["A-short"]);
    const row = database.query("SELECT dismissed_at FROM stints WHERE id = ?").get("A-short") as {
      dismissed_at: string | null;
    };
    expect(row.dismissed_at).not.toBeNull();
  });

  test("closeIdleStints does not dismiss a stint whose live trace minutes meet stintMinMinutes", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    seedStintWithTrace(database, {
      stintId: "A-long",
      sessionId: "s1",
      endedAt: "2026-09-06T09:06:00.000Z",
    });

    const result = closeIdleStints(store, database, {
      sessionId: "s1",
      windowStartedAt: "2026-09-06T10:00:00.000Z",
      idleMinutes: 45,
      stintMinMinutes: 5,
    });

    expect(result.closed).toEqual(["A-long"]);
    const row = database.query("SELECT dismissed_at FROM stints WHERE id = ?").get("A-long") as {
      dismissed_at: string | null;
    };
    expect(row.dismissed_at).toBeNull();
  });

  test("closeSessionStints dismisses a below-minimum stint the same way", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    seedStintWithTrace(database, {
      stintId: "A-short",
      sessionId: "s1",
      endedAt: "2026-09-06T09:02:00.000Z",
    });
    seedStintWithTrace(database, {
      stintId: "A-long",
      sessionId: "s1",
      endedAt: "2026-09-06T09:10:00.000Z",
    });

    const result = closeSessionStints(store, database, {
      sessionId: "s1",
      now: "2026-09-06T09:30:00.000Z",
      stintMinMinutes: 5,
    });

    expect(result.closed.sort()).toEqual(["A-long", "A-short"]);
    const rows = database.query("SELECT id, dismissed_at FROM stints ORDER BY id").all() as {
      id: string;
      dismissed_at: string | null;
    }[];
    expect(rows.find((r) => r.id === "A-short")?.dismissed_at).not.toBeNull();
    expect(rows.find((r) => r.id === "A-long")?.dismissed_at).toBeNull();
  });

  test("openActivityContinuing stores the continues link", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);

    const id = openStintContinuing(store, database, {
      outcome: "back to walk order",
      at: "2026-09-06T12:00:00.000Z",
      actor: "hook",
      continues: "A-old",
    });

    const row = database.query("SELECT continues FROM stints WHERE id = ?").get(id) as {
      continues: string | null;
    };
    expect(row.continues).toBe("A-old");
  });
});
