#!/usr/bin/env bun
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { collectors } from "./collect/index.ts";
import type { Collector, SyncSummary } from "./collect/types.ts";
import { loadConfig } from "./config/env.ts";
import { openDatabase } from "./db/database.ts";
import { setSyncState } from "./db/sync-state.ts";
import { reports } from "./report/index.ts";
import type { Report, ReportOptions } from "./report/types.ts";

function printUsage(): void {
  console.error("Usage:");
  console.error("  tempad sync [monday|github|claude]");
  console.error(
    "  tempad report <daily|project|hourly> --from <date> --to <date> [--org X] [--project Y] [--out path]",
  );
}

export async function runSync(
  database: Database,
  config: ReturnType<typeof loadConfig>,
  selected: Collector[],
): Promise<{ summaries: SyncSummary[]; failed: boolean }> {
  const summaries: SyncSummary[] = [];
  let failed = false;

  for (const collector of selected) {
    const startedAt = new Date().toISOString();
    try {
      const summary = await collector.sync(database, config, {});
      summaries.push(summary);
      setSyncState(database, collector.name, startedAt);
    } catch (error) {
      failed = true;
      const message = error instanceof Error ? error.message : String(error);
      summaries.push({
        source: collector.name,
        inserted: 0,
        updated: 0,
        deleted: 0,
        warnings: [message],
      });
    }
  }

  return { summaries, failed };
}

async function runSyncCommand(args: string[]): Promise<number> {
  const source = args[0];

  if (source !== undefined && !collectors.has(source as Collector["name"])) {
    printUsage();
    return 2;
  }

  const config = loadConfig();
  const database = openDatabase(join(config.home, "tempad.db"));

  const selected: Collector[] =
    source !== undefined
      ? [collectors.get(source as Collector["name"]) as Collector]
      : [...collectors.values()];

  const { summaries, failed } = await runSync(database, config, selected);

  for (const summary of summaries) {
    const warnings = summary.warnings.length > 0 ? ` warnings=${summary.warnings.length}` : "";
    console.log(
      `${summary.source}: inserted=${summary.inserted} updated=${summary.updated} deleted=${summary.deleted}${warnings}`,
    );
  }

  return failed ? 1 : 0;
}

async function runReportCommand(args: string[]): Promise<number> {
  const kind = args[0];

  if (kind === undefined || !reports.has(kind as Report["kind"])) {
    printUsage();
    return 2;
  }

  const { values } = parseArgs({
    args: args.slice(1),
    options: {
      from: { type: "string" },
      to: { type: "string" },
      org: { type: "string" },
      project: { type: "string" },
      out: { type: "string" },
    },
    strict: true,
  });

  if (!values.from || !values.to) {
    printUsage();
    return 2;
  }

  const config = loadConfig();
  const database = openDatabase(join(config.home, "tempad.db"));
  const report = reports.get(kind as Report["kind"]) as Report;

  const options: ReportOptions = {
    from: values.from,
    to: values.to,
    org: values.org,
    project: values.project,
  };

  const output = report.render(database, config, options);
  console.log(output);

  const outPath =
    values.out ?? join(config.home, "reports", `${kind}-${options.from}-${options.to}.md`);
  await Bun.write(outPath, output);

  return 0;
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);

  if (command === "sync") {
    return runSyncCommand(rest);
  }
  if (command === "report") {
    return runReportCommand(rest);
  }

  printUsage();
  return 2;
}

if (import.meta.main) {
  const exitCode = await main();
  process.exit(exitCode);
}
