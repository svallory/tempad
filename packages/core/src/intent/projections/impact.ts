import type { Projection } from "./index";

export const impactProjection: Projection = {
  name: "impacts",
  tables: ["impacts"],
  createSql: `
    CREATE TABLE IF NOT EXISTS impacts (
      subject TEXT PRIMARY KEY,
      subject_kind TEXT NOT NULL CHECK (subject_kind IN ('pr', 'commit', 'monday', 'session')),
      text TEXT NOT NULL,
      theme TEXT,
      revision INTEGER NOT NULL,
      stated_at TEXT NOT NULL,
      event_id INTEGER NOT NULL,
      retracted_at TEXT
    );`,
  apply(database, event) {
    const payload = event.payload;
    switch (event.kind) {
      case "impact.stated": {
        const existing = database
          .query("SELECT revision FROM impacts WHERE subject = ?")
          .get(event.subject) as { revision: number } | null;
        const revision = (existing?.revision ?? 0) + 1;
        const subjectKind = String(event.subject).split(":", 1)[0] ?? "";
        database
          .query(
            `INSERT INTO impacts (subject, subject_kind, text, theme, revision, stated_at, event_id, retracted_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
             ON CONFLICT(subject) DO UPDATE SET
               text = excluded.text,
               theme = excluded.theme,
               revision = excluded.revision,
               stated_at = excluded.stated_at,
               event_id = excluded.event_id,
               retracted_at = NULL`,
          )
          .run(
            event.subject,
            subjectKind,
            String(payload.text),
            payload.theme ? String(payload.theme) : null,
            revision,
            event.at,
            event.id,
          );
        return;
      }
      case "retracted":
        database
          .query("UPDATE impacts SET retracted_at = ? WHERE subject = ? AND retracted_at IS NULL")
          .run(event.at, event.subject);
        return;
      default:
        return;
    }
  },
};
