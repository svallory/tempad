import type { Database } from "bun:sqlite";
import type { Config } from "../config/env.ts";
import { elapsedLabel, heading, table } from "./markdown.ts";
import { type CommitRow, queryCommits, queryMondayItems, querySessions } from "./queries.ts";
import type { Report, ReportOptions } from "./types.ts";

interface ProjectKey {
  org: string;
  project: string;
}

function projectKeyString(key: ProjectKey): string {
  return `${key.org}/${key.project}`;
}

function inferBranch(branchesJson: string): string {
  const branches = JSON.parse(branchesJson) as string[];
  const nonDefault = branches.filter((branch) => branch !== "main" && branch !== "dev");
  const candidates = nonDefault.length > 0 ? nonDefault : branches;
  return candidates.reduce(
    (longest, current) => (current.length > longest.length ? current : longest),
    candidates[0] ?? "unknown",
  );
}

function render(database: Database, config: Config, options: ReportOptions): string {
  const range = {
    from: options.from,
    to: options.to,
    timeZone: config.tz,
    org: options.org,
    project: options.project,
  };

  const commits = queryCommits(database, range);
  const sessions = querySessions(database, range);
  const mondayItems = queryMondayItems(database, range);

  const keys = new Map<string, ProjectKey>();
  for (const row of [...commits, ...sessions, ...mondayItems]) {
    keys.set(projectKeyString({ org: row.org, project: row.project }), {
      org: row.org,
      project: row.project,
    });
  }

  const sortedKeys = [...keys.values()].sort((a, b) =>
    projectKeyString(a).localeCompare(projectKeyString(b)),
  );

  const sections: string[] = [];

  for (const key of sortedKeys) {
    const projectCommits = commits.filter(
      (row) => row.org === key.org && row.project === key.project,
    );
    const projectSessions = sessions.filter(
      (row) => row.org === key.org && row.project === key.project,
    );
    const projectMondayItems = mondayItems.filter(
      (row) => row.org === key.org && row.project === key.project,
    );

    const rows: string[][] =
      projectMondayItems.length > 0
        ? projectMondayItems.map((item) => {
            const first = item.timelineStart ?? item.updatedAt;
            const last = item.timelineEnd ?? item.updatedAt;
            const itemCommits = projectCommits.length;
            const itemSessions = projectSessions.length;
            return [
              item.name,
              first,
              last,
              elapsedLabel(first, last),
              String(itemCommits),
              String(itemSessions),
            ];
          })
        : branchRows(projectCommits, projectSessions);

    const lines = [
      heading(3, projectKeyString(key)),
      "Elapsed is an upper bound.",
      "",
      table(
        ["task", "first evidence", "last evidence", "elapsed (upper bound)", "commits", "sessions"],
        rows,
      ),
    ];
    sections.push(lines.join("\n"));
  }

  return sections.join("\n\n");
}

function branchRows(
  commits: CommitRow[],
  sessions: { startedAt: string; endedAt: string }[],
): string[][] {
  const byBranch = new Map<string, CommitRow[]>();
  for (const commit of commits) {
    const branch = inferBranch(commit.branches);
    const list = byBranch.get(branch) ?? [];
    list.push(commit);
    byBranch.set(branch, list);
  }

  const branches = [...byBranch.keys()].sort();
  return branches.map((branch) => {
    const branchCommits = (byBranch.get(branch) ?? []).sort((a, b) =>
      a.authoredAt.localeCompare(b.authoredAt),
    );
    const first = branchCommits[0]?.authoredAt ?? "";
    const last = branchCommits[branchCommits.length - 1]?.authoredAt ?? "";
    return [
      branch,
      first,
      last,
      elapsedLabel(first, last),
      String(branchCommits.length),
      String(sessions.length),
    ];
  });
}

export const projectReport: Report = {
  kind: "project",
  render,
};
