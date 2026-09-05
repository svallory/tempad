import type { Database } from "bun:sqlite";
import { openDatabase } from "../db/database";
import { rebuildAll } from "./projections";
import { EventStore } from "./store";

export function stateAsOf(database: Database, until: string): Database {
  const target = openDatabase(":memory:");
  const store = new EventStore(database);
  const events = store.read({ until });
  const insert = target.query(
    "INSERT INTO events (at, recorded_at, actor, session_id, kind, subject, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const insertAll = target.transaction(() => {
    for (const event of events) {
      insert.run(
        event.at,
        event.recordedAt,
        event.actor,
        event.sessionId,
        event.kind,
        event.subject,
        JSON.stringify(event.payload),
      );
    }
  });
  insertAll();
  rebuildAll(target, { until });
  return target;
}
