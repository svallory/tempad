import type { Database } from "bun:sqlite";
import { applyIncremental } from "../intent/projections";
import { registerAllProjections } from "../intent/projections/register";
import { EventStore } from "../intent/store";

registerAllProjections();

export interface DedupeResult {
  traces: number;
  activities: number;
  quests: number;
}

const DUPLICATE_REASON = "duplicate backfill window";
const ORPHANED_REASON = "orphaned by dedupe";

interface DuplicateTraceRow {
  id: string;
  activity_id: string;
}

/**
 * A duplicate group is traces sharing `(session_id, started_at, ended_at)` --
 * the same backfill window classified more than once by a crashed-then-
 * relaunched run (see `isWindowCovered` in `src/w5/backfill.ts`). Within a
 * group the earliest trace (lowest event id, i.e. `rowid` on the append-only
 * `events` table) is kept; the rest are retracted.
 */
function findDuplicateTraces(database: Database): DuplicateTraceRow[][] {
  const groups = database
    .query(
      `SELECT session_id, started_at, ended_at
       FROM traces
       WHERE retracted_at IS NULL AND session_id IS NOT NULL
       GROUP BY session_id, started_at, ended_at
       HAVING COUNT(*) > 1`,
    )
    .all() as { session_id: string; started_at: string; ended_at: string }[];

  return groups.map((group) => {
    const traces = database
      .query(
        `SELECT t.id as id, t.activity_id as activity_id
         FROM traces t
         JOIN events e ON e.kind = 'trace.recorded' AND e.subject = t.id
         WHERE t.retracted_at IS NULL
           AND t.session_id = ? AND t.started_at = ? AND t.ended_at = ?
         ORDER BY e.id ASC`,
      )
      .all(group.session_id, group.started_at, group.ended_at) as DuplicateTraceRow[];
    return traces;
  });
}

function retract(store: EventStore, database: Database, subject: string, reason: string): void {
  applyIncremental(
    database,
    store.append({
      actor: "backfill",
      kind: "retracted",
      subject,
      payload: { retracts: subject, reason },
    }),
  );
}

export function dedupe(database: Database, options: { dryRun: boolean }): DedupeResult {
  const store = new EventStore(database);
  const groups = findDuplicateTraces(database);

  const tracesToRetract = groups.flatMap((group) => group.slice(1));

  const affectedActivityIds = new Set(tracesToRetract.map((trace) => trace.activity_id));

  const activitiesToRetract: string[] = [];
  for (const activityId of affectedActivityIds) {
    const retractedTraceIds = new Set(
      tracesToRetract.filter((trace) => trace.activity_id === activityId).map((trace) => trace.id),
    );
    const liveTraces = database
      .query("SELECT id FROM traces WHERE activity_id = ? AND retracted_at IS NULL")
      .all(activityId) as { id: string }[];
    const hasLiveTrace = liveTraces.some((trace) => !retractedTraceIds.has(trace.id));
    if (!hasLiveTrace) activitiesToRetract.push(activityId);
  }

  const affectedQuestIds = new Set(
    activitiesToRetract
      .map(
        (activityId) =>
          (
            database.query("SELECT quest_id FROM activities WHERE id = ?").get(activityId) as {
              quest_id: string | null;
            } | null
          )?.quest_id ?? null,
      )
      .filter((id): id is string => id !== null),
  );

  const questsToRetract: string[] = [];
  for (const questId of affectedQuestIds) {
    const quest = database
      .query("SELECT confirmed FROM quests WHERE id = ? AND retracted_at IS NULL")
      .get(questId) as { confirmed: number } | null;
    if (!quest || quest.confirmed === 1) continue;

    const retractedActivityIds = new Set(activitiesToRetract);
    const liveActivities = database
      .query("SELECT id FROM activities WHERE quest_id = ? AND retracted_at IS NULL")
      .all(questId) as { id: string }[];
    const hasLiveActivity = liveActivities.some(
      (activity) => !retractedActivityIds.has(activity.id),
    );
    if (!hasLiveActivity) questsToRetract.push(questId);
  }

  const result: DedupeResult = {
    traces: tracesToRetract.length,
    activities: activitiesToRetract.length,
    quests: questsToRetract.length,
  };

  if (options.dryRun) return result;

  const run = database.transaction(() => {
    for (const trace of tracesToRetract) retract(store, database, trace.id, DUPLICATE_REASON);
    for (const activityId of activitiesToRetract) {
      retract(store, database, activityId, ORPHANED_REASON);
    }
    for (const questId of questsToRetract) retract(store, database, questId, ORPHANED_REASON);
  });
  run();

  return result;
}
