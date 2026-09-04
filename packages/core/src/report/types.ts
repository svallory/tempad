import type { Database } from "bun:sqlite";
import type { Config } from "../config/env.ts";

export interface ReportOptions {
  from: string;
  to: string;
  org?: string;
  project?: string;
}

export interface Report {
  kind: "daily" | "project" | "hourly";
  render(database: Database, config: Config, options: ReportOptions): string;
}
