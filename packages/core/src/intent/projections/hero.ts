import type { Projection } from "./index";

export const heroProjection: Projection = {
  name: "heroes",
  tables: ["heroes"],
  createSql:
    "CREATE TABLE IF NOT EXISTS heroes (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL)",
  apply(database, event) {
    if (event.kind !== "hero.created") return;
    database
      .query("INSERT OR REPLACE INTO heroes (id, name, created_at) VALUES (?, ?, ?)")
      .run(event.subject, String(event.payload.name), event.at);
  },
};
