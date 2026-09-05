import type { Projection } from "./index";

export const partyProjection: Projection = {
  name: "parties",
  tables: ["parties", "memberships", "clients"],
  createSql: `
    CREATE TABLE IF NOT EXISTS parties (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS memberships (id TEXT PRIMARY KEY, hero_id TEXT NOT NULL, party_id TEXT NOT NULL, joined_at TEXT NOT NULL, left_at TEXT, reason TEXT);
    CREATE TABLE IF NOT EXISTS clients (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL);`,
  apply(database, event) {
    const payload = event.payload;
    switch (event.kind) {
      case "party.created":
        database
          .query(
            "INSERT OR REPLACE INTO parties (id, slug, name, description, created_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(
            event.subject,
            String(payload.slug),
            String(payload.name),
            payload.description ? String(payload.description) : null,
            event.at,
          );
        return;
      case "party.reworded":
        database
          .query("UPDATE parties SET name = ?, description = ? WHERE id = ?")
          .run(
            String(payload.name),
            payload.description ? String(payload.description) : null,
            event.subject,
          );
        return;
      case "membership.joined":
        database
          .query(
            "INSERT OR REPLACE INTO memberships (id, hero_id, party_id, joined_at, left_at, reason) VALUES (?, ?, ?, ?, NULL, NULL)",
          )
          .run(
            event.subject,
            String(payload.hero),
            String(payload.party),
            String(payload.joined ?? event.at),
          );
        return;
      case "membership.left":
        database
          .query("UPDATE memberships SET left_at = ?, reason = ? WHERE id = ?")
          .run(event.at, payload.reason ? String(payload.reason) : null, event.subject);
        return;
      case "client.created":
        database
          .query("INSERT OR REPLACE INTO clients (id, slug, name, created_at) VALUES (?, ?, ?, ?)")
          .run(event.subject, String(payload.slug), String(payload.name), event.at);
        return;
      default:
        return;
    }
  },
};
