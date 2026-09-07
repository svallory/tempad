import { existsSync, readFileSync } from "node:fs";

export type W5Backend = "claude-cli" | "api";

export interface W5Config {
  model: string;
  throttleMinutes: number;
  watchTurns: number;
  askMinStintMinutes: number;
  askBudgetMinutes: number;
  askExpireTurns: number;
  backfillDays: number;
  backend: W5Backend;
  claudeCommand: string;
  timeoutSeconds: number;
  stintIdleMinutes: number;
  stintMinMinutes: number;
  memoryHours: number;
  memoryStints: number;
  overlapMessages: number;
  mode: "declared" | "inferred";
  inferenceFallback: boolean;
}

export interface IntentConfig {
  hero?: { name: string };
  parties: { slug: string; name: string; joined?: string; description?: string }[];
  clients: { slug: string; name: string }[];
  w5: W5Config;
}

export function defaultIntentConfig(): IntentConfig {
  return {
    parties: [],
    clients: [],
    w5: {
      model: "claude-haiku-4-5-20251001",
      throttleMinutes: 10,
      watchTurns: 3,
      askMinStintMinutes: 20,
      askBudgetMinutes: 30,
      askExpireTurns: 2,
      backfillDays: 15,
      backend: "claude-cli",
      claudeCommand: "claude",
      timeoutSeconds: 180,
      stintIdleMinutes: 45,
      stintMinMinutes: 5,
      memoryHours: 8,
      memoryStints: 10,
      overlapMessages: 3,
      mode: "declared",
      inferenceFallback: true,
    },
  };
}

function parseBackend(value: unknown, fallback: W5Backend): W5Backend {
  if (value === "claude-cli" || value === "api") return value;
  return fallback;
}

function parseMode(value: unknown, fallback: "declared" | "inferred"): "declared" | "inferred" {
  if (value === "declared" || value === "inferred") return value;
  return fallback;
}

function requireString(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${where}: missing ${key}`);
  return value;
}

/**
 * Old `[w5]` key -> current key, for configs written before the 2026-09-07
 * vocabulary rename. Unlike events, a TOML file is hand-edited and lives
 * outside the repository, so it is read through this alias rather than
 * migrated: an operator's existing `tempad.toml` keeps working, and the
 * warning tells them what to rename it to.
 */
const LEGACY_W5_KEYS: Readonly<Record<string, string>> = {
  ask_min_activity_minutes: "ask_min_stint_minutes",
  activity_idle_minutes: "stint_idle_minutes",
  memory_activities: "memory_stints",
};

/**
 * Rewrites legacy `[w5]` keys to their current names, warning once per key.
 * The current name wins when both are present, so a half-migrated file
 * behaves the way its author most recently intended.
 */
function resolveLegacyW5Keys(
  w5: Record<string, unknown>,
  warn: (message: string) => void,
): Record<string, unknown> {
  const resolved = { ...w5 };
  for (const [old, current] of Object.entries(LEGACY_W5_KEYS)) {
    if (!(old in resolved)) continue;
    const value = resolved[old];
    delete resolved[old];
    if (current in w5) {
      warn(`tempad.toml: [w5].${old} is ignored; using [w5].${current}. Remove the old key.`);
      continue;
    }
    resolved[current] = value;
    warn(`tempad.toml: [w5].${old} was renamed to [w5].${current}. Update your config.`);
  }
  return resolved;
}

export function loadIntentConfig(
  tomlPath: string,
  warn: (message: string) => void = (message) => console.warn(message),
): IntentConfig {
  if (!existsSync(tomlPath)) {
    return defaultIntentConfig();
  }
  const parsed = Bun.TOML.parse(readFileSync(tomlPath, "utf8")) as Record<string, unknown>;
  const config = defaultIntentConfig();
  const hero = parsed.hero as Record<string, unknown> | undefined;
  if (hero) config.hero = { name: requireString(hero, "name", "[hero]") };
  for (const [index, raw] of (
    (parsed.parties as Record<string, unknown>[] | undefined) ?? []
  ).entries()) {
    const where = `[[parties]] #${index + 1}`;
    config.parties.push({
      slug: requireString(raw, "slug", where),
      name: requireString(raw, "name", where),
      joined: typeof raw.joined === "string" ? raw.joined : undefined,
      description: typeof raw.description === "string" ? raw.description : undefined,
    });
  }
  for (const [index, raw] of (
    (parsed.clients as Record<string, unknown>[] | undefined) ?? []
  ).entries()) {
    const where = `[[clients]] #${index + 1}`;
    config.clients.push({
      slug: requireString(raw, "slug", where),
      name: requireString(raw, "name", where),
    });
  }
  const rawW5 = parsed.w5 as Record<string, unknown> | undefined;
  const w5 = rawW5 ? resolveLegacyW5Keys(rawW5, warn) : undefined;
  if (w5) {
    const number = (key: string, fallback: number) =>
      typeof w5[key] === "number" ? (w5[key] as number) : fallback;
    const boolean = (key: string, fallback: boolean) =>
      typeof w5[key] === "boolean" ? (w5[key] as boolean) : fallback;
    config.w5 = {
      model: typeof w5.model === "string" ? w5.model : config.w5.model,
      throttleMinutes: number("throttle_minutes", config.w5.throttleMinutes),
      watchTurns: number("watch_turns", config.w5.watchTurns),
      askMinStintMinutes: number("ask_min_stint_minutes", config.w5.askMinStintMinutes),
      askBudgetMinutes: number("ask_budget_minutes", config.w5.askBudgetMinutes),
      askExpireTurns: number("ask_expire_turns", config.w5.askExpireTurns),
      backfillDays: number("backfill_days", config.w5.backfillDays),
      backend: parseBackend(w5.backend, config.w5.backend),
      claudeCommand:
        typeof w5.claude_command === "string" ? w5.claude_command : config.w5.claudeCommand,
      timeoutSeconds: number("timeout_seconds", config.w5.timeoutSeconds),
      stintIdleMinutes: number("stint_idle_minutes", config.w5.stintIdleMinutes),
      stintMinMinutes: number("stint_min_minutes", config.w5.stintMinMinutes),
      memoryHours: number("memory_hours", config.w5.memoryHours),
      memoryStints: number("memory_stints", config.w5.memoryStints),
      overlapMessages: number("overlap_messages", config.w5.overlapMessages),
      mode: parseMode(w5.mode, config.w5.mode),
      inferenceFallback: boolean("inference_fallback", config.w5.inferenceFallback),
    };
  }
  return config;
}
