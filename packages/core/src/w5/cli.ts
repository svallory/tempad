import type { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, openSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import type { Config } from "../config/env";
import type { IntentConfig } from "../intent/config";
import { backfill } from "./backfill";
import { AnthropicClassifier, type Classifier } from "./classifier";
import { ClaudeCliClassifier } from "./classifier-cli";
import { dedupe } from "./dedupe";
import { buildAdditionalContext, installHooks, uninstallHooks } from "./hooks";
import { enqueueJob } from "./jobs";
import type { QuestionRow } from "./questions";
import { drain } from "./runner";

export interface SpawnOptions {
  cmd: string[];
  detached: boolean;
  stdio: ["ignore", number, number];
  env: Record<string, string | undefined>;
}

export type SpawnFn = (options: SpawnOptions) => void;

export interface W5Context {
  database: Database;
  config: Config;
  intentConfig: IntentConfig;
  stdout: (line: string) => void;
  spawn?: SpawnFn;
}

const defaultSpawn: SpawnFn = (options) => {
  Bun.spawn({
    cmd: options.cmd,
    detached: options.detached,
    stdio: options.stdio,
    env: options.env,
  });
};

const CLI_PATH = join(import.meta.dir, "..", "cli.ts");

function logPath(config: Config): string {
  return join(config.home, "logs", "w5.log");
}

function log(config: Config, line: string): void {
  const path = logPath(config);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${new Date().toISOString()} ${line}\n`);
}

function buildClassifier(config: Config, intentConfig: IntentConfig, model?: string): Classifier {
  const resolvedModel = model ?? intentConfig.w5.model;

  const timeoutMs = intentConfig.w5.timeoutSeconds * 1000;

  if (intentConfig.w5.backend === "claude-cli") {
    return new ClaudeCliClassifier({
      model: resolvedModel,
      command: intentConfig.w5.claudeCommand,
      cwd: config.home,
      timeoutMs,
    });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      classify() {
        return Promise.reject(new Error("ANTHROPIC_API_KEY not set"));
      },
    };
  }
  return new AnthropicClassifier({ apiKey, model: resolvedModel, timeoutMs });
}

function lockPathFor(config: Config): string {
  return join(config.home, "w5.lock");
}

function spawnDetachedRun(context: W5Context): void {
  const spawn = context.spawn ?? defaultSpawn;
  const path = logPath(context.config);
  mkdirSync(dirname(path), { recursive: true });
  const logFd = openSync(path, "a");

  spawn({
    cmd: [process.execPath, CLI_PATH, "w5", "run"],
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, TEMPAD_HOME: context.config.home },
  });
}

function runEnqueue(args: string[], context: W5Context): number {
  const { values } = parseArgs({
    args,
    options: {
      session: { type: "string" },
      forced: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (!values.session) return 0;

  try {
    enqueueJob(context.database, {
      sessionId: values.session,
      forced: values.forced === true,
      throttleMinutes: context.intentConfig.w5.throttleMinutes,
    });

    const lockPath = lockPathFor(context.config);
    clearStaleLock(lockPath, (line) => log(context.config, line));

    if (!existsSync(lockPath)) {
      spawnDetachedRun(context);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(context.config, `enqueue failed: ${message}`);
  }
  return 0;
}

function runContext(args: string[], context: W5Context): number {
  const { values } = parseArgs({
    args,
    options: { session: { type: "string" } },
    strict: true,
  });
  if (!values.session) return 0;

  const rows = context.database
    .query(
      `SELECT id, trace_id as traceId, session_id as sessionId, kind, state, turns_watched as turnsWatched,
              turns_at_ask as turnsAtAsk, is_switch as isSwitch
         FROM questions WHERE session_id = ? AND state = 'asked' ORDER BY asked_at DESC`,
    )
    .all(values.session) as (Omit<QuestionRow, "isSwitch"> & { isSwitch: number })[];
  if (rows.length === 0) return 0;

  const questions: QuestionRow[] = rows.map((row) => ({ ...row, isSwitch: row.isSwitch === 1 }));
  const text = buildAdditionalContext(questions);
  if (text.length > 0) context.stdout(text);
  return 0;
}

const STALE_LOCK_MINUTES = 30;

function clearStaleLock(lockPath: string, log: (line: string) => void): void {
  if (!existsSync(lockPath)) return;
  const ageMinutes = (Date.now() - statSync(lockPath).mtimeMs) / 60_000;
  if (ageMinutes >= STALE_LOCK_MINUTES) {
    log(`w5.lock is stale (${Math.round(ageMinutes)}m old), removing`);
    try {
      unlinkSync(lockPath);
    } catch {
      // already gone
    }
  }
}

async function runRun(args: string[], context: W5Context): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { detached: { type: "boolean", default: false } },
    strict: true,
  });

  const lockPath = lockPathFor(context.config);
  clearStaleLock(lockPath, (line) => log(context.config, line));

  if (existsSync(lockPath)) {
    return 0;
  }
  mkdirSync(dirname(lockPath), { recursive: true });

  if (values.detached) {
    spawnDetachedRun(context);
    return 0;
  }

  try {
    await Bun.write(lockPath, String(process.pid));
    const classifier = buildClassifier(context.config, context.intentConfig);
    const count = await drain(
      context.database,
      context.config,
      context.intentConfig.w5,
      classifier,
      {
        log: (line) => log(context.config, line),
      },
    );
    context.stdout(`w5: ran ${count} job(s)`);
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      // lock already gone
    }
  }
  return 0;
}

function runQuiet(args: string[], context: W5Context): number {
  const duration = args[0];
  if (!duration) return 2;

  const match = duration.match(/^(\d+)([hm])$/);
  if (!match) return 2;
  const amount = Number.parseInt(match[1] as string, 10);
  const unit = match[2];
  const minutes = unit === "h" ? amount * 60 : amount;
  const until = new Date(Date.now() + minutes * 60_000).toISOString();

  context.database.query("INSERT INTO w5_quiet (until) VALUES (?)").run(until);
  context.stdout(`quiet until ${until}`);
  return 0;
}

function runReview(_args: string[], context: W5Context): number {
  const expiredQuestions = context.database
    .query("SELECT id, text FROM questions WHERE state = 'expired' ORDER BY rowid ASC")
    .all() as { id: string; text: string }[];
  for (const question of expiredQuestions) {
    context.stdout(
      `question ${question.id} expired (${question.text}) — tempad answer ${question.id} --quest <id> --why "…"`,
    );
  }

  const unconfirmedQuests = context.database
    .query(
      "SELECT id, title FROM quests WHERE confirmed = 0 AND retracted_at IS NULL ORDER BY created_at ASC",
    )
    .all() as { id: string; title: string }[];
  for (const quest of unconfirmedQuests) {
    context.stdout(
      `quest ${quest.id} unconfirmed (${quest.title}) — tempad quest confirm ${quest.id}`,
    );
  }

  const lowConfidenceTraces = context.database
    .query(
      "SELECT id, what FROM traces WHERE confidence < 0.5 AND retracted_at IS NULL ORDER BY started_at ASC",
    )
    .all() as { id: string; what: string }[];
  for (const trace of lowConfidenceTraces) {
    context.stdout(
      `trace ${trace.id} low confidence (${trace.what}) — tempad trace list --activity <id>`,
    );
  }

  return 0;
}

function settingsPathFor(scope: string): string {
  const home = process.env.HOME ?? "";
  if (scope === "project") return join(process.cwd(), ".claude", "settings.json");
  return join(home, ".claude", "settings.json");
}

function runHook(args: string[]): number {
  const [action, ...rest] = args;
  const { values } = parseArgs({
    args: rest,
    options: {
      scope: { type: "string", default: "user" },
      bin: { type: "string" },
    },
    strict: true,
  });
  const scope = values.scope === "project" ? "project" : "user";
  const settingsPath = settingsPathFor(scope);

  if (action === "install") {
    if (values.bin) {
      installHooks(settingsPath, values.bin);
    } else {
      installHooks(settingsPath);
    }
    return 0;
  }
  if (action === "uninstall") {
    uninstallHooks(settingsPath);
    return 0;
  }
  return 2;
}

async function runBackfill(args: string[], context: W5Context): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      days: { type: "string" },
      model: { type: "string" },
    },
    strict: true,
  });

  const days = values.days
    ? Number.parseInt(values.days, 10)
    : context.intentConfig.w5.backfillDays;

  if (context.intentConfig.w5.backend === "api" && !process.env.ANTHROPIC_API_KEY) {
    context.stdout("ANTHROPIC_API_KEY not set");
    return 1;
  }
  const classifier = buildClassifier(context.config, context.intentConfig, values.model);

  const result = await backfill(
    context.database,
    context.config,
    context.intentConfig.w5,
    classifier,
    {
      days,
      now: new Date().toISOString(),
      log: (line) => {
        log(context.config, line);
        context.stdout(line);
      },
    },
  );

  context.stdout(
    `classified=${result.sessionsClassified} windows=${result.windowsClassified} failed=${result.windowsFailed} skipped=${result.sessionsSkipped} windows_skipped=${result.windowsSkipped}`,
  );

  const attemptedWindows = result.windowsClassified + result.windowsFailed;
  if (attemptedWindows > 0 && result.windowsClassified === 0) return 1;
  return 0;
}

function runDedupe(args: string[], context: W5Context): number {
  const { values } = parseArgs({
    args,
    options: { "dry-run": { type: "boolean", default: false } },
    strict: true,
  });

  const result = dedupe(context.database, { dryRun: values["dry-run"] === true });
  context.stdout(`traces=${result.traces} activities=${result.activities} quests=${result.quests}`);
  return 0;
}

export async function runW5Command(args: string[], context: W5Context): Promise<number> {
  const [subcommand, ...rest] = args;

  if (subcommand === "enqueue") return runEnqueue(rest, context);
  if (subcommand === "context") return runContext(rest, context);
  if (subcommand === "run") return runRun(rest, context);
  if (subcommand === "hook") return runHook(rest);
  if (subcommand === "backfill") return runBackfill(rest, context);
  if (subcommand === "dedupe") return runDedupe(rest, context);

  return 2;
}

export function runQuietCommand(args: string[], context: W5Context): number {
  return runQuiet(args, context);
}

export function runReviewCommand(args: string[], context: W5Context): number {
  return runReview(args, context);
}
