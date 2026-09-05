import { existsSync, readFileSync } from "node:fs";

export interface W5Config {
  model: string;
  throttleMinutes: number;
  watchTurns: number;
  askMinActivityMinutes: number;
  askBudgetMinutes: number;
  askExpireTurns: number;
  backfillDays: number;
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
      askMinActivityMinutes: 20,
      askBudgetMinutes: 30,
      askExpireTurns: 2,
      backfillDays: 15,
    },
  };
}

function requireString(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${where}: missing ${key}`);
  return value;
}

export function loadIntentConfig(tomlPath: string): IntentConfig {
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
  const w5 = parsed.w5 as Record<string, unknown> | undefined;
  if (w5) {
    const number = (key: string, fallback: number) =>
      typeof w5[key] === "number" ? (w5[key] as number) : fallback;
    config.w5 = {
      model: typeof w5.model === "string" ? w5.model : config.w5.model,
      throttleMinutes: number("throttle_minutes", config.w5.throttleMinutes),
      watchTurns: number("watch_turns", config.w5.watchTurns),
      askMinActivityMinutes: number("ask_min_activity_minutes", config.w5.askMinActivityMinutes),
      askBudgetMinutes: number("ask_budget_minutes", config.w5.askBudgetMinutes),
      askExpireTurns: number("ask_expire_turns", config.w5.askExpireTurns),
      backfillDays: number("backfill_days", config.w5.backfillDays),
    };
  }
  return config;
}
