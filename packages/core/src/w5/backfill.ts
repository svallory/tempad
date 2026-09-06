import type { Database } from "bun:sqlite";
import type { Config } from "../config/env";
import type { W5Config } from "../intent/config";
import { applyIncremental, ensureTables } from "../intent/projections";
import { registerAllProjections } from "../intent/projections/register";
import { EventStore } from "../intent/store";
import { applyResult } from "./apply";
import type { Classifier } from "./classifier";
import { writeSessionNote } from "./jobs";
import { closeIdleActivities } from "./lifecycle";
import { buildWindow } from "./window";

registerAllProjections();

export interface BackfillOptions {
  days: number;
  now: string;
  log: (line: string) => void;
  force?: boolean;
  /** Explicit lower bound, overriding the `days`-derived cutoff when given. */
  from?: string;
  /**
   * Explicit, exclusive upper bound on both the session query and each
   * session's message window -- callers passing a bare date must normalize
   * it to the start of the next day themselves (see `eval.ts`'s
   * `normalizeEvalRange`), since a raw bare date compared with `<` would
   * exclude the whole day instead of including it.
   */
  to?: string;
}

export interface BackfillResult {
  sessionsClassified: number;
  sessionsSkipped: number;
  windowsClassified: number;
  windowsFailed: number;
  windowsSkipped: number;
  questConflicts: number;
  unknownActivityIds: number;
  overlapDropped: number;
}

interface SessionRow {
  id: string;
  ended_at: string;
}

/**
 * Primary path: an explicit `w5_windows` row for this exact window (see
 * `src/intent/projections/window.ts`). Legacy fallback, for windows
 * classified before `window.classified` existed: a live (non-retracted)
 * trace nested inside the window's bounds. A database with traces already
 * classified under the old scheme has no `w5_windows` rows at all, so
 * without this fallback every one of those windows would look uncovered
 * and get reclassified (and re-duplicated) the first time backfill runs
 * post-upgrade.
 */
function isWindowCovered(
  database: Database,
  sessionId: string,
  windowStartedAt: string,
  windowEndedAt: string,
): boolean {
  const windowRow = database
    .query(
      "SELECT rowid FROM w5_windows WHERE session_id = ? AND started_at = ? AND ended_at = ? LIMIT 1",
    )
    .get(sessionId, windowStartedAt, windowEndedAt) as { rowid: number } | null;
  if (windowRow !== null) return true;

  const traceRow = database
    .query(
      `SELECT id FROM traces
       WHERE session_id = ? AND retracted_at IS NULL
         AND started_at >= ? AND ended_at <= ?
       LIMIT 1`,
    )
    .get(sessionId, windowStartedAt, windowEndedAt) as { id: string } | null;
  return traceRow !== null;
}

function chunkByWindow<T extends { ts: string }>(messages: T[], windowMinutes: number): T[][] {
  if (messages.length === 0) return [];
  const chunks: T[][] = [];
  let current: T[] = [];
  let windowStart: number | null = null;

  for (const message of messages) {
    const ts = Date.parse(message.ts);
    if (windowStart === null || ts - windowStart > windowMinutes * 60_000) {
      if (current.length > 0) chunks.push(current);
      current = [message];
      windowStart = ts;
    } else {
      current.push(message);
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export async function backfill(
  database: Database,
  _config: Config,
  intentConfig: W5Config,
  classifier: Classifier,
  options: BackfillOptions,
): Promise<BackfillResult> {
  ensureTables(database);
  const store = new EventStore(database);
  const cutoff =
    options.from ??
    new Date(Date.parse(options.now) - options.days * 24 * 60 * 60 * 1000).toISOString();

  const sessions = options.to
    ? (database
        .query(
          "SELECT id, ended_at FROM claude_sessions WHERE ended_at >= ? AND ended_at < ? ORDER BY ended_at ASC",
        )
        .all(cutoff, options.to) as SessionRow[])
    : (database
        .query("SELECT id, ended_at FROM claude_sessions WHERE ended_at >= ? ORDER BY ended_at ASC")
        .all(cutoff) as SessionRow[]);

  let sessionsClassified = 0;
  let sessionsSkipped = 0;
  let windowsClassified = 0;
  let windowsFailed = 0;
  let windowsSkipped = 0;
  let questConflicts = 0;
  let unknownActivityIds = 0;
  let overlapDropped = 0;
  const windowMinutes = intentConfig.throttleMinutes * 3;

  for (const session of sessions) {
    const fullWindow = buildWindow(database, {
      sessionId: session.id,
      sinceTs: null,
      maxMessages: 5000,
      memoryHours: intentConfig.memoryHours,
      memoryActivities: intentConfig.memoryActivities,
      overlapMessages: intentConfig.overlapMessages,
    });
    const boundedMessages = options.to
      ? fullWindow.messages.filter((message) => message.ts < (options.to as string))
      : fullWindow.messages;
    const chunks = chunkByWindow(boundedMessages, windowMinutes);

    const pendingChunks = chunks
      .map((chunk, index) => ({ chunk, index }))
      .filter(({ chunk }) => {
        const startedAt = chunk[0]?.ts ?? session.ended_at;
        const endedAt = chunk.at(-1)?.ts ?? session.ended_at;
        const covered = options.force
          ? false
          : isWindowCovered(database, session.id, startedAt, endedAt);
        if (covered) windowsSkipped += 1;
        return !covered;
      });

    if (chunks.length > 0 && pendingChunks.length === 0) {
      sessionsSkipped += 1;
      options.log(`backfill: skipping ${session.id} (already covered)`);
      continue;
    }

    let sessionHadSuccess = false;

    for (const { chunk, index } of pendingChunks) {
      const startedAt = chunk[0]?.ts ?? session.ended_at;
      const endedAt = chunk.at(-1)?.ts ?? session.ended_at;

      closeIdleActivities(store, database, {
        sessionId: session.id,
        windowStartedAt: startedAt,
        idleMinutes: intentConfig.activityIdleMinutes,
      });

      // The slice is rebuilt per chunk, after the previous chunk's applyResult and
      // session note landed: chunk n+1 must see the activities chunk n opened or
      // closed, exactly as a live run sees the previous hook invocation's work.
      // `sinceTs` is the previous chunk's last message, so the overlap tail is the
      // messages before this chunk, never this chunk's own; `messages` is overridden
      // because the chunk's bounds, not `sinceTs`, decide what it classifies.
      const previousChunkEnd = index > 0 ? (chunks[index - 1]?.at(-1)?.ts ?? null) : null;
      const chunkWindow = {
        ...buildWindow(database, {
          sessionId: session.id,
          sinceTs: previousChunkEnd,
          maxMessages: 5000,
          memoryHours: intentConfig.memoryHours,
          memoryActivities: intentConfig.memoryActivities,
          overlapMessages: intentConfig.overlapMessages,
        }),
        messages: chunk,
      };

      try {
        let result: Awaited<ReturnType<typeof classifier.classify>>;
        try {
          result = await classifier.classify(chunkWindow);
        } catch {
          result = await classifier.classify(chunkWindow);
        }
        const applied = applyResult(store, database, chunkWindow, result, {
          actor: "backfill",
          askingEnabled: false,
          now: options.now,
          log: options.log,
        });
        questConflicts += applied.questConflicts;
        unknownActivityIds += applied.unknownActivityIds;
        overlapDropped += applied.overlapDropped;
        writeSessionNote(database, session.id, result.sessionNote, options.now);
        applyIncremental(
          database,
          store.append({
            actor: "backfill",
            kind: "window.classified",
            subject: session.id,
            sessionId: session.id,
            payload: { session: session.id, startedAt, endedAt },
            at: options.now,
          }),
        );
        windowsClassified += 1;
        sessionHadSuccess = true;
      } catch (error) {
        windowsFailed += 1;
        const message = error instanceof Error ? error.message : String(error);
        options.log(`backfill: failed ${session.id} window ${index}: ${message}`);
      }
    }

    if (sessionHadSuccess) {
      sessionsClassified += 1;
      options.log(`backfill: classified ${session.id} (${pendingChunks.length} window(s))`);
    }
  }

  return {
    sessionsClassified,
    sessionsSkipped,
    windowsClassified,
    windowsFailed,
    windowsSkipped,
    questConflicts,
    unknownActivityIds,
    overlapDropped,
  };
}
