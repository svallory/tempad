import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db/database";
import { newUlid } from "../../src/intent/ids";
import {
  applyIncremental,
  type Projection,
  rebuildAll,
  registerProjection,
} from "../../src/intent/projections";
import { EventStore } from "../../src/intent/store";

const counter: Projection = {
  name: "test_counter",
  tables: ["test_counter"],
  createSql:
    "CREATE TABLE IF NOT EXISTS test_counter (subject TEXT PRIMARY KEY, n INTEGER NOT NULL)",
  apply(database, event) {
    if (event.kind !== "goal.reworded") return;
    database
      .query(
        "INSERT INTO test_counter (subject, n) VALUES (?, 1) ON CONFLICT(subject) DO UPDATE SET n = n + 1",
      )
      .run(event.subject);
  },
};

describe("projections", () => {
  test("rebuild replays all events; incremental applies only new ones; both agree", () => {
    registerProjection(counter);
    const database = openDatabase(":memory:");
    const store = new EventStore(database);
    const subject = newUlid();
    const first = store.append({ actor: "hero", kind: "goal.reworded", subject, payload: {} });
    applyIncremental(database, first);
    const second = store.append({ actor: "hero", kind: "goal.reworded", subject, payload: {} });
    applyIncremental(database, second);
    const incremental = (database.query("SELECT n FROM test_counter").get() as { n: number }).n;
    rebuildAll(database);
    const rebuilt = (database.query("SELECT n FROM test_counter").get() as { n: number }).n;
    expect(incremental).toBe(2);
    expect(rebuilt).toBe(2);
  });

  test("rebuild until a date stops replay there", () => {
    registerProjection(counter);
    const database = openDatabase(":memory:");
    const store = new EventStore(database);
    const subject = newUlid();
    store.append({
      at: "2026-08-01T00:00:00.000Z",
      actor: "hero",
      kind: "goal.reworded",
      subject,
      payload: {},
    });
    store.append({
      at: "2026-09-01T00:00:00.000Z",
      actor: "hero",
      kind: "goal.reworded",
      subject,
      payload: {},
    });
    rebuildAll(database, { until: "2026-08-15T00:00:00.000Z" });
    expect((database.query("SELECT n FROM test_counter").get() as { n: number }).n).toBe(1);
  });
});
