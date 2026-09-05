import type { Classifier, ClassifierResult, ClassifierWindow } from "./classifier";
import { classifyWithRetry } from "./classifier-shared";
import { buildSystemPrompt, buildUserPrompt } from "./prompt";

export interface CliSpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CliSpawn = (
  argv: string[],
  options: { cwd: string; stdin: string; timeoutMs: number },
) => Promise<CliSpawnResult>;

const defaultSpawn: CliSpawn = async (argv, options) => {
  const child = Bun.spawn(argv, {
    cwd: options.cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  child.stdin.write(options.stdin);
  child.stdin.end();

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, options.timeoutMs);

  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (timedOut) {
      throw new Error(`claude cli timed out after ${options.timeoutMs}ms`);
    }
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timeout);
  }
};

export interface ClaudeCliClassifierOptions {
  model: string;
  command?: string;
  cwd: string;
  spawn?: CliSpawn;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export class ClaudeCliClassifier implements Classifier {
  private readonly model: string;
  private readonly command: string;
  private readonly cwd: string;
  private readonly spawnImpl: CliSpawn;
  private readonly timeoutMs: number;

  constructor(options: ClaudeCliClassifierOptions) {
    this.model = options.model;
    this.command = options.command ?? "claude";
    this.cwd = options.cwd;
    this.spawnImpl = options.spawn ?? defaultSpawn;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async classify(window: ClassifierWindow): Promise<ClassifierResult> {
    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt(window);
    return classifyWithRetry(window, userPrompt, (prompt) => this.request(systemPrompt, prompt));
  }

  private async request(systemPrompt: string, userPrompt: string): Promise<string> {
    const argv = [
      this.command,
      "-p",
      "--safe-mode",
      "--no-session-persistence",
      "--output-format",
      "json",
      "--model",
      this.model,
      "--tools",
      "",
      "--system-prompt",
      systemPrompt,
    ];

    let result: CliSpawnResult;
    try {
      result = await this.spawnImpl(argv, {
        cwd: this.cwd,
        stdin: userPrompt,
        timeoutMs: this.timeoutMs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`claude cli spawn failed: ${message}`);
    }

    if (result.code !== 0) {
      throw new Error(`claude cli exited with code ${result.code}: ${result.stderr.slice(0, 200)}`);
    }

    let envelope: { result?: unknown };
    try {
      envelope = JSON.parse(result.stdout) as { result?: unknown };
    } catch {
      throw new Error(`claude cli output was not valid JSON: ${result.stdout.slice(0, 200)}`);
    }

    if (typeof envelope.result !== "string") {
      throw new Error(`claude cli envelope had no result field: ${result.stdout.slice(0, 200)}`);
    }

    return envelope.result;
  }
}
