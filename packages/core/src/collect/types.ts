import type { Database } from "bun:sqlite";
import type { Config } from "../config/env.ts";

export interface SyncSummary {
  source: string;
  inserted: number;
  updated: number;
  deleted: number;
  warnings: string[];
}

export interface SyncOptions {
  since?: string;
  fetch?: typeof fetch;
}

export interface Collector {
  name: "monday" | "github" | "claude";
  sync(database: Database, config: Config, options: SyncOptions): Promise<SyncSummary>;
}
