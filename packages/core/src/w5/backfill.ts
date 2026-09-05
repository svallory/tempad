import type { Database } from "bun:sqlite";
import type { Config } from "../config/env";
import type { W5Config } from "../intent/config";
import { registerAllProjections } from "../intent/projections/register";
import { EventStore } from "../intent/store";
import { applyResult } from "./apply";
import type { Classifier } from "./classifier";
import { buildWindow } from "./window";

registerAllProjections();

export interface BackfillOptions {
  days: number;
  now: string;
  log: (line: string) => void;
}

export interface BackfillResult {
  sessionsClassified: number;
  sessionsSkipped: number;
}

interface SessionRow {
  id: string;
  ended_at: string;
}

function isAlreadyCovered(database: Database, sessionId: string, endedAt: string): boolean {
  const row = database
    .query("SELECT id FROM traces WHERE session_id = ? AND ended_at >= ? LIMIT 1")
    .get(sessionId, endedAt) as { id: string } | null;
  return row !== null;
}

function chunkByWindow<T extends { ts: string }>(messages: T[], windowMinutes: number): T[][] {
  if (messages.length === 0) return [];
  const chunks: T[][] = [];
  let current: T[] = [];
  let windowStart: number | null = null;

  for (const message of messages) {
    const ts = Date.parse(message.ts);
    if (windowStart === null || ts - windowStart > windowMinutes * 60_000) {
      if (current.length > 0) chunks.push(current);
      current = [message];
      windowStart = ts;
    } else {
      current.push(message);
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export async function backfill(
  database: Database,
  _config: Config,
  intentConfig: W5Config,
  classifier: Classifier,
  options: BackfillOptions,
): Promise<BackfillResult> {
  const store = new EventStore(database);
  const cutoff = new Date(
    Date.parse(options.now) - options.days * 24 * 60 * 60 * 1000,
  ).toISOString();

  const sessions = database
    .query("SELECT id, ended_at FROM claude_sessions WHERE ended_at >= ? ORDER BY ended_at ASC")
    .all(cutoff) as SessionRow[];

  let sessionsClassified = 0;
  let sessionsSkipped = 0;
  const windowMinutes = intentConfig.throttleMinutes * 3;

  for (const session of sessions) {
    if (isAlreadyCovered(database, session.id, session.ended_at)) {
      sessionsSkipped += 1;
      options.log(`backfill: skipping ${session.id} (already covered)`);
      continue;
    }

    const fullWindow = buildWindow(database, {
      sessionId: session.id,
      sinceTs: null,
      maxMessages: 5000,
    });
    const chunks = chunkByWindow(fullWindow.messages, windowMinutes);

    for (const chunk of chunks) {
      const chunkWindow = { ...fullWindow, messages: chunk };
      const result = await classifier.classify(chunkWindow);
      applyResult(store, database, chunkWindow, result, {
        actor: "backfill",
        askingEnabled: false,
        now: options.now,
      });
    }

    if (chunks.length > 0) {
      sessionsClassified += 1;
      options.log(`backfill: classified ${session.id} (${chunks.length} window(s))`);
    }
  }

  return { sessionsClassified, sessionsSkipped };
}
