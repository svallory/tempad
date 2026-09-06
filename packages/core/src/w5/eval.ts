import { join } from "node:path";
import type { Config } from "../config/env";
import { openDatabase } from "../db/database";
import { defaultIntentConfig } from "../intent/config";
import { backfill } from "./backfill";
import type { Classifier } from "./classifier";

function minimalConfig(scratchDir: string): Config {
  return {
    mondayApiToken: "",
    mondayUser: "",
    ghUser: "",
    ghOrgs: [],
    ghIncludePersonal: false,
    ghToken: undefined,
    gitAuthorEmails: [],
    claudeDirs: [],
    hostSlug: "eval",
    tz: "UTC",
    since: "2020-01-01",
    home: scratchDir,
  };
}

export interface EvalOptions {
  from: string;
  to: string;
  sourceDbPath: string;
  scratchDir: string;
  now: string;
  classifier: Classifier;
  log: (line: string) => void;
}

export interface EvalSampleActivity {
  what: string;
  why: string;
  questTitle: string | null;
  durationMinutes: number | null;
  sessionTitle: string | null;
}

export interface EvalMetrics {
  copiedDbPath: string;
  traces: number;
  activities: number;
  ratio: number;
  medianActivityDurationMinutes: number;
  continuesLinks: number;
  questConflicts: number;
  sample: EvalSampleActivity[];
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  }
  return sorted[mid] as number;
}

function filenameSafe(timestamp: string): string {
  return timestamp.replace(/[:.]/g, "-");
}

export async function runEval(options: EvalOptions): Promise<EvalMetrics> {
  const copiedDbPath = join(options.scratchDir, `eval-${filenameSafe(options.now)}.db`);
  await Bun.write(copiedDbPath, Bun.file(options.sourceDbPath));

  const database = openDatabase(copiedDbPath);
  const intentConfig = defaultIntentConfig();

  const days = Math.max(
    1,
    Math.ceil((Date.parse(options.to) - Date.parse(options.from)) / (24 * 60 * 60 * 1000)),
  );

  const backfillResult = await backfill(
    database,
    minimalConfig(options.scratchDir),
    intentConfig.w5,
    options.classifier,
    {
      days,
      now: options.to,
      log: options.log,
      force: true,
      to: options.to,
    },
  );

  const traceCount = database
    .query("SELECT COUNT(*) as count FROM traces WHERE retracted_at IS NULL")
    .get() as { count: number };
  const activityCount = database
    .query("SELECT COUNT(*) as count FROM activities WHERE retracted_at IS NULL")
    .get() as { count: number };
  const continuesCount = database
    .query(
      "SELECT COUNT(*) as count FROM activities WHERE continues IS NOT NULL AND retracted_at IS NULL",
    )
    .get() as { count: number };

  const durationRows = database
    .query(
      "SELECT opened_at as openedAt, closed_at as closedAt FROM activities WHERE closed_at IS NOT NULL AND retracted_at IS NULL",
    )
    .all() as { openedAt: string; closedAt: string }[];
  const durationsMinutes = durationRows.map(
    (row) => (Date.parse(row.closedAt) - Date.parse(row.openedAt)) / 60_000,
  );

  const sampleRows = database
    .query(
      `SELECT activities.objective as objective,
              quests.title as questTitle,
              activities.opened_at as openedAt, activities.closed_at as closedAt,
              (SELECT traces.what FROM traces
                 WHERE traces.activity_id = activities.id AND traces.retracted_at IS NULL
                 ORDER BY traces.started_at ASC LIMIT 1) as what,
              (SELECT traces.why FROM traces
                 WHERE traces.activity_id = activities.id AND traces.retracted_at IS NULL
                 ORDER BY traces.started_at ASC LIMIT 1) as why,
              (SELECT claude_sessions.title FROM traces
                 JOIN claude_sessions ON claude_sessions.id = traces.session_id
                 WHERE traces.activity_id = activities.id AND traces.retracted_at IS NULL
                 ORDER BY traces.started_at ASC LIMIT 1) as sessionTitle
         FROM activities
         LEFT JOIN quests ON quests.id = activities.quest_id
        WHERE activities.retracted_at IS NULL
        ORDER BY RANDOM() LIMIT 20`,
    )
    .all() as {
    objective: string;
    questTitle: string | null;
    openedAt: string;
    closedAt: string | null;
    what: string | null;
    why: string | null;
    sessionTitle: string | null;
  }[];

  const sample: EvalSampleActivity[] = sampleRows.map((row) => ({
    what: row.what ?? row.objective,
    why: row.why ?? "",
    questTitle: row.questTitle,
    durationMinutes: row.closedAt
      ? (Date.parse(row.closedAt) - Date.parse(row.openedAt)) / 60_000
      : null,
    sessionTitle: row.sessionTitle,
  }));

  database.close();

  return {
    copiedDbPath,
    traces: traceCount.count,
    activities: activityCount.count,
    ratio: traceCount.count === 0 ? 0 : activityCount.count / traceCount.count,
    medianActivityDurationMinutes: median(durationsMinutes),
    continuesLinks: continuesCount.count,
    questConflicts: backfillResult.questConflicts,
    sample,
  };
}
