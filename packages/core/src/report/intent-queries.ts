import type { Database } from "bun:sqlite";
import { stateAsOf } from "../intent/time-travel.ts";
import { localDayBoundsUtc } from "./markdown.ts";
import type { DateRange } from "./queries.ts";

/**
 * Intent tables (quests, activities, traces, questions) render as of a past
 * date via `--as-of`; mirrors (commits, sessions, Monday items) always read
 * current state -- see plan Task 3. `stateAsOf` rebuilds a fresh in-memory
 * database from events up to `asOf`, so callers must query it instead of
 * `database` for anything intent-related when `asOf` is set.
 *
 * Traces resolve their org/project through a join to `claude_sessions` (see
 * `queryTraceIntervals`), so `claude_sessions` is copied into the as-of
 * database -- it holds no events of its own and would otherwise be empty.
 */
export function resolveIntentDatabase(database: Database, asOf: string | undefined): Database {
  if (!asOf) return database;
  const asOfDatabase = stateAsOf(database, asOf);

  const sessions = database.query("SELECT * FROM claude_sessions").all() as Record<
    string,
    unknown
  >[];
  if (sessions.length > 0) {
    const columns = Object.keys(sessions[0] as Record<string, unknown>);
    const insert = asOfDatabase.query(
      `INSERT INTO claude_sessions (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    );
    const insertAll = asOfDatabase.transaction(() => {
      for (const session of sessions)
        insert.run(...columns.map((column) => session[column] as never));
    });
    insertAll();
  }

  return asOfDatabase;
}

export interface ActivityRow {
  id: string;
  questId: string | null;
  questTitle: string | null;
  questConfirmed: boolean;
  org: string | null;
  project: string | null;
  objective: string;
  openedAt: string;
  closedAt: string | null;
  outcome: string | null;
  minutes: number;
}

export interface SideQuestRow {
  id: string;
  title: string;
  org: string | null;
  project: string | null;
  fromActivityObjective: string | null;
  branchedAt: string;
  trigger: string | null;
  kind: string | null;
  returnedAt: string | null;
  minutes: number;
}

interface TraceIntervalRow {
  activityId: string;
  startedAt: string;
  endedAt: string;
  org: string | null;
  project: string | null;
}

function toDayBounds(range: DateRange): { start: string; end: string } {
  const fromBounds = localDayBoundsUtc(range.from, range.timeZone);
  const toBounds = localDayBoundsUtc(range.to, range.timeZone);
  return { start: fromBounds.start, end: toBounds.end };
}

/**
 * Intent projection tables are created lazily by the first event applied or
 * by `tempad rebuild` (see `src/intent/projections/index.ts`). A Hero who has
 * never used the intent layer has a database without them; reports must
 * still render, just with nothing to say about quests and activities.
 */
function hasIntentTables(database: Database): boolean {
  const row = database
    .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'activities'")
    .get();
  return row !== null;
}

/**
 * Only current (non-superseded) trace links -- a relinked trace's time counts
 * once, under whichever activity it is linked to now, never under both.
 */
function queryTraceIntervals(database: Database, range: DateRange): TraceIntervalRow[] {
  const { start, end } = toDayBounds(range);
  const conditions = ["t.started_at < ?", "t.ended_at > ?"];
  const params: (string | number)[] = [end, start];

  if (range.org) {
    conditions.push("LOWER(s.org) = ?");
    params.push(range.org.toLowerCase());
  }
  if (range.project) {
    conditions.push("LOWER(s.project) = ?");
    params.push(range.project.toLowerCase());
  }

  return database
    .query(
      `SELECT tl.activity_id as activityId, t.started_at as startedAt, t.ended_at as endedAt,
              s.org as org, s.project as project
       FROM trace_links tl
       JOIN traces t ON t.id = tl.trace_id
       LEFT JOIN claude_sessions s ON s.id = t.session_id
       WHERE tl.superseded_at IS NULL AND ${conditions.join(" AND ")}
       ORDER BY t.started_at ASC`,
    )
    .all(...params) as TraceIntervalRow[];
}

/** Minutes of trace time clipped to [start, end), summed per activity id. */
function minutesByActivity(
  intervals: TraceIntervalRow[],
  start: string,
  end: string,
): Map<string, number> {
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  const minutes = new Map<string, number>();

  for (const interval of intervals) {
    const intervalStart = Math.max(new Date(interval.startedAt).getTime(), startMs);
    const intervalEnd = Math.min(new Date(interval.endedAt).getTime(), endMs);
    if (intervalEnd <= intervalStart) continue;
    const minutesInRange = (intervalEnd - intervalStart) / 60000;
    minutes.set(interval.activityId, (minutes.get(interval.activityId) ?? 0) + minutesInRange);
  }

  return minutes;
}

/** Org/project for an activity, taken from its earliest linked trace's session. */
function projectByActivity(
  intervals: TraceIntervalRow[],
): Map<string, { org: string; project: string }> {
  const projects = new Map<string, { org: string; project: string }>();
  for (const interval of intervals) {
    if (projects.has(interval.activityId)) continue;
    if (interval.org && interval.project) {
      projects.set(interval.activityId, { org: interval.org, project: interval.project });
    }
  }
  return projects;
}

export function queryActivities(database: Database, range: DateRange): ActivityRow[] {
  if (!hasIntentTables(database)) return [];
  const { start, end } = toDayBounds(range);
  const intervals = queryTraceIntervals(database, range);
  const minutes = minutesByActivity(intervals, start, end);
  const projects = projectByActivity(intervals);

  const activityIds = new Set(intervals.map((interval) => interval.activityId));
  if (activityIds.size === 0) return [];

  const rows = database
    .query(
      `SELECT a.id as id, a.quest_id as questId, a.objective as objective,
              a.opened_at as openedAt, a.closed_at as closedAt, a.outcome as outcome,
              q.title as questTitle, q.confirmed as questConfirmed
       FROM activities a
       LEFT JOIN quests q ON q.id = a.quest_id
       WHERE a.id IN (${[...activityIds].map(() => "?").join(", ")})`,
    )
    .all(...activityIds) as {
    id: string;
    questId: string | null;
    objective: string;
    openedAt: string;
    closedAt: string | null;
    outcome: string | null;
    questTitle: string | null;
    questConfirmed: number | null;
  }[];

  return rows
    .map((row) => {
      const project = projects.get(row.id) ?? null;
      return {
        id: row.id,
        questId: row.questId,
        questTitle: row.questTitle,
        questConfirmed: row.questConfirmed === 1,
        org: project?.org ?? null,
        project: project?.project ?? null,
        objective: row.objective,
        openedAt: row.openedAt,
        closedAt: row.closedAt,
        outcome: row.outcome,
        minutes: minutes.get(row.id) ?? 0,
      };
    })
    .sort((a, b) => a.openedAt.localeCompare(b.openedAt));
}

export function querySideQuests(database: Database, range: DateRange): SideQuestRow[] {
  if (!hasIntentTables(database)) return [];
  const { start, end } = toDayBounds(range);
  const intervals = queryTraceIntervals(database, range);
  const minutesByQuestActivity = minutesByActivity(intervals, start, end);
  const projects = projectByActivity(intervals);

  const conditions = ["q.branched_at IS NOT NULL", "q.branched_at >= ?", "q.branched_at < ?"];
  const params: (string | number)[] = [start, end];

  const rows = database
    .query(
      `SELECT q.id as id, q.title as title, q.branched_at as branchedAt, q.trigger as trigger,
              q.branch_kind as kind, q.returned_at as returnedAt,
              (SELECT a.objective FROM activities a WHERE a.id = q.origin_activity_id) as fromActivityObjective
       FROM quests q
       WHERE ${conditions.join(" AND ")}
       ORDER BY q.branched_at ASC`,
    )
    .all(...params) as {
    id: string;
    title: string;
    branchedAt: string;
    trigger: string | null;
    kind: string | null;
    returnedAt: string | null;
    fromActivityObjective: string | null;
  }[];

  return rows.map((row) => {
    const questActivities = database
      .query("SELECT id FROM activities WHERE quest_id = ?")
      .all(row.id) as { id: string }[];

    let minutes = 0;
    let project: { org: string; project: string } | null = null;
    for (const activity of questActivities) {
      minutes += minutesByQuestActivity.get(activity.id) ?? 0;
      project ??= projects.get(activity.id) ?? null;
    }

    return {
      id: row.id,
      title: row.title,
      org: project?.org ?? null,
      project: project?.project ?? null,
      fromActivityObjective: row.fromActivityObjective,
      branchedAt: row.branchedAt,
      trigger: row.trigger,
      kind: row.kind,
      returnedAt: row.returnedAt,
      minutes,
    };
  });
}

export interface QuestSummaryRow {
  id: string;
  title: string;
  confirmed: boolean;
  state: string;
  org: string | null;
  project: string | null;
  firstEvidence: string;
  lastEvidence: string;
  activities: number;
  sideQuestMinutes: number;
}

/**
 * One row per quest with an activity touched in range (a linked trace
 * started or ended in range), for the project report's quest table.
 * `commits`/`sessions` are not counted here -- quests carry no direct link
 * to `gh_commits`/`claude_sessions` rows, only to traces, which the caller
 * already has by org/project from `queryCommits`/`querySessions`.
 */
export function queryQuests(database: Database, range: DateRange): QuestSummaryRow[] {
  if (!hasIntentTables(database)) return [];
  const intervals = queryTraceIntervals(database, range);
  const projects = projectByActivity(intervals);

  const activityIds = new Set(intervals.map((interval) => interval.activityId));
  if (activityIds.size === 0) return [];

  const activityRows = database
    .query(
      `SELECT id, quest_id as questId, opened_at as openedAt, closed_at as closedAt
       FROM activities WHERE id IN (${[...activityIds].map(() => "?").join(", ")})`,
    )
    .all(...activityIds) as {
    id: string;
    questId: string | null;
    openedAt: string;
    closedAt: string | null;
  }[];

  const questIds = new Set(
    activityRows.map((row) => row.questId).filter((id): id is string => id !== null),
  );
  if (questIds.size === 0) return [];

  const questRows = database
    .query(
      `SELECT id, title, confirmed, state FROM quests WHERE id IN (${[...questIds]
        .map(() => "?")
        .join(", ")})`,
    )
    .all(...questIds) as { id: string; title: string; confirmed: number; state: string }[];

  const sideQuestMinutesByQuestId = new Map<string, number>();
  for (const sideQuest of querySideQuests(database, range)) {
    const origin = database
      .query("SELECT origin_activity_id as originActivityId FROM quests WHERE id = ?")
      .get(sideQuest.id) as { originActivityId: string | null } | null;
    const parentId = activityRows.find((row) => row.id === origin?.originActivityId)?.questId;
    if (!parentId) continue;
    sideQuestMinutesByQuestId.set(
      parentId,
      (sideQuestMinutesByQuestId.get(parentId) ?? 0) + sideQuest.minutes,
    );
  }

  return questRows.map((quest) => {
    const questActivities = activityRows.filter((row) => row.questId === quest.id);
    const evidenceTimes = questActivities.flatMap((row) =>
      row.closedAt ? [row.openedAt, row.closedAt] : [row.openedAt],
    );
    const firstEvidence = evidenceTimes.reduce((min, time) => (time < min ? time : min));
    const lastEvidence = evidenceTimes.reduce((max, time) => (time > max ? time : max));

    let project: { org: string; project: string } | null = null;
    for (const activity of questActivities) {
      project ??= projects.get(activity.id) ?? null;
    }

    return {
      id: quest.id,
      title: quest.title,
      confirmed: quest.confirmed === 1,
      state: quest.state,
      org: project?.org ?? null,
      project: project?.project ?? null,
      firstEvidence,
      lastEvidence,
      activities: questActivities.length,
      sideQuestMinutes: sideQuestMinutesByQuestId.get(quest.id) ?? 0,
    };
  });
}

/**
 * Traces `tempad review` will surface: those attached to an expired question,
 * or classified with zero confidence (the model dropped them per spec's error
 * handling). Counted per range/org/project by the trace's recorded session.
 */
export function queryOpenQuestions(database: Database, range: DateRange): number {
  if (!hasIntentTables(database)) return 0;
  const { start, end } = toDayBounds(range);
  const conditions = ["t.recorded_at >= ?", "t.recorded_at < ?"];
  const params: (string | number)[] = [start, end];

  if (range.org) {
    conditions.push("LOWER(s.org) = ?");
    params.push(range.org.toLowerCase());
  }
  if (range.project) {
    conditions.push("LOWER(s.project) = ?");
    params.push(range.project.toLowerCase());
  }

  const row = database
    .query(
      `SELECT COUNT(DISTINCT t.id) as count
       FROM traces t
       LEFT JOIN claude_sessions s ON s.id = t.session_id
       LEFT JOIN questions qu ON qu.trace_id = t.id
       WHERE ${conditions.join(" AND ")}
         AND (t.confidence = 0 OR qu.state = 'expired')`,
    )
    .get(...params) as { count: number };
  return row.count;
}
