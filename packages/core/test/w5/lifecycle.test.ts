import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db/database";
import { newUlid } from "../../src/intent/ids";
import { ensureTables } from "../../src/intent/projections";
import { registerAllProjections } from "../../src/intent/projections/register";
import { EventStore } from "../../src/intent/store";
import {
  closeActivityOnSwitch,
  closeIdleActivities,
  closeSessionActivities,
  openActivityContinuing,
} from "../../src/w5/lifecycle";

registerAllProjections();

function seedActivityWithTrace(
  database: ReturnType<typeof openDatabase>,
  input: { activityId: string; sessionId: string; endedAt: string },
) {
  database
    .query(
      "INSERT INTO activities (id, quest_id, objective, opened_at, revision) VALUES (?, NULL, 'work', '2026-09-06T09:00:00.000Z', 1)",
    )
    .run(input.activityId);
  database
    .query(
      `INSERT INTO traces (id, activity_id, tool, place, source, started_at, ended_at, who, what, why, where_text, how, confidence, classified_by, session_id, recorded_at)
       VALUES (?, ?, 'claude-code', 'p', 'session', '2026-09-06T09:00:00.000Z', ?, 'hero', 'work', 'ship', 'org/p', 'claude-code', 0.9, 'assistant', ?, '2026-09-06T09:00:00.000Z')`,
    )
    .run(newUlid(), input.activityId, input.endedAt, input.sessionId);
}

describe("lifecycle", () => {
  test("closeIdleActivities closes only activities idle past the threshold", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    seedActivityWithTrace(database, {
      activityId: "A-old",
      sessionId: "s1",
      endedAt: "2026-09-06T09:10:00.000Z",
    });
    seedActivityWithTrace(database, {
      activityId: "A-recent",
      sessionId: "s1",
      endedAt: "2026-09-06T09:55:00.000Z",
    });

    const result = closeIdleActivities(store, database, {
      sessionId: "s1",
      windowStartedAt: "2026-09-06T10:00:00.000Z",
      idleMinutes: 45,
      now: "2026-09-06T10:00:00.000Z",
    });

    expect(result.closed).toEqual(["A-old"]);
    const rows = database
      .query("SELECT id, closed_at, close_reason FROM activities ORDER BY id")
      .all() as { id: string; closed_at: string | null; close_reason: string | null }[];
    expect(rows.find((r) => r.id === "A-old")).toEqual({
      id: "A-old",
      closed_at: "2026-09-06T09:10:00.000Z",
      close_reason: "idle",
    });
    expect(rows.find((r) => r.id === "A-recent")?.closed_at).toBeNull();
  });

  test("closeActivityOnSwitch closes with reason switch at the given time", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    seedActivityWithTrace(database, {
      activityId: "A1",
      sessionId: "s1",
      endedAt: "2026-09-06T09:10:00.000Z",
    });

    closeActivityOnSwitch(store, database, {
      activityId: "A1",
      closedAt: "2026-09-06T09:12:00.000Z",
    });

    const row = database
      .query("SELECT closed_at, close_reason FROM activities WHERE id = 'A1'")
      .get() as { closed_at: string; close_reason: string };
    expect(row).toEqual({ closed_at: "2026-09-06T09:12:00.000Z", close_reason: "switch" });
  });

  test("closeSessionActivities closes every open activity of the session and clears the note", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    seedActivityWithTrace(database, {
      activityId: "A1",
      sessionId: "s1",
      endedAt: "2026-09-06T09:10:00.000Z",
    });
    seedActivityWithTrace(database, {
      activityId: "A2",
      sessionId: "s1",
      endedAt: "2026-09-06T09:20:00.000Z",
    });
    database
      .query(
        "INSERT INTO w5_runs (session_id, last_run_at, session_note) VALUES ('s1', '2026-09-06T09:20:00.000Z', 'heading toward X')",
      )
      .run();

    const result = closeSessionActivities(store, database, {
      sessionId: "s1",
      now: "2026-09-06T09:30:00.000Z",
    });

    expect(result.closed.sort()).toEqual(["A1", "A2"]);
    const reasons = database.query("SELECT close_reason FROM activities").all() as {
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

  test("openActivityContinuing stores the continues link", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);

    const id = openActivityContinuing(store, database, {
      objective: "back to walk order",
      at: "2026-09-06T12:00:00.000Z",
      actor: "hook",
      continues: "A-old",
    });

    const row = database.query("SELECT continues FROM activities WHERE id = ?").get(id) as {
      continues: string | null;
    };
    expect(row.continues).toBe("A-old");
  });
});
