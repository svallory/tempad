import type { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import type { Config } from "../config/env";
import type { IntentConfig } from "../intent/config";
import { AnthropicClassifier, type Classifier } from "./classifier";
import { enqueueJob } from "./jobs";
import { drain } from "./runner";

export interface W5Context {
  database: Database;
  config: Config;
  intentConfig: IntentConfig;
  stdout: (line: string) => void;
}

function logPath(config: Config): string {
  return join(config.home, "logs", "w5.log");
}

function log(config: Config, line: string): void {
  const path = logPath(config);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${new Date().toISOString()} ${line}\n`);
}

function buildClassifier(intentConfig: IntentConfig): Classifier {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required to run the w5 classifier");
  }
  return new AnthropicClassifier({ apiKey, model: intentConfig.w5.model });
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
      "SELECT id, text, kind FROM questions WHERE session_id = ? AND state = 'asked' ORDER BY asked_at DESC LIMIT 1",
    )
    .all(values.session) as { id: string; text: string; kind: string }[];
  if (rows.length === 0) return 0;

  const question = rows[0] as { id: string; text: string; kind: string };
  context.stdout(
    `w5 noticed a possible shift. To resolve: tempad answer ${question.id} --quest <id|new:"title"> --why "…". If unsure, keep working — it will follow up later.`,
  );
  return 0;
}

async function runRun(args: string[], context: W5Context): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { detached: { type: "boolean", default: false } },
    strict: true,
  });

  const lockPath = join(context.config.home, "w5.lock");
  if (existsSync(lockPath)) {
    return 0;
  }
  mkdirSync(dirname(lockPath), { recursive: true });

  if (values.detached) {
    Bun.spawn({
      cmd: [process.execPath, process.argv[1] ?? "", "w5", "run"],
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return 0;
  }

  try {
    await Bun.write(lockPath, String(process.pid));
    const classifier = buildClassifier(context.intentConfig);
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
      const { unlinkSync } = await import("node:fs");
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
    .query("SELECT id, title FROM quests WHERE confirmed = 0 ORDER BY created_at ASC")
    .all() as { id: string; title: string }[];
  for (const quest of unconfirmedQuests) {
    context.stdout(
      `quest ${quest.id} unconfirmed (${quest.title}) — tempad quest confirm ${quest.id}`,
    );
  }

  const lowConfidenceTraces = context.database
    .query("SELECT id, what FROM traces WHERE confidence < 0.5 ORDER BY started_at ASC")
    .all() as { id: string; what: string }[];
  for (const trace of lowConfidenceTraces) {
    context.stdout(
      `trace ${trace.id} low confidence (${trace.what}) — tempad trace list --activity <id>`,
    );
  }

  return 0;
}

export async function runW5Command(args: string[], context: W5Context): Promise<number> {
  const [subcommand, ...rest] = args;

  if (subcommand === "enqueue") return runEnqueue(rest, context);
  if (subcommand === "context") return runContext(rest, context);
  if (subcommand === "run") return runRun(rest, context);

  return 2;
}

export function runQuietCommand(args: string[], context: W5Context): number {
  return runQuiet(args, context);
}

export function runReviewCommand(args: string[], context: W5Context): number {
  return runReview(args, context);
}
