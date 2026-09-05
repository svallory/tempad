import type { Database } from "bun:sqlite";
import type { EventRecord } from "../events";
import { EventStore } from "../store";

export interface Projection {
  name: string;
  tables: string[];
  createSql: string;
  apply(database: Database, event: EventRecord): void;
}

const registry = new Map<string, Projection>();

export function registerProjection(projection: Projection): void {
  registry.set(projection.name, projection);
}

export function listProjections(): Projection[] {
  return [...registry.values()];
}

function ensureTables(database: Database): void {
  for (const projection of registry.values()) database.exec(projection.createSql);
}

export function applyIncremental(database: Database, event: EventRecord): void {
  ensureTables(database);
  const run = database.transaction(() => {
    for (const projection of registry.values()) {
      projection.apply(database, event);
      database
        .query(
          "INSERT INTO projection_state (name, last_event_id) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET last_event_id = excluded.last_event_id",
        )
        .run(projection.name, event.id);
    }
  });
  run();
}

export function rebuildAll(database: Database, options: { until?: string } = {}): void {
  ensureTables(database);
  const store = new EventStore(database);
  const events = store.read({ until: options.until });
  const run = database.transaction(() => {
    for (const projection of registry.values()) {
      for (const table of projection.tables) database.exec(`DELETE FROM ${table}`);
      for (const event of events) projection.apply(database, event);
      const last = events.at(-1)?.id ?? 0;
      database
        .query(
          "INSERT INTO projection_state (name, last_event_id) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET last_event_id = excluded.last_event_id",
        )
        .run(projection.name, last);
    }
  });
  run();
}
