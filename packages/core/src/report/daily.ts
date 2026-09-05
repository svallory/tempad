import type { Database } from "bun:sqlite";
import type { Config } from "../config/env.ts";
import {
  type ActivityRow,
  queryActivities,
  queryOpenQuestions,
  querySideQuests,
  resolveIntentDatabase,
  type SideQuestRow,
} from "./intent-queries.ts";
import { dayRange, heading, isWeekend, localDay, localTime, localWeekday } from "./markdown.ts";
import {
  type CommitRow,
  groupDuplicateCommits,
  isNamedTitleSource,
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
    client: options.client,
  };
  const intentDatabase = resolveIntentDatabase(database, options.asOf);

  const commits = queryCommits(database, range);
  const sessions = querySessions(database, range);
  const mondayItems = queryMondayItems(database, range);
  const pullRequests = queryPullRequests(database, range);

  const days = dayRange(options.from, options.to);
  const titleSuffix = options.asOf ? ` (as of ${options.asOf})` : "";
  const sections: string[] = [
    heading(1, `daily report ${options.from} to ${options.to}${titleSuffix}`),
  ];

  for (const day of days) {
    const dayCommits = commits.filter((row) => localDay(row.authoredAt, timeZone) === day);
    const daySessions = sessions.filter((row) => sessionTouchesDay(row, day, timeZone));
    const dayMondayItems = mondayItems.filter((row) => mondayTouchesDay(row, day, timeZone));
    const dayPullRequests = pullRequests.filter((row) => pullRequestTouchesDay(row, day, timeZone));
    const dayRangeOptions = {
      from: day,
      to: day,
      timeZone,
      org: options.org,
      project: options.project,
    };
    const dayActivities = queryActivities(intentDatabase, dayRangeOptions);
    const daySideQuests = querySideQuests(intentDatabase, dayRangeOptions);

    const hasEvidence =
      dayCommits.length > 0 ||
      daySessions.length > 0 ||
      dayMondayItems.length > 0 ||
      dayPullRequests.length > 0 ||
      dayActivities.length > 0 ||
      daySideQuests.length > 0;

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
      dayActivities,
      daySideQuests,
    );

    for (const key of projectKeys) {
      lines.push(heading(3, projectKeyString(key)));

      const keyCommits = dayCommits.filter((row) => matchesKey(row, key));
      for (const group of groupDuplicateCommits(keyCommits)) {
        const suffix = group.count > 1 ? ` (x${group.count})` : "";
        lines.push(`- ${group.sha.slice(0, 7)} ${group.subject} (${group.repo})${suffix}`);
      }

      const keySessions = daySessions.filter((row) => matchesKey(row, key));
      const namedSessions = keySessions.filter((row) => isNamedTitleSource(row.titleSource));
      const untitledSessions = keySessions.filter((row) => !isNamedTitleSource(row.titleSource));

      for (const session of namedSessions) {
        const startTime = localTime(session.startedAt, timeZone);
        const endTime = localTime(session.endedAt, timeZone);
        lines.push(
          `- ${session.title ?? "(untitled session)"}, ${startTime} to ${endTime}, ${session.messageCount} messages`,
        );
      }
      if (untitledSessions.length > 0) {
        const totalMessages = untitledSessions.reduce(
          (sum, session) => sum + session.messageCount,
          0,
        );
        lines.push(`- ${untitledSessions.length} untitled sessions (${totalMessages} messages)`);
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

      const keyActivities = dayActivities.filter((row) => matchesKey(row, key));
      if (keyActivities.length > 0) {
        lines.push("Quests");
        for (const [questTitle, questActivities] of groupByQuest(keyActivities)) {
          const unconfirmed = questActivities[0]?.questConfirmed === false ? " [unconfirmed]" : "";
          const objectives = questActivities.map((activity) => activity.objective).join("; ");
          const minutes = questActivities.reduce((sum, activity) => sum + activity.minutes, 0);
          lines.push(`- ${questTitle}${unconfirmed}: ${objectives} (${minutesLabel(minutes)})`);
        }
      }

      const keySideQuests = daySideQuests.filter((row) => matchesKey(row, key));
      if (keySideQuests.length > 0) {
        lines.push("Side quests");
        for (const sideQuest of keySideQuests) {
          const branchTime = localTime(sideQuest.branchedAt, timeZone);
          const returned = sideQuest.returnedAt
            ? `back ${localTime(sideQuest.returnedAt, timeZone)}`
            : "not returned";
          lines.push(
            `- ${sideQuest.title}, branched ${branchTime} from "${sideQuest.fromActivityObjective ?? "unknown"}", trigger: "${sideQuest.trigger ?? "unknown"}", ${returned} (${minutesLabel(sideQuest.minutes)})`,
          );
        }
      }

      const tracesAwaitingReview = queryOpenQuestions(intentDatabase, {
        ...dayRangeOptions,
        org: key.org,
        project: key.project,
      });
      if (tracesAwaitingReview > 0) {
        lines.push(`- ${tracesAwaitingReview} traces awaiting review`);
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

function mondayTouchesDay(item: MondayItemRow, day: string, timeZone: string): boolean {
  if (item.timelineStart && item.timelineEnd) {
    if (item.timelineStart <= day && item.timelineEnd >= day) return true;
  }
  return localDay(item.updatedAt, timeZone) === day;
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

function matchesKey(row: { org: string | null; project: string | null }, key: ProjectKey): boolean {
  return row.org === key.org && row.project === key.project;
}

function collectProjectKeys(
  commits: CommitRow[],
  sessions: SessionRow[],
  mondayItems: MondayItemRow[],
  pullRequests: PullRequestRow[],
  activities: ActivityRow[],
  sideQuests: SideQuestRow[],
): ProjectKey[] {
  const keys = new Map<string, ProjectKey>();
  for (const row of [...commits, ...sessions, ...mondayItems, ...pullRequests]) {
    const key = { org: row.org, project: row.project };
    keys.set(projectKeyString(key), key);
  }
  for (const row of [...activities, ...sideQuests]) {
    if (!row.org || !row.project) continue;
    const key = { org: row.org, project: row.project };
    keys.set(projectKeyString(key), key);
  }
  return [...keys.values()].sort((a, b) => projectKeyString(a).localeCompare(projectKeyString(b)));
}

function minutesLabel(totalMinutes: number): string {
  const rounded = Math.round(totalMinutes);
  const hours = Math.floor(rounded / 60);
  const minutes = rounded % 60;
  return `${hours}h ${minutes}m`;
}

/** Activities grouped by their quest title, in first-seen order. */
function groupByQuest(activities: ActivityRow[]): [string, ActivityRow[]][] {
  const groups = new Map<string, ActivityRow[]>();
  for (const activity of activities) {
    const title = activity.questTitle ?? "(no quest)";
    const list = groups.get(title) ?? [];
    list.push(activity);
    groups.set(title, list);
  }
  return [...groups.entries()];
}

export const dailyReport: Report = {
  kind: "daily",
  render,
};
