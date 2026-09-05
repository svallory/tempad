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

export function buildAdditionalContext(questions: QuestionRow[]): string {
  if (questions.length === 0) return "";

  const lines: string[] = [];
  for (const question of questions) {
    lines.push(
      `w5 noticed a possible shift in what you're working on (question ${question.id}, ${question.kind}).`,
    );
    lines.push(`To resolve it: tempad answer ${question.id} --quest <id|new:"title"> --why "…"`);
    lines.push("If you're not sure, keep working — it will follow up later.");
  }
  return lines.join("\n");
}
