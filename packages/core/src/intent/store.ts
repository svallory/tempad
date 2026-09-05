import type { Database } from "bun:sqlite";
import { EVENT_KINDS, type EventInput, type EventKind, type EventRecord } from "./events";

interface Row {
  id: number;
  at: string;
  recorded_at: string;
  actor: string;
  session_id: string | null;
  kind: string;
  subject: string;
  payload: string;
}

function toRecord(row: Row): EventRecord {
  return {
    id: row.id,
    at: row.at,
    recordedAt: row.recorded_at,
    actor: row.actor as EventRecord["actor"],
    sessionId: row.session_id,
    kind: row.kind as EventKind,
    subject: row.subject,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
  };
}

export class EventStore {
  constructor(private readonly database: Database) {}

  append(input: EventInput): EventRecord {
    if (!EVENT_KINDS.includes(input.kind)) {
      throw new Error(`Unknown event kind: ${input.kind}`);
    }
    const now = new Date().toISOString();
    const at = input.at ?? now;
    const result = this.database
      .query(
        `INSERT INTO events (at, recorded_at, actor, session_id, kind, subject, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        at,
        now,
        input.actor,
        input.sessionId ?? null,
        input.kind,
        input.subject,
        JSON.stringify(input.payload),
      ) as Row;
    return toRecord(result);
  }

  read(
    options: { subject?: string; kind?: EventKind; until?: string; afterId?: number } = {},
  ): EventRecord[] {
    const clauses: string[] = [];
    const parameters: (string | number)[] = [];
    if (options.subject) {
      clauses.push("subject = ?");
      parameters.push(options.subject);
    }
    if (options.kind) {
      clauses.push("kind = ?");
      parameters.push(options.kind);
    }
    if (options.until) {
      clauses.push("at <= ?");
      parameters.push(options.until);
    }
    if (options.afterId !== undefined) {
      clauses.push("id > ?");
      parameters.push(options.afterId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.database
      .query(`SELECT * FROM events ${where} ORDER BY id`)
      .all(...parameters) as Row[];
    return rows.map(toRecord);
  }
}
