import type { Database } from "bun:sqlite";

export interface SyncState {
  source: string;
  lastSyncAt: string;
  cursor: string | null;
}

export function getSyncState(db: Database, source: string): SyncState | undefined {
  const row = db
    .query("SELECT source, last_sync_at as lastSyncAt, cursor FROM sync_state WHERE source = ?")
    .get(source) as SyncState | null;
  return row ?? undefined;
}

export function setSyncState(
  db: Database,
  source: string,
  lastSyncAt: string,
  cursor?: string,
): void {
  db.query(
    `INSERT INTO sync_state (source, last_sync_at, cursor)
     VALUES (?, ?, ?)
     ON CONFLICT(source) DO UPDATE SET last_sync_at = excluded.last_sync_at, cursor = excluded.cursor`,
  ).run(source, lastSyncAt, cursor ?? null);
}
