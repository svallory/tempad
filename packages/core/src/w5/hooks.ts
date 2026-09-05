import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

function stopHookPath(binPath: string): string {
  return join(dirname(binPath), "..", "hooks", "w5-stop.sh");
}

function promptHookPath(binPath: string): string {
  return join(dirname(binPath), "..", "hooks", "w5-prompt.sh");
}

export function renderHookSettings(binPath: string): HooksFragment {
  const stopCommand = stopHookPath(binPath);
  const promptCommand = promptHookPath(binPath);

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

export function installHooks(settingsPath: string, binPath: string): void {
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
