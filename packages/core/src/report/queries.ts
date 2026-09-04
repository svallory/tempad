import type { Database } from "bun:sqlite";
import { localDayBoundsUtc } from "./markdown.ts";

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
  startedAt: string;
  endedAt: string;
  messageCount: number;
}

export interface SessionMessageHourRow {
  sessionId: string;
  org: string;
  project: string;
  title: string | null;
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

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
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
    conditions.push("LOWER(r.full_name) LIKE ?");
    params.push(`%/${range.project.toLowerCase()}`);
  }

  const rows = database
    .query(
      `SELECT c.sha as sha, c.repo as repo, r.org as org, c.authored_at as authoredAt,
              c.subject as subject, c.branches as branches
       FROM gh_commits c
       JOIN gh_repos r ON r.full_name = c.repo
       WHERE ${conditions.join(" AND ")}
       ORDER BY c.authored_at ASC`,
    )
    .all(...params) as Array<Omit<CommitRow, "project">>;

  return rows.map((row) => ({
    ...row,
    project: repoNameFromFullName(row.repo).toLowerCase(),
  }));
}

function repoNameFromFullName(fullName: string): string {
  const slashIndex = fullName.lastIndexOf("/");
  return slashIndex === -1 ? fullName : fullName.slice(slashIndex + 1);
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
              m.ts as ts, 1 as count
       FROM claude_messages m
       JOIN claude_sessions s ON s.id = m.session_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY m.ts ASC`,
    )
    .all(...params) as SessionMessageHourRow[];
}

export function queryMondayItems(database: Database, range: DateRange): MondayItemRow[] {
  const { start, end } = toDayBounds(range);
  const conditions = [
    "((i.timeline_start IS NOT NULL AND i.timeline_end IS NOT NULL AND i.timeline_start <= ? AND i.timeline_end >= ?) OR (i.updated_at >= ? AND i.updated_at < ?))",
  ];
  const params: (string | number)[] = [range.to, range.from, start, end];

  if (range.project) {
    conditions.push("LOWER(?) = ?");
    params.push(range.project.toLowerCase(), range.project.toLowerCase());
  }

  const rows = database
    .query(
      `SELECT i.id as id, i.board_name as boardName, i.name as name, i.status as status,
              i.timeline_start as timelineStart, i.timeline_end as timelineEnd,
              i.updated_at as updatedAt
       FROM monday_items i
       WHERE ${conditions.join(" AND ")}
       ORDER BY i.updated_at ASC`,
    )
    .all(...params) as Array<Omit<MondayItemRow, "org" | "project">>;

  return rows
    .map((row) => ({
      ...row,
      org: "monday",
      project: slugify(row.boardName),
    }))
    .filter((row) => (range.project ? row.project === range.project.toLowerCase() : true))
    .filter((row) => (range.org ? row.org === range.org : true));
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
    conditions.push("LOWER(r.full_name) LIKE ?");
    params.push(`%/${range.project.toLowerCase()}`);
  }

  const rows = database
    .query(
      `SELECT p.repo as repo, r.org as org, p.number as number, p.title as title, p.state as state,
              p.created_at as createdAt, p.merged_at as mergedAt, p.closed_at as closedAt
       FROM gh_pull_requests p
       JOIN gh_repos r ON r.full_name = p.repo
       WHERE ${conditions.join(" AND ")}
       ORDER BY p.created_at ASC`,
    )
    .all(...params) as Array<Omit<PullRequestRow, "project">>;

  return rows.map((row) => ({
    ...row,
    project: repoNameFromFullName(row.repo).toLowerCase(),
  }));
}
