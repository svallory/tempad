import { Database } from "bun:sqlite";
import { join } from "node:path";
import type { Config } from "../config/env";
import { openDatabase } from "../db/database";
import { defaultIntentConfig } from "../intent/config";
import { applyIncremental } from "../intent/projections";
import { registerAllProjections } from "../intent/projections/register";
import { EventStore } from "../intent/store";
import { backfill } from "./backfill";
import type { Classifier } from "./classifier";

registerAllProjections();

export class InvalidEvalRangeError extends Error {}

const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A bare `--from`/`--to` date (`"2026-09-02"`, no time component) compared as
 * TEXT against full ISO timestamps (`"2026-09-02T09:00:00.000Z"`) with `<=`
 * silently excludes the whole `to` day, since any timestamp on that day
 * sorts lexicographically after the bare date string. Normalizing once here
 * turns a bare `from` into that day's start and a bare `to` into the
 * *start of the next day*, so every caller can compare the upper bound with
 * a plain `<` and get an inclusive `to` day. A full ISO input is trusted
 * as given and used as an exclusive upper bound, matching how `from` is
 * always inclusive.
 */
export interface EvalRange {
  from: string;
  to: string;
}

function normalizeEvalRange(from: string, to: string): EvalRange {
  const normalizedFrom = BARE_DATE.test(from) ? `${from}T00:00:00.000Z` : from;
  const normalizedTo = BARE_DATE.test(to)
    ? new Date(Date.parse(`${to}T00:00:00.000Z`) + 24 * 60 * 60 * 1000).toISOString()
    : to;
  return { from: normalizedFrom, to: normalizedTo };
}

export function validateEvalRange(from: string, to: string): EvalRange {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (Number.isNaN(fromMs)) {
    throw new InvalidEvalRangeError(`--from is not a valid date: ${from}`);
  }
  if (Number.isNaN(toMs)) {
    throw new InvalidEvalRangeError(`--to is not a valid date: ${to}`);
  }
  if (fromMs > toMs) {
    throw new InvalidEvalRangeError(`--from (${from}) must be on or before --to (${to})`);
  }
  return normalizeEvalRange(from, to);
}

function minimalConfig(scratchDir: string): Config {
  return {
    mondayApiToken: "",
    mondayUser: "",
    ghUser: "",
    ghOrgs: [],
    ghIncludePersonal: false,
    ghToken: undefined,
    gitAuthorEmails: [],
    claudeDirs: [],
    hostSlug: "eval",
    tz: "UTC",
    since: "2020-01-01",
    home: scratchDir,
  };
}

export interface EvalOptions {
  from: string;
  to: string;
  sourceDbPath: string;
  scratchDir: string;
  now: string;
  classifier: Classifier;
  log: (line: string) => void;
}

export interface EvalSampleActivity {
  what: string;
  why: string;
  questTitle: string | null;
  durationMinutes: number | null;
  sessionTitle: string | null;
}

export interface EvalMetrics {
  copiedDbPath: string;
  resetTraces: number;
  resetActivities: number;
  resetQuests: number;
  traces: number;
  activities: number;
  ratio: number;
  medianActivityDurationMinutes: number;
  continuesLinks: number;
  questConflicts: number;
  unknownActivityIds: number;
  overlapDropped: number;
  questProposedOnMatched: number;
  selectorDefaulted: number;
  selectorAmbiguous: number;
  sample: EvalSampleActivity[];
}

export interface EvalResetResult {
  traces: number;
  activities: number;
  quests: number;
}

const RESET_REASON = "eval reset";

/**
 * Retracts, on the copy only, every old-cohort row the eval range would
 * otherwise mix into the rerun's metrics: live traces started in
 * `[from, to]`, then activities left with no live trace, then unconfirmed
 * quests left with no live activity -- mirroring `dedupe.ts`'s cascade but
 * selecting by date range instead of duplicate grouping. Also clears
 * `w5_runs.session_note` and deletes `w5_windows` rows for every touched
 * session, since the rerun's `force` flag bypasses `w5_windows` coverage
 * but the copy is otherwise left inconsistent with what the rerun records.
 */
function resetRange(database: Database, from: string, to: string): EvalResetResult {
  const store = new EventStore(database);

  const traceRows = database
    .query(
      `SELECT id, activity_id, session_id FROM traces
       WHERE retracted_at IS NULL AND started_at >= ? AND started_at < ?`,
    )
    .all(from, to) as { id: string; activity_id: string; session_id: string | null }[];

  const sessionIds = new Set(
    traceRows.map((row) => row.session_id).filter((id): id is string => id !== null),
  );

  const affectedActivityIds = new Set(traceRows.map((row) => row.activity_id));
  const retractedTraceIds = new Set(traceRows.map((row) => row.id));

  const result = { traces: 0, activities: 0, quests: 0 };

  const run = database.transaction(() => {
    for (const trace of traceRows) {
      applyIncremental(
        database,
        store.append({
          actor: "backfill",
          kind: "retracted",
          subject: trace.id,
          payload: { retracts: trace.id, reason: RESET_REASON },
        }),
      );
    }
    result.traces = traceRows.length;

    const activitiesToRetract: string[] = [];
    for (const activityId of affectedActivityIds) {
      const liveTraces = database
        .query("SELECT id FROM traces WHERE activity_id = ? AND retracted_at IS NULL")
        .all(activityId) as { id: string }[];
      const hasLiveTrace = liveTraces.some((trace) => !retractedTraceIds.has(trace.id));
      if (!hasLiveTrace) activitiesToRetract.push(activityId);
    }
    for (const activityId of activitiesToRetract) {
      applyIncremental(
        database,
        store.append({
          actor: "backfill",
          kind: "retracted",
          subject: activityId,
          payload: { retracts: activityId, reason: RESET_REASON },
        }),
      );
    }
    result.activities = activitiesToRetract.length;

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
    const retractedActivityIds = new Set(activitiesToRetract);
    const questsToRetract: string[] = [];
    for (const questId of affectedQuestIds) {
      const quest = database
        .query("SELECT confirmed FROM quests WHERE id = ? AND retracted_at IS NULL")
        .get(questId) as { confirmed: number } | null;
      if (!quest || quest.confirmed === 1) continue;
      const liveActivities = database
        .query("SELECT id FROM activities WHERE quest_id = ? AND retracted_at IS NULL")
        .all(questId) as { id: string }[];
      const hasLiveActivity = liveActivities.some(
        (activity) => !retractedActivityIds.has(activity.id),
      );
      if (!hasLiveActivity) questsToRetract.push(questId);
    }
    for (const questId of questsToRetract) {
      applyIncremental(
        database,
        store.append({
          actor: "backfill",
          kind: "retracted",
          subject: questId,
          payload: { retracts: questId, reason: RESET_REASON },
        }),
      );
    }
    result.quests = questsToRetract.length;

    for (const sessionId of sessionIds) {
      database.query("UPDATE w5_runs SET session_note = NULL WHERE session_id = ?").run(sessionId);
      database.query("DELETE FROM w5_windows WHERE session_id = ?").run(sessionId);
    }
  });
  run();

  return {
    traces: result.traces,
    activities: result.activities,
    quests: result.quests,
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  }
  return sorted[mid] as number;
}

function filenameSafe(timestamp: string): string {
  return timestamp.replace(/[:.]/g, "-");
}

/**
 * Copies via SQLite's own `VACUUM INTO`, not a file-level copy: `openDatabase`
 * runs every database (including the real `tempad.db`) in WAL mode, so a
 * plain file copy can silently miss committed transactions still sitting in
 * the `-wal` sidecar. `VACUUM INTO` reads through the live connection and
 * always sees the fully committed state, with no separate sidecar to miss.
 */
function copyDatabase(sourceDbPath: string, destinationPath: string): void {
  const source = new Database(sourceDbPath, { readonly: true });
  try {
    source.exec("VACUUM INTO ?", [destinationPath]);
  } finally {
    source.close();
  }
}

export async function runEval(options: EvalOptions): Promise<EvalMetrics> {
  const range = validateEvalRange(options.from, options.to);

  const copiedDbPath = join(options.scratchDir, `eval-${filenameSafe(options.now)}.db`);
  copyDatabase(options.sourceDbPath, copiedDbPath);

  const database = openDatabase(copiedDbPath);
  const intentConfig = defaultIntentConfig();

  const resetResult = resetRange(database, range.from, range.to);
  options.log(
    `eval: reset traces=${resetResult.traces} activities=${resetResult.activities} quests=${resetResult.quests}`,
  );

  const backfillResult = await backfill(
    database,
    minimalConfig(options.scratchDir),
    intentConfig.w5,
    options.classifier,
    {
      days: 0,
      now: options.to,
      log: options.log,
      force: true,
      from: range.from,
      to: range.to,
    },
  );

  const traceCount = database
    .query(
      "SELECT COUNT(*) as count FROM traces WHERE retracted_at IS NULL AND started_at >= ? AND started_at < ?",
    )
    .get(range.from, range.to) as { count: number };
  const activityCount = database
    .query(
      "SELECT COUNT(*) as count FROM activities WHERE retracted_at IS NULL AND opened_at >= ? AND opened_at < ?",
    )
    .get(range.from, range.to) as { count: number };
  const continuesCount = database
    .query(
      "SELECT COUNT(*) as count FROM activities WHERE continues IS NOT NULL AND retracted_at IS NULL AND opened_at >= ? AND opened_at < ?",
    )
    .get(range.from, range.to) as { count: number };

  const durationRows = database
    .query(
      "SELECT opened_at as openedAt, closed_at as closedAt FROM activities WHERE closed_at IS NOT NULL AND retracted_at IS NULL AND opened_at >= ? AND opened_at < ?",
    )
    .all(range.from, range.to) as { openedAt: string; closedAt: string }[];
  const durationsMinutes = durationRows.map(
    (row) => (Date.parse(row.closedAt) - Date.parse(row.openedAt)) / 60_000,
  );

  const sampleRows = database
    .query(
      `SELECT activities.objective as objective,
              quests.title as questTitle,
              activities.opened_at as openedAt, activities.closed_at as closedAt,
              (SELECT traces.what FROM traces
                 WHERE traces.activity_id = activities.id AND traces.retracted_at IS NULL
                 ORDER BY traces.started_at ASC LIMIT 1) as what,
              (SELECT traces.why FROM traces
                 WHERE traces.activity_id = activities.id AND traces.retracted_at IS NULL
                 ORDER BY traces.started_at ASC LIMIT 1) as why,
              (SELECT claude_sessions.title FROM traces
                 JOIN claude_sessions ON claude_sessions.id = traces.session_id
                 WHERE traces.activity_id = activities.id AND traces.retracted_at IS NULL
                 ORDER BY traces.started_at ASC LIMIT 1) as sessionTitle
         FROM activities
         LEFT JOIN quests ON quests.id = activities.quest_id
        WHERE activities.retracted_at IS NULL
          AND activities.opened_at >= ? AND activities.opened_at < ?
        ORDER BY RANDOM() LIMIT 20`,
    )
    .all(range.from, range.to) as {
    objective: string;
    questTitle: string | null;
    openedAt: string;
    closedAt: string | null;
    what: string | null;
    why: string | null;
    sessionTitle: string | null;
  }[];

  const sample: EvalSampleActivity[] = sampleRows.map((row) => ({
    what: row.what ?? row.objective,
    why: row.why ?? "",
    questTitle: row.questTitle,
    durationMinutes: row.closedAt
      ? (Date.parse(row.closedAt) - Date.parse(row.openedAt)) / 60_000
      : null,
    sessionTitle: row.sessionTitle,
  }));

  database.close();

  return {
    copiedDbPath,
    resetTraces: resetResult.traces,
    resetActivities: resetResult.activities,
    resetQuests: resetResult.quests,
    traces: traceCount.count,
    activities: activityCount.count,
    ratio: traceCount.count === 0 ? 0 : activityCount.count / traceCount.count,
    medianActivityDurationMinutes: median(durationsMinutes),
    continuesLinks: continuesCount.count,
    questConflicts: backfillResult.questConflicts,
    unknownActivityIds: backfillResult.unknownActivityIds,
    overlapDropped: backfillResult.overlapDropped,
    questProposedOnMatched: backfillResult.questProposedOnMatched,
    selectorDefaulted: backfillResult.selectorDefaulted,
    selectorAmbiguous: backfillResult.selectorAmbiguous,
    sample,
  };
}
