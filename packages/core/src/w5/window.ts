import type { Database } from "bun:sqlite";
import type { ClassifierWindow } from "./classifier";

export function findSessionFile(database: Database, sessionId: string): string | null {
  const row = database
    .query("SELECT file_path FROM claude_sessions WHERE id = ?")
    .get(sessionId) as { file_path: string } | null;
  return row?.file_path ?? null;
}

export interface BuildWindowInput {
  sessionId: string;
  sinceTs: string | null;
  maxMessages: number;
  memoryHours: number;
  memoryActivities: number;
  overlapMessages: number;
}

interface ActivityRow {
  activityId: string;
  what: string;
  why: string;
  questId: string | null;
  questTitle: string | null;
  openedAt: string;
  lastTraceEndedAt: string;
}

/**
 * An activity plus the `what`/`why` of its latest live trace and its last trace's
 * `ended_at`. `traces.session_id` decides which session an activity belongs to.
 */
const ACTIVITY_SLICE_SELECT = `
  SELECT activities.id as activityId,
         latest.what as what,
         latest.why as why,
         activities.quest_id as questId,
         quests.title as questTitle,
         activities.opened_at as openedAt,
         latest.ended_at as lastTraceEndedAt,
         activities.closed_at as closedAt,
         activities.close_reason as closeReason
    FROM activities
    JOIN traces latest ON latest.id = (
           SELECT traces.id FROM traces
            WHERE traces.activity_id = activities.id AND traces.retracted_at IS NULL
            ORDER BY traces.ended_at DESC LIMIT 1)
    LEFT JOIN quests ON quests.id = activities.quest_id
   WHERE activities.retracted_at IS NULL`;

export function buildWindow(database: Database, input: BuildWindowInput): ClassifierWindow {
  const session = database
    .query(
      "SELECT title, cwd, git_branch as gitBranch, org, project, started_at as startedAt FROM claude_sessions WHERE id = ?",
    )
    .get(input.sessionId) as {
    title: string | null;
    cwd: string | null;
    gitBranch: string | null;
    org: string;
    project: string;
    startedAt: string | null;
  } | null;

  if (!session) {
    throw new Error(`unknown claude session: ${input.sessionId}`);
  }

  const messageRows =
    input.sinceTs !== null
      ? (database
          .query(
            `SELECT ts, role, text_preview as text FROM claude_messages
             WHERE session_id = ? AND ts > ? AND text_preview IS NOT NULL
             ORDER BY ts ASC`,
          )
          .all(input.sessionId, input.sinceTs) as { ts: string; role: string; text: string }[])
      : (
          database
            .query(
              `SELECT ts, role, text_preview as text FROM claude_messages
             WHERE session_id = ? AND text_preview IS NOT NULL
             ORDER BY ts DESC LIMIT ?`,
            )
            .all(input.sessionId, input.maxMessages) as { ts: string; role: string; text: string }[]
        ).reverse();

  const messages = input.sinceTs !== null ? messageRows.slice(-input.maxMessages) : messageRows;

  const openQuests = database
    .query(
      `SELECT quests.id as id, quests.title as title, quests.objective as objective,
              (SELECT MAX(traces.started_at) FROM traces
                 JOIN activities ON activities.id = traces.activity_id
                WHERE activities.quest_id = quests.id) as lastActivityAt
         FROM quests
        WHERE quests.state IN ('started', 'resumed')
          AND quests.merged_into IS NULL
          AND (
            quests.owner_kind = 'hero'
            OR quests.owner_id IN (SELECT id FROM parties WHERE slug = ?)
          )`,
    )
    .all(session.org) as {
    id: string;
    title: string;
    objective: string | null;
    lastActivityAt: string | null;
  }[];

  const sessionOpenActivities = database
    .query(
      `${ACTIVITY_SLICE_SELECT}
         AND activities.closed_at IS NULL
         AND latest.session_id = ?
       ORDER BY activities.opened_at ASC`,
    )
    .all(input.sessionId) as (ActivityRow & {
    closedAt: string | null;
    closeReason: string | null;
  })[];

  // The reference time for "recent": where this window starts, so backfill windows
  // see the same slice a live run would have seen at that point in the session.
  const referenceTime = input.sinceTs ?? session.startedAt ?? new Date().toISOString();
  const memoryCutoff = new Date(
    Date.parse(referenceTime) - input.memoryHours * 60 * 60 * 1000,
  ).toISOString();

  // Closed activities of *this* session belong here too: an idle gap mid-session
  // closes an activity, and returning to it afterwards is exactly a `continues`
  // link. Still-open ones are already in `sessionOpenActivities`, so no activity
  // appears in both slices.
  const recentActivities = database
    .query(
      `${ACTIVITY_SLICE_SELECT}
         AND (activities.opened_at >= ? OR activities.closed_at >= ?)
         AND (latest.session_id != ? OR activities.closed_at IS NOT NULL)
         AND latest.place = ?
       ORDER BY COALESCE(activities.closed_at, activities.opened_at) DESC
       LIMIT ?`,
    )
    .all(
      memoryCutoff,
      memoryCutoff,
      input.sessionId,
      `${session.org}/${session.project}`,
      input.memoryActivities,
    ) as (ActivityRow & { closedAt: string | null; closeReason: string | null })[];

  const recentSideQuests = database
    .query(
      `SELECT quests.id as id, quests.title as title, quests.trigger as trigger
         FROM quests
        WHERE quests.origin_activity_id IS NOT NULL
          AND quests.trigger IS NOT NULL
          AND quests.retracted_at IS NULL
          AND (
            quests.owner_kind = 'hero'
            OR quests.owner_id IN (SELECT id FROM parties WHERE slug = ?)
          )
        ORDER BY quests.branched_at DESC
        LIMIT 3`,
    )
    .all(session.org) as { id: string; title: string; trigger: string }[];

  // Only a window with a cut has messages "before" it. A whole-session window
  // (sinceTs null, as backfill builds) starts at the session's first message, so
  // there is no tail to carry and nothing may be marked as context-only.
  const overlapMessages =
    input.sinceTs === null || input.overlapMessages <= 0
      ? []
      : (
          database
            .query(
              `SELECT ts, role, text_preview as text FROM claude_messages
                WHERE session_id = ? AND ts <= ? AND text_preview IS NOT NULL
                ORDER BY ts DESC LIMIT ?`,
            )
            .all(input.sessionId, input.sinceTs, input.overlapMessages) as {
            ts: string;
            role: string;
            text: string;
          }[]
        ).reverse();

  const runRow = database
    .query("SELECT session_note FROM w5_runs WHERE session_id = ?")
    .get(input.sessionId) as { session_note: string | null } | null;

  return {
    sessionId: input.sessionId,
    title: session.title,
    cwd: session.cwd,
    gitBranch: session.gitBranch,
    org: session.org,
    project: session.project,
    messages,
    openQuests,
    sessionOpenActivities: sessionOpenActivities.map(
      ({ closedAt: _closedAt, closeReason: _closeReason, ...activity }) => activity,
    ),
    recentActivities,
    recentSideQuests,
    overlapMessages,
    previousSessionNote: runRow?.session_note ?? null,
  };
}
