import type { Database } from "bun:sqlite";

export interface EnqueueJobInput {
  sessionId: string;
  forced: boolean;
  now?: string;
  throttleMinutes: number;
}

export interface EnqueueJobResult {
  enqueued: boolean;
  reason?: "throttled" | "duplicate";
}

export interface Job {
  id: number;
  sessionId: string;
  kind: string;
  forced: boolean;
  requestedAt: string;
  claimedAt: string | null;
}

interface JobRow {
  id: number;
  session_id: string;
  kind: string;
  forced: number;
  requested_at: string;
  claimed_at: string | null;
}

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind,
    forced: row.forced === 1,
    requestedAt: row.requested_at,
    claimedAt: row.claimed_at,
  };
}

export function isThrottled(
  database: Database,
  sessionId: string,
  now: string,
  throttleMinutes: number,
): boolean {
  const run = database
    .query("SELECT last_run_at FROM w5_runs WHERE session_id = ?")
    .get(sessionId) as { last_run_at: string } | null;
  if (!run) return false;
  const elapsedMinutes = (Date.parse(now) - Date.parse(run.last_run_at)) / 60_000;
  return elapsedMinutes < throttleMinutes;
}

export function enqueueJob(database: Database, input: EnqueueJobInput): EnqueueJobResult {
  const now = input.now ?? new Date().toISOString();

  const existingQueued = database
    .query("SELECT id, forced FROM w5_jobs WHERE session_id = ? AND state = 'queued'")
    .get(input.sessionId) as { id: number; forced: number } | null;

  if (existingQueued) {
    if (input.forced && existingQueued.forced === 0) {
      database.query("UPDATE w5_jobs SET forced = 1 WHERE id = ?").run(existingQueued.id);
    }
    return { enqueued: false, reason: "duplicate" };
  }

  if (!input.forced && isThrottled(database, input.sessionId, now, input.throttleMinutes)) {
    return { enqueued: false, reason: "throttled" };
  }

  database
    .query(
      "INSERT INTO w5_jobs (session_id, kind, forced, requested_at, state) VALUES (?, 'classify', ?, ?, 'queued')",
    )
    .run(input.sessionId, input.forced ? 1 : 0, now);

  return { enqueued: true };
}

export function claimNextJob(database: Database, now?: string): Job | null {
  const claimedAt = now ?? new Date().toISOString();
  const row = database
    .query("SELECT id FROM w5_jobs WHERE state = 'queued' ORDER BY id ASC LIMIT 1")
    .get() as { id: number } | null;
  if (!row) return null;

  database
    .query("UPDATE w5_jobs SET state = 'running', claimed_at = ? WHERE id = ?")
    .run(claimedAt, row.id);

  const job = database.query("SELECT * FROM w5_jobs WHERE id = ?").get(row.id) as JobRow;
  return toJob(job);
}

export function completeJob(
  database: Database,
  id: number,
  lastMessageTs: string | null,
  now?: string,
): void {
  const job = database.query("SELECT session_id FROM w5_jobs WHERE id = ?").get(id) as {
    session_id: string;
  } | null;
  if (!job) return;

  const finishedAt = now ?? new Date().toISOString();

  database
    .query("UPDATE w5_jobs SET state = 'done', finished_at = ? WHERE id = ?")
    .run(finishedAt, id);

  database
    .query(
      `INSERT INTO w5_runs (session_id, last_run_at, last_message_ts) VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET last_run_at = excluded.last_run_at, last_message_ts = excluded.last_message_ts`,
    )
    .run(job.session_id, finishedAt, lastMessageTs);
}

export function failJob(database: Database, id: number, error: string): void {
  const now = new Date().toISOString();
  database
    .query("UPDATE w5_jobs SET state = 'failed', finished_at = ?, error = ? WHERE id = ?")
    .run(now, error, id);
}
