import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { QuestionRow } from "./questions";

interface HookEntry {
  type: "command";
  command: string;
  tempad?: boolean;
}

interface HookMatcher {
  hooks: HookEntry[];
}

interface HooksFragment {
  Stop: HookMatcher[];
  PreCompact: HookMatcher[];
  SessionEnd: HookMatcher[];
  UserPromptSubmit: HookMatcher[];
}

interface SettingsFile {
  hooks?: Partial<Record<string, HookMatcher[]>>;
  [key: string]: unknown;
}

const PACKAGE_ROOT = join(import.meta.dir, "..", "..");
const HOOKS_DIR = join(PACKAGE_ROOT, "hooks");
const CLI_PATH = join(PACKAGE_ROOT, "src", "cli.ts");

export function stopHookScriptPath(): string {
  return join(HOOKS_DIR, "w5-stop.sh");
}

export function promptHookScriptPath(): string {
  return join(HOOKS_DIR, "w5-prompt.sh");
}

function tempadBinInvocation(binPath: string): string {
  return `bun ${binPath}`;
}

function hookCommand(scriptPath: string, binPath: string): string {
  return `TEMPAD_BIN="${tempadBinInvocation(binPath)}" bash ${scriptPath}`;
}

export function renderHookSettings(binPath: string = CLI_PATH): HooksFragment {
  const stopCommand = hookCommand(stopHookScriptPath(), binPath);
  const promptCommand = hookCommand(promptHookScriptPath(), binPath);

  const stopMatcher: HookMatcher = {
    hooks: [{ type: "command", command: stopCommand, tempad: true }],
  };
  const promptMatcher: HookMatcher = {
    hooks: [{ type: "command", command: promptCommand, tempad: true }],
  };

  return {
    Stop: [stopMatcher],
    PreCompact: [stopMatcher],
    SessionEnd: [stopMatcher],
    UserPromptSubmit: [promptMatcher],
  };
}

function readSettings(settingsPath: string): SettingsFile {
  if (!existsSync(settingsPath)) return {};
  return JSON.parse(readFileSync(settingsPath, "utf8")) as SettingsFile;
}

function writeSettings(settingsPath: string, settings: SettingsFile): void {
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

function removeTempadEntries(matchers: HookMatcher[] | undefined): HookMatcher[] {
  if (!matchers) return [];
  return matchers
    .map((matcher) => ({
      ...matcher,
      hooks: matcher.hooks.filter((hook) => hook.tempad !== true),
    }))
    .filter((matcher) => matcher.hooks.length > 0);
}

export function installHooks(settingsPath: string, binPath: string = CLI_PATH): void {
  const settings = readSettings(settingsPath);
  const fragment = renderHookSettings(binPath);
  const hooks = { ...(settings.hooks ?? {}) };

  for (const eventName of Object.keys(fragment) as (keyof HooksFragment)[]) {
    const withoutTempad = removeTempadEntries(hooks[eventName]);
    hooks[eventName] = [...withoutTempad, ...fragment[eventName]];
  }

  writeSettings(settingsPath, { ...settings, hooks });
}

export function uninstallHooks(settingsPath: string): void {
  const settings = readSettings(settingsPath);
  if (!settings.hooks) return;

  const hooks = { ...settings.hooks };
  for (const eventName of Object.keys(hooks)) {
    hooks[eventName] = removeTempadEntries(hooks[eventName]);
  }

  writeSettings(settingsPath, { ...settings, hooks });
}

export function buildDeclarationLine(
  declared: { title: string } | null,
  sessionId: string,
): string {
  const quest = declared ? declared.title : "none";
  return `tempad: session ${sessionId}, declared quest: ${quest}. Declare with the tempad-quest skill if this prompt starts a different outcome.`;
}

/**
 * The hand-back for a doubt the verifier raised. Rendered fresh at read time from
 * the question's `kind`/`guess` plus the quest declared *now*, never from a
 * sentence stored when the question was asked: a title can change, and the stored
 * `text` is internal/debug only for the verifier's two kinds.
 */
export function buildBelongsHandback(
  declaredTitle: string,
  guess: string,
  questionId: string,
): string {
  return [
    `w5 thinks the last stretch is not part of "${declaredTitle}" (looks like: ${guess}). Reply:`,
    `  tempad answer ${questionId} --belongs --why "<reason>"`,
    "  or",
    `  tempad answer ${questionId} --quest <id>|new:"<title>" --why "<reason>" [--origin current --trigger "<sentence>" --kind waiting|blocker|curiosity|unknown]`,
    "Ask the user if you are not sure.",
  ].join("\n");
}

/** The hand-back for a session that has declared nothing yet. */
export function buildDeclareHandback(sessionId: string): string {
  return [
    "w5 has no declared quest for this session. Reply:",
    `  tempad quest declare --session ${sessionId} --quest <id>|--new "<title>" --outcome "<text>" [--commitment ...] --by agent`,
  ].join("\n");
}

export function buildAdditionalContext(
  questions: QuestionRow[],
  context?: {
    declaredTitle: string | null;
    sessionId: string;
    guessFor: (questionId: string) => string | null;
  },
): string {
  if (questions.length === 0) return "";

  const lines: string[] = [];
  for (const question of questions) {
    if (context !== undefined && question.kind === "declare") {
      lines.push(buildDeclareHandback(context.sessionId));
      continue;
    }
    if (context !== undefined && question.kind === "belongs") {
      lines.push(
        buildBelongsHandback(
          context.declaredTitle ?? "your declared quest",
          context.guessFor(question.id) ?? "something else",
          question.id,
        ),
      );
      continue;
    }
    lines.push(
      `w5 noticed a possible shift in what you're working on (question ${question.id}, ${question.kind}).`,
    );
    lines.push(`To resolve it: tempad answer ${question.id} --quest <id|new:"title"> --why "…"`);
    lines.push("If you're not sure, keep working — it will follow up later.");
  }
  return lines.join("\n");
}
