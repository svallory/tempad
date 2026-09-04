import type { Database } from "bun:sqlite";
import type { Config } from "../config/env.ts";
import { dayRange, heading, isWeekend, localDay, localTime, localWeekday } from "./markdown.ts";
import {
  type CommitRow,
  type MondayItemRow,
  type PullRequestRow,
  queryCommits,
  queryMondayItems,
  queryPullRequests,
  querySessions,
  type SessionRow,
} from "./queries.ts";
import type { Report, ReportOptions } from "./types.ts";

interface ProjectKey {
  org: string;
  project: string;
}

function projectKeyString(key: ProjectKey): string {
  return `${key.org}/${key.project}`;
}

function render(database: Database, config: Config, options: ReportOptions): string {
  const timeZone = config.tz;
  const range = {
    from: options.from,
    to: options.to,
    timeZone,
    org: options.org,
    project: options.project,
  };

  const commits = queryCommits(database, range);
  const sessions = querySessions(database, range);
  const mondayItems = queryMondayItems(database, range);
  const pullRequests = queryPullRequests(database, range);

  const days = dayRange(options.from, options.to);
  const sections: string[] = [heading(1, `daily report ${options.from} to ${options.to}`)];

  for (const day of days) {
    const dayCommits = commits.filter((row) => localDay(row.authoredAt, timeZone) === day);
    const daySessions = sessions.filter((row) => sessionTouchesDay(row, day, timeZone));
    const dayMondayItems = mondayItems.filter((row) => mondayTouchesDay(row, day));
    const dayPullRequests = pullRequests.filter((row) => pullRequestTouchesDay(row, day, timeZone));

    const hasEvidence =
      dayCommits.length > 0 ||
      daySessions.length > 0 ||
      dayMondayItems.length > 0 ||
      dayPullRequests.length > 0;

    if (!hasEvidence && isWeekend(day, timeZone)) continue;

    const weekday = localWeekday(day, timeZone);
    const lines: string[] = [heading(2, `${day} (${weekday})`)];

    if (!hasEvidence) {
      lines.push("- no evidence");
      sections.push(lines.join("\n"));
      continue;
    }

    const projectKeys = collectProjectKeys(
      dayCommits,
      daySessions,
      dayMondayItems,
      dayPullRequests,
    );

    for (const key of projectKeys) {
      lines.push(heading(3, projectKeyString(key)));

      for (const commit of dayCommits.filter((row) => matchesKey(row, key))) {
        lines.push(`- ${commit.sha.slice(0, 7)} ${commit.subject} (${commit.repo})`);
      }
      for (const session of daySessions.filter((row) => matchesKey(row, key))) {
        const startTime = localTime(session.startedAt, timeZone);
        const endTime = localTime(session.endedAt, timeZone);
        const title = session.title ?? "(untitled session)";
        lines.push(`- ${title}, ${startTime} to ${endTime}, ${session.messageCount} messages`);
      }
      for (const item of dayMondayItems.filter((row) => matchesKey(row, key))) {
        const timeline =
          item.timelineStart && item.timelineEnd
            ? `${item.timelineStart} to ${item.timelineEnd}`
            : "no timeline";
        lines.push(`- [${item.status ?? "no status"}] ${item.name}, timeline ${timeline}`);
      }
      for (const pr of dayPullRequests.filter((row) => matchesKey(row, key))) {
        const action = prAction(pr, day, timeZone);
        lines.push(`- #${pr.number} ${pr.title}, ${action}`);
      }
    }

    sections.push(lines.join("\n"));
  }

  if (sections.length === 1) sections.push("no evidence");

  return sections.join("\n\n");
}

function sessionTouchesDay(session: SessionRow, day: string, timeZone: string): boolean {
  return (
    localDay(session.startedAt, timeZone) === day || localDay(session.endedAt, timeZone) === day
  );
}

function mondayTouchesDay(item: MondayItemRow, day: string): boolean {
  if (item.timelineStart && item.timelineEnd) {
    if (item.timelineStart <= day && item.timelineEnd >= day) return true;
  }
  return item.updatedAt.slice(0, 10) === day;
}

function pullRequestTouchesDay(pr: PullRequestRow, day: string, timeZone: string): boolean {
  if (localDay(pr.createdAt, timeZone) === day) return true;
  if (pr.mergedAt && localDay(pr.mergedAt, timeZone) === day) return true;
  if (pr.closedAt && localDay(pr.closedAt, timeZone) === day) return true;
  return false;
}

function prAction(pr: PullRequestRow, day: string, timeZone: string): string {
  if (pr.mergedAt && localDay(pr.mergedAt, timeZone) === day) return "merged";
  if (pr.closedAt && localDay(pr.closedAt, timeZone) === day) return "closed";
  if (localDay(pr.createdAt, timeZone) === day) return "opened";
  return pr.state;
}

function matchesKey(row: { org: string; project: string }, key: ProjectKey): boolean {
  return row.org === key.org && row.project === key.project;
}

function collectProjectKeys(
  commits: CommitRow[],
  sessions: SessionRow[],
  mondayItems: MondayItemRow[],
  pullRequests: PullRequestRow[],
): ProjectKey[] {
  const keys = new Map<string, ProjectKey>();
  for (const row of [...commits, ...sessions, ...mondayItems, ...pullRequests]) {
    const key = { org: row.org, project: row.project };
    keys.set(projectKeyString(key), key);
  }
  return [...keys.values()].sort((a, b) => projectKeyString(a).localeCompare(projectKeyString(b)));
}

export const dailyReport: Report = {
  kind: "daily",
  render,
};
