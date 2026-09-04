import type { Database } from "bun:sqlite";
import { localDay, localDayBoundsUtc } from "./markdown.ts";

export interface DateRange {
  from: string;
  to: string;
  timeZone: string;
  org?: string;
  project?: string;
}

export interface CommitRow {
  sha: string;
  repo: string;
  org: string;
  project: string;
  authoredAt: string;
  subject: string;
  branches: string;
}

export interface SessionRow {
  id: string;
  org: string;
  project: string;
  title: string | null;
  titleSource: string | null;
  gitBranch: string | null;
  startedAt: string;
  endedAt: string;
  messageCount: number;
}

export interface SessionMessageHourRow {
  sessionId: string;
  org: string;
  project: string;
  title: string | null;
  titleSource: string | null;
  ts: string;
  count: number;
}

export interface MondayItemRow {
  id: number;
  org: string;
  project: string;
  boardName: string;
  name: string;
  status: string | null;
  timelineStart: string | null;
  timelineEnd: string | null;
  updatedAt: string;
}

export interface PullRequestRow {
  repo: string;
  org: string;
  project: string;
  number: number;
  title: string;
  state: string;
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
}

function toDayBounds(range: DateRange): { start: string; end: string } {
  const fromBounds = localDayBoundsUtc(range.from, range.timeZone);
  const toBounds = localDayBoundsUtc(range.to, range.timeZone);
  return { start: fromBounds.start, end: toBounds.end };
}

export function queryCommits(database: Database, range: DateRange): CommitRow[] {
  const { start, end } = toDayBounds(range);
  const conditions = ["c.authored_at >= ?", "c.authored_at < ?"];
  const params: (string | number)[] = [start, end];

  if (range.org) {
    conditions.push("r.org = ?");
    params.push(range.org);
  }
  if (range.project) {
    conditions.push("LOWER(r.project) = ?");
    params.push(range.project.toLowerCase());
  }

  const rows = database
    .query(
      `SELECT c.sha as sha, c.repo as repo, r.org as org, r.project as project,
              c.authored_at as authoredAt, c.subject as subject, c.branches as branches
       FROM gh_commits c
       JOIN gh_repos r ON r.full_name = c.repo
       WHERE ${conditions.join(" AND ")}
       ORDER BY c.authored_at ASC`,
    )
    .all(...params) as CommitRow[];

  return rows;
}

export function querySessions(database: Database, range: DateRange): SessionRow[] {
  const { start, end } = toDayBounds(range);
  const conditions = ["s.started_at < ?", "s.ended_at >= ?"];
  const params: (string | number)[] = [end, start];

  if (range.org) {
    conditions.push("s.org = ?");
    params.push(range.org);
  }
  if (range.project) {
    conditions.push("LOWER(s.project) = ?");
    params.push(range.project.toLowerCase());
  }

  return database
    .query(
      `SELECT s.id as id, s.org as org, s.project as project, s.title as title,
              s.title_source as titleSource, s.git_branch as gitBranch,
              s.started_at as startedAt, s.ended_at as endedAt, s.message_count as messageCount
       FROM claude_sessions s
       WHERE ${conditions.join(" AND ")}
       ORDER BY s.started_at ASC`,
    )
    .all(...params) as SessionRow[];
}

export function querySessionMessagesByHour(
  database: Database,
  range: DateRange,
): SessionMessageHourRow[] {
  const { start, end } = toDayBounds(range);
  const conditions = ["m.ts >= ?", "m.ts < ?"];
  const params: (string | number)[] = [start, end];

  if (range.org) {
    conditions.push("s.org = ?");
    params.push(range.org);
  }
  if (range.project) {
    conditions.push("LOWER(s.project) = ?");
    params.push(range.project.toLowerCase());
  }

  return database
    .query(
      `SELECT s.id as sessionId, s.org as org, s.project as project, s.title as title,
              s.title_source as titleSource, m.ts as ts, 1 as count
       FROM claude_messages m
       JOIN claude_sessions s ON s.id = m.session_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY m.ts ASC`,
    )
    .all(...params) as SessionMessageHourRow[];
}

export function queryMondayItems(database: Database, range: DateRange): MondayItemRow[] {
  const { start, end } = toDayBounds(range);
  // timeline_start/timeline_end are bare local dates (YYYY-MM-DD, no zone), so the exclusive
  // end of the range as a day string comes from formatting the (already zone-aware) end instant.
  const endDay = localDay(end, range.timeZone);
  const conditions = [
    "((i.timeline_start IS NOT NULL AND i.timeline_end IS NOT NULL AND i.timeline_start < ? AND i.timeline_end >= ?) OR (i.updated_at >= ? AND i.updated_at < ?))",
  ];
  const params: (string | number)[] = [endDay, range.from, start, end];

  if (range.org) {
    conditions.push("i.org = ?");
    params.push(range.org);
  }
  if (range.project) {
    conditions.push("LOWER(i.project) = ?");
    params.push(range.project.toLowerCase());
  }

  const rows = database
    .query(
      `SELECT i.id as id, i.board_name as boardName, i.name as name, i.status as status,
              i.timeline_start as timelineStart, i.timeline_end as timelineEnd,
              i.updated_at as updatedAt, i.org as org, i.project as project
       FROM monday_items i
       WHERE ${conditions.join(" AND ")}
       ORDER BY i.updated_at ASC`,
    )
    .all(...params) as MondayItemRow[];

  return rows;
}

export function queryPullRequests(database: Database, range: DateRange): PullRequestRow[] {
  const { start, end } = toDayBounds(range);
  const conditions = [
    "((p.created_at >= ? AND p.created_at < ?) OR (p.merged_at >= ? AND p.merged_at < ?) OR (p.closed_at >= ? AND p.closed_at < ?))",
  ];
  const params: (string | number)[] = [start, end, start, end, start, end];

  if (range.org) {
    conditions.push("r.org = ?");
    params.push(range.org);
  }
  if (range.project) {
    conditions.push("LOWER(r.project) = ?");
    params.push(range.project.toLowerCase());
  }

  const rows = database
    .query(
      `SELECT p.repo as repo, r.org as org, r.project as project, p.number as number,
              p.title as title, p.state as state,
              p.created_at as createdAt, p.merged_at as mergedAt, p.closed_at as closedAt
       FROM gh_pull_requests p
       JOIN gh_repos r ON r.full_name = p.repo
       WHERE ${conditions.join(" AND ")}
       ORDER BY p.created_at ASC`,
    )
    .all(...params) as PullRequestRow[];

  return rows;
}
