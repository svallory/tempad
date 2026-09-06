import type { Database } from "bun:sqlite";
import type { Actor } from "../intent/events";
import { newUlid } from "../intent/ids";
import { applyIncremental } from "../intent/projections";
import type { EventStore } from "../intent/store";

export interface CloseIdleActivitiesInput {
  sessionId: string;
  windowStartedAt: string;
  idleMinutes: number;
}

export function closeIdleActivities(
  store: EventStore,
  database: Database,
  input: CloseIdleActivitiesInput,
): { closed: string[] } {
  const rows = database
    .query(
      `SELECT activities.id as id,
              (SELECT MAX(traces.ended_at) FROM traces
                 WHERE traces.activity_id = activities.id AND traces.retracted_at IS NULL) as lastEndedAt
         FROM activities
         JOIN traces ON traces.activity_id = activities.id AND traces.retracted_at IS NULL
        WHERE traces.session_id = ?
          AND activities.closed_at IS NULL
          AND activities.retracted_at IS NULL
        GROUP BY activities.id`,
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
        kind: "activity.closed",
        subject: row.id,
        at: row.lastEndedAt,
        payload: { reason: "idle" },
      }),
    );
    closed.push(row.id);
  }
  return { closed };
}

export function closeActivityOnSwitch(
  store: EventStore,
  database: Database,
  input: { activityId: string; closedAt: string },
): void {
  applyIncremental(
    database,
    store.append({
      actor: "hook",
      kind: "activity.closed",
      subject: input.activityId,
      at: input.closedAt,
      payload: { reason: "switch" },
    }),
  );
}

export function closeSessionActivities(
  store: EventStore,
  database: Database,
  input: { sessionId: string; now: string },
): { closed: string[] } {
  const rows = database
    .query(
      `SELECT activities.id as id,
              (SELECT MAX(traces.ended_at) FROM traces
                 WHERE traces.activity_id = activities.id AND traces.retracted_at IS NULL) as lastEndedAt
         FROM activities
         JOIN traces ON traces.activity_id = activities.id AND traces.retracted_at IS NULL
        WHERE traces.session_id = ?
          AND activities.closed_at IS NULL
          AND activities.retracted_at IS NULL
        GROUP BY activities.id`,
    )
    .all(input.sessionId) as { id: string; lastEndedAt: string | null }[];

  const closed: string[] = [];
  for (const row of rows) {
    applyIncremental(
      database,
      store.append({
        actor: "hook",
        kind: "activity.closed",
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

export interface OpenActivityContinuingInput {
  quest?: string;
  objective: string;
  at: string;
  actor: Actor;
  continues?: string;
}

export function openActivityContinuing(
  store: EventStore,
  database: Database,
  input: OpenActivityContinuingInput,
): string {
  const id = newUlid();
  applyIncremental(
    database,
    store.append({
      actor: input.actor,
      kind: "activity.opened",
      subject: id,
      at: input.at,
      payload: { quest: input.quest, objective: input.objective, continues: input.continues },
    }),
  );
  return id;
}
