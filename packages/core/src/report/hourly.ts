import type { Database } from "bun:sqlite";
import type { Config } from "../config/env.ts";
import { dayRange, heading, localDay, localHour, table } from "./markdown.ts";
import {
  groupDuplicateCommits,
  isNamedTitleSource,
  queryCommits,
  querySessionMessagesByHour,
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
  const messages = querySessionMessagesByHour(database, range);

  const days = dayRange(options.from, options.to);
  const sections: string[] = [heading(1, `hourly report ${options.from} to ${options.to}`)];

  for (const day of days) {
    const dayCommits = commits.filter((row) => localDay(row.authoredAt, timeZone) === day);
    const dayMessages = messages.filter((row) => localDay(row.ts, timeZone) === day);

    const keys = new Map<string, ProjectKey>();
    for (const row of [...dayCommits, ...dayMessages]) {
      keys.set(projectKeyString({ org: row.org, project: row.project }), {
        org: row.org,
        project: row.project,
      });
    }
    const projectKeys = [...keys.values()].sort((a, b) =>
      projectKeyString(a).localeCompare(projectKeyString(b)),
    );

    const lines = [heading(2, day)];

    if (projectKeys.length === 0) {
      lines.push("no evidence");
      sections.push(lines.join("\n"));
      continue;
    }

    const headers = ["hour", ...projectKeys.map(projectKeyString)];
    const rows: string[][] = [];

    for (let hour = 0; hour < 24; hour++) {
      const label = `${String(hour).padStart(2, "0")}:00`;
      const row = [label];

      for (const key of projectKeys) {
        const cellCommits = dayCommits.filter(
          (row) =>
            row.org === key.org &&
            row.project === key.project &&
            localHour(row.authoredAt, timeZone) === hour,
        );

        const hourMessages = dayMessages.filter(
          (row) =>
            row.org === key.org &&
            row.project === key.project &&
            localHour(row.ts, timeZone) === hour,
        );

        const bySession = new Map<
          string,
          { title: string | null; titleSource: string | null; count: number }
        >();
        for (const message of hourMessages) {
          const existing = bySession.get(message.sessionId);
          if (existing) {
            existing.count += 1;
          } else {
            bySession.set(message.sessionId, {
              title: message.title,
              titleSource: message.titleSource,
              count: 1,
            });
          }
        }

        const parts: string[] = [];
        let untitledCount = 0;
        let untitledMessages = 0;
        for (const session of bySession.values()) {
          if (isNamedTitleSource(session.titleSource)) {
            parts.push(`${session.title ?? "(untitled session)"} (${session.count} messages)`);
          } else {
            untitledCount += 1;
            untitledMessages += session.count;
          }
        }
        if (untitledCount > 0) {
          parts.push(`+${untitledCount} untitled (${untitledMessages} messages)`);
        }
        for (const group of groupDuplicateCommits(cellCommits)) {
          const suffix = group.count > 1 ? ` (x${group.count})` : "";
          parts.push(`${group.sha.slice(0, 7)}${suffix}`);
        }

        row.push(parts.join("; "));
      }

      rows.push(row);
    }

    lines.push("", table(headers, rows));
    sections.push(lines.join("\n"));
  }

  return sections.join("\n\n");
}

export const hourlyReport: Report = {
  kind: "hourly",
  render,
};
