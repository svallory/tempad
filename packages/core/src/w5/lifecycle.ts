import type { Database } from "bun:sqlite";
import type { Actor } from "../intent/events";
import { newUlid } from "../intent/ids";
import { applyIncremental } from "../intent/projections";
import type { EventStore } from "../intent/store";

export interface CloseIdleStintsInput {
  sessionId: string;
  windowStartedAt: string;
  idleMinutes: number;
  stintMinMinutes: number;
}

/**
 * Dismisses a stint whose live trace minutes are below `minMinutes`, appending
 * `stint.dismissed` (reason `"below minimum"`). Called right after a
 * `stint.closed` append, since a stint's total trace time is only known once
 * no more traces are landing on it.
 */
function dismissIfBelowMinimum(
  store: EventStore,
  database: Database,
  stintId: string,
  closedAt: string,
  minMinutes: number,
): void {
  const row = database
    .query(
      `SELECT
         (SELECT SUM((julianday(traces.ended_at) - julianday(traces.started_at)) * 1440)
            FROM traces WHERE traces.stint_id = ? AND traces.retracted_at IS NULL) as traceMinutes`,
    )
    .get(stintId) as { traceMinutes: number | null };
  if ((row.traceMinutes ?? 0) >= minMinutes) return;
  applyIncremental(
    database,
    store.append({
      actor: "system",
      kind: "stint.dismissed",
      subject: stintId,
      at: closedAt,
      payload: { reason: "below minimum" },
    }),
  );
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
    dismissIfBelowMinimum(store, database, row.id, row.lastEndedAt, input.stintMinMinutes);
    closed.push(row.id);
  }
  return { closed };
}

export function closeSessionStints(
  store: EventStore,
  database: Database,
  input: { sessionId: string; now: string; stintMinMinutes: number },
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
    const closedAt = row.lastEndedAt ?? input.now;
    applyIncremental(
      database,
      store.append({
        actor: "hook",
        kind: "stint.closed",
        subject: row.id,
        at: closedAt,
        payload: { reason: "session_end" },
      }),
    );
    dismissIfBelowMinimum(store, database, row.id, closedAt, input.stintMinMinutes);
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
  /**
   * The plan alias (`"P2.1"`) this stint was opened for, recorded as written at
   * the moment it was first matched. Plan numbering is assigned fresh per
   * window, so the alias alone does not identify a plan item across time.
   */
  planIndex?: string;
  /**
   * The plan line's text at that index when the stint was opened. An amended
   * plan shifts what `P2.1` names, so reuse is keyed on this rather than on the
   * alias: without it, a stint opened for the old item would silently absorb
   * the new one's traces.
   */
  planItem?: string;
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
      payload: {
        quest: input.quest,
        outcome: input.outcome,
        continues: input.continues,
        plan_index: input.planIndex,
        plan_item: input.planItem,
      },
    }),
  );
  return id;
}
