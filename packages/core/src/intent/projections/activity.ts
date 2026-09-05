import type { Projection } from "./index";

export const activityProjection: Projection = {
  name: "activities",
  tables: ["activities", "traces", "trace_links", "questions"],
  createSql: `
    CREATE TABLE IF NOT EXISTS activities (
      id TEXT PRIMARY KEY,
      quest_id TEXT,
      objective TEXT NOT NULL,
      opened_at TEXT NOT NULL,
      closed_at TEXT,
      outcome TEXT,
      revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS traces (
      id TEXT PRIMARY KEY,
      activity_id TEXT NOT NULL,
      tool TEXT NOT NULL,
      place TEXT NOT NULL,
      source TEXT NOT NULL,
      source_ref TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      who TEXT NOT NULL,
      what TEXT NOT NULL,
      why TEXT NOT NULL,
      where_text TEXT NOT NULL,
      how TEXT NOT NULL,
      confidence REAL NOT NULL,
      classified_by TEXT NOT NULL,
      session_id TEXT,
      recorded_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trace_links (
      trace_id TEXT NOT NULL,
      activity_id TEXT NOT NULL,
      linked_at TEXT NOT NULL,
      superseded_at TEXT,
      reason TEXT
    );
    CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      session_id TEXT,
      text TEXT NOT NULL,
      kind TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'watching',
      asked_at TEXT,
      answered_at TEXT,
      answer TEXT,
      answered_by TEXT,
      turns_watched INTEGER NOT NULL DEFAULT 0,
      turns_at_ask INTEGER,
      is_switch INTEGER NOT NULL DEFAULT 0
    );`,
  apply(database, event) {
    const payload = event.payload;
    switch (event.kind) {
      case "activity.opened":
        database
          .query(
            "INSERT OR REPLACE INTO activities (id, quest_id, objective, opened_at, revision) VALUES (?, ?, ?, ?, 1)",
          )
          .run(
            event.subject,
            payload.quest ? String(payload.quest) : null,
            String(payload.objective),
            event.at,
          );
        return;
      case "activity.reworded":
        database
          .query("UPDATE activities SET objective = ?, revision = revision + 1 WHERE id = ?")
          .run(String(payload.objective), event.subject);
        return;
      case "activity.closed":
        database
          .query("UPDATE activities SET closed_at = ?, outcome = ? WHERE id = ?")
          .run(event.at, payload.outcome ? String(payload.outcome) : null, event.subject);
        return;
      case "activity.assigned":
        database
          .query("UPDATE activities SET quest_id = ? WHERE id = ?")
          .run(String(payload.quest), event.subject);
        return;
      case "trace.recorded":
        database
          .query(
            `INSERT OR REPLACE INTO traces
              (id, activity_id, tool, place, source, source_ref, started_at, ended_at, who, what, why, where_text, how, confidence, classified_by, session_id, recorded_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            event.subject,
            String(payload.activity),
            String(payload.tool),
            String(payload.place),
            String(payload.source),
            payload.source_ref ? String(payload.source_ref) : null,
            String(payload.started_at),
            String(payload.ended_at),
            String(payload.who),
            String(payload.what),
            String(payload.why),
            String(payload.where),
            String(payload.how),
            Number(payload.confidence),
            String(payload.classified_by),
            event.sessionId,
            event.recordedAt,
          );
        database
          .query(
            "INSERT INTO trace_links (trace_id, activity_id, linked_at, superseded_at, reason) VALUES (?, ?, ?, NULL, NULL)",
          )
          .run(event.subject, String(payload.activity), event.at);
        return;
      case "trace.relinked":
        database
          .query(
            "UPDATE trace_links SET superseded_at = ? WHERE trace_id = ? AND superseded_at IS NULL",
          )
          .run(event.at, event.subject);
        database
          .query(
            "INSERT INTO trace_links (trace_id, activity_id, linked_at, superseded_at, reason) VALUES (?, ?, ?, NULL, ?)",
          )
          .run(
            event.subject,
            String(payload.activity),
            event.at,
            payload.reason ? String(payload.reason) : null,
          );
        database
          .query("UPDATE traces SET activity_id = ? WHERE id = ?")
          .run(String(payload.activity), event.subject);
        return;
      case "question.asked":
        database
          .query(
            "INSERT OR REPLACE INTO questions (id, trace_id, session_id, text, kind, state, turns_watched, is_switch) VALUES (?, ?, ?, ?, ?, 'watching', 0, ?)",
          )
          .run(
            event.subject,
            String(payload.trace),
            event.sessionId,
            String(payload.text),
            String(payload.kind),
            payload.is_switch === true ? 1 : 0,
          );
        return;
      case "question.watched":
        database
          .query("UPDATE questions SET turns_watched = ? WHERE id = ?")
          .run(Number(payload.turns), event.subject);
        return;
      case "question.promoted":
        database
          .query(
            "UPDATE questions SET state = 'asked', asked_at = ?, turns_at_ask = ? WHERE id = ?",
          )
          .run(event.at, Number(payload.turnsAtAsk), event.subject);
        return;
      case "question.answered": {
        const why = payload.why ? String(payload.why) : undefined;
        const answer = why ?? (payload.quest ? String(payload.quest) : null);
        const answeredBy = payload.answeredBy ? String(payload.answeredBy) : String(event.actor);
        const state = answeredBy === "context" ? "resolved_by_context" : "answered";
        database
          .query(
            "UPDATE questions SET state = ?, answered_at = ?, answer = ?, answered_by = ? WHERE id = ?",
          )
          .run(state, event.at, answer, answeredBy, event.subject);
        return;
      }
      case "question.expired":
        database.query("UPDATE questions SET state = 'expired' WHERE id = ?").run(event.subject);
        return;
      default:
        return;
    }
  },
};
