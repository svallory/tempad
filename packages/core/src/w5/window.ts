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
}

export function buildWindow(database: Database, input: BuildWindowInput): ClassifierWindow {
  const session = database
    .query(
      "SELECT title, cwd, git_branch as gitBranch, org, project FROM claude_sessions WHERE id = ?",
    )
    .get(input.sessionId) as {
    title: string | null;
    cwd: string | null;
    gitBranch: string | null;
    org: string;
    project: string;
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

  const previousTraceRow = database
    .query(
      `SELECT traces.activity_id as activityId, traces.what as what, activities.quest_id as questId
         FROM traces
         JOIN activities ON activities.id = traces.activity_id
        WHERE traces.session_id = ?
        ORDER BY traces.started_at DESC LIMIT 1`,
    )
    .get(input.sessionId) as { activityId: string; what: string; questId: string | null } | null;

  return {
    sessionId: input.sessionId,
    title: session.title,
    cwd: session.cwd,
    gitBranch: session.gitBranch,
    org: session.org,
    project: session.project,
    messages,
    openQuests,
    previousTrace: previousTraceRow,
  };
}
