import type { Database } from "bun:sqlite";
import type { Actor } from "../intent/events";
import { newUlid } from "../intent/ids";
import { applyIncremental } from "../intent/projections";
import type { EventStore } from "../intent/store";

export interface CloseIdleStintsInput {
  sessionId: string;
  windowStartedAt: string;
  idleMinutes: number;
}

export function closeIdleStints(
  store: EventStore,
  database: Database,
  input: CloseIdleStintsInput,
): { closed: string[] } {
  const rows = database
    .query(
      `SELECT stints.id as id,
              (SELECT MAX(traces.ended_at) FROM traces
                 WHERE traces.stint_id = stints.id AND traces.retracted_at IS NULL) as lastEndedAt
         FROM stints
         JOIN traces ON traces.stint_id = stints.id AND traces.retracted_at IS NULL
        WHERE traces.session_id = ?
          AND stints.closed_at IS NULL
          AND stints.retracted_at IS NULL
        GROUP BY stints.id`,
    )
    .all(input.sessionId) as { id: string; lastEndedAt: string | null }[];

  const closed: string[] = [];
  for (const row of rows) {
    if (!row.lastEndedAt) continue;
    const idleMinutesElapsed =
      (Date.parse(input.windowStartedAt) - Date.parse(row.lastEndedAt)) / 60_000;
    if (idleMinutesElapsed <= input.idleMinutes) continue;
    applyIncremental(
      database,
      store.append({
        actor: "system",
        kind: "stint.closed",
        subject: row.id,
        at: row.lastEndedAt,
        payload: { reason: "idle" },
      }),
    );
    closed.push(row.id);
  }
  return { closed };
}

export function closeSessionStints(
  store: EventStore,
  database: Database,
  input: { sessionId: string; now: string },
): { closed: string[] } {
  const rows = database
    .query(
      `SELECT stints.id as id,
              (SELECT MAX(traces.ended_at) FROM traces
                 WHERE traces.stint_id = stints.id AND traces.retracted_at IS NULL) as lastEndedAt
         FROM stints
         JOIN traces ON traces.stint_id = stints.id AND traces.retracted_at IS NULL
        WHERE traces.session_id = ?
          AND stints.closed_at IS NULL
          AND stints.retracted_at IS NULL
        GROUP BY stints.id`,
    )
    .all(input.sessionId) as { id: string; lastEndedAt: string | null }[];

  const closed: string[] = [];
  for (const row of rows) {
    applyIncremental(
      database,
      store.append({
        actor: "hook",
        kind: "stint.closed",
        subject: row.id,
        at: row.lastEndedAt ?? input.now,
        payload: { reason: "session_end" },
      }),
    );
    closed.push(row.id);
  }
  database
    .query("UPDATE w5_runs SET session_note = NULL WHERE session_id = ?")
    .run(input.sessionId);
  return { closed };
}

export interface OpenStintContinuingInput {
  quest?: string;
  outcome: string;
  at: string;
  actor: Actor;
  continues?: string;
}

export function openStintContinuing(
  store: EventStore,
  database: Database,
  input: OpenStintContinuingInput,
): string {
  const id = newUlid();
  applyIncremental(
    database,
    store.append({
      actor: input.actor,
      kind: "stint.opened",
      subject: id,
      at: input.at,
      payload: { quest: input.quest, outcome: input.outcome, continues: input.continues },
    }),
  );
  return id;
}
