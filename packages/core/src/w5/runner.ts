import type { Database } from "bun:sqlite";
import { syncOneSessionFile } from "../collect/claude";
import type { Config } from "../config/env";
import type { W5Config } from "../intent/config";
import { registerAllProjections } from "../intent/projections/register";
import { EventStore } from "../intent/store";
import { type AppliedSummary, applyResult } from "./apply";
import type { Classifier } from "./classifier";
import { claimNextJob, completeJob, failJob } from "./jobs";
import { advanceQuestions } from "./questions";
import { buildWindow, findSessionFile } from "./window";

registerAllProjections();

export interface RunOnceOptions {
  now?: string;
  log: (line: string) => void;
}

export interface RunOnceResult {
  ran: boolean;
  sessionId?: string;
  summary?: AppliedSummary;
}

function countUserMessages(database: Database, sessionId: string, sinceTs: string | null): number {
  const row =
    sinceTs !== null
      ? (database
          .query(
            "SELECT COUNT(*) as count FROM claude_messages WHERE session_id = ? AND ts > ? AND role = 'user'",
          )
          .get(sessionId, sinceTs) as { count: number })
      : (database
          .query(
            "SELECT COUNT(*) as count FROM claude_messages WHERE session_id = ? AND role = 'user'",
          )
          .get(sessionId) as { count: number });
  return row.count;
}

export async function runOnce(
  database: Database,
  config: Config,
  intentConfig: W5Config,
  classifier: Classifier,
  options: RunOnceOptions,
): Promise<RunOnceResult> {
  const now = options.now ?? new Date().toISOString();
  const job = claimNextJob(database, now);
  if (!job) return { ran: false };

  const store = new EventStore(database);

  try {
    const filePath = findSessionFile(database, job.sessionId);
    if (filePath !== null) {
      await syncOneSessionFile(database, config, filePath);
    }

    const runRow = database
      .query("SELECT last_message_ts FROM w5_runs WHERE session_id = ?")
      .get(job.sessionId) as { last_message_ts: string | null } | null;
    const sinceTs = runRow?.last_message_ts ?? null;

    const window = buildWindow(database, {
      sessionId: job.sessionId,
      sinceTs,
      maxMessages: 200,
    });

    const result = await classifier.classify(window);
    const summary = applyResult(store, database, window, result, {
      actor: "hook",
      askingEnabled: !job.forced,
      now,
    });

    const turnsSinceLastRun = countUserMessages(database, job.sessionId, sinceTs);
    advanceQuestions(store, database, intentConfig, {
      sessionId: job.sessionId,
      now,
      turnsSinceLastRun,
      sessionActivityMinutes: 0,
      resolvedByContext: [],
    });

    const lastMessage = window.messages.at(-1);
    completeJob(database, job.id, lastMessage?.ts ?? sinceTs);

    return { ran: true, sessionId: job.sessionId, summary };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failJob(database, job.id, message);
    options.log(`w5 run failed for session ${job.sessionId}: ${message}`);
    return { ran: true, sessionId: job.sessionId };
  }
}

export async function drain(
  database: Database,
  config: Config,
  intentConfig: W5Config,
  classifier: Classifier,
  options: RunOnceOptions,
): Promise<number> {
  let count = 0;
  for (;;) {
    const result = await runOnce(database, config, intentConfig, classifier, options);
    if (!result.ran) break;
    count += 1;
  }
  return count;
}
