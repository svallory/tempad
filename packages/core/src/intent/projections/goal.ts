import type { Projection } from "./index";

export const goalProjection: Projection = {
  name: "goals",
  tables: ["goals"],
  createSql: `
    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY,
      owner_kind TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      title TEXT NOT NULL,
      statement TEXT,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      ended_at TEXT,
      end_reason TEXT,
      replaced_by TEXT
    );`,
  apply(database, event) {
    const payload = event.payload;
    switch (event.kind) {
      case "goal.created": {
        const owner = payload.owner as { kind: string; id: string };
        database
          .query(
            "INSERT OR REPLACE INTO goals (id, owner_kind, owner_id, title, statement, revision, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)",
          )
          .run(
            event.subject,
            owner.kind,
            owner.id,
            String(payload.title),
            payload.statement ? String(payload.statement) : null,
            event.at,
          );
        return;
      }
      case "goal.reworded":
        database
          .query(
            "UPDATE goals SET title = COALESCE(?, title), statement = COALESCE(?, statement), revision = revision + 1 WHERE id = ?",
          )
          .run(
            payload.title !== undefined ? String(payload.title) : null,
            payload.statement !== undefined ? String(payload.statement) : null,
            event.subject,
          );
        return;
      case "goal.ended":
        database
          .query("UPDATE goals SET ended_at = ?, end_reason = ?, replaced_by = ? WHERE id = ?")
          .run(
            event.at,
            payload.reason ? String(payload.reason) : null,
            payload.replaced_by ? String(payload.replaced_by) : null,
            event.subject,
          );
        return;
      default:
        return;
    }
  },
};
