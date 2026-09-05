import type { Database } from "bun:sqlite";

export type EditIntent = "reword" | "replace";

function tableExists(database: Database, name: string): boolean {
  return (
    database.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    null
  );
}

export function countAttachments(database: Database, entity: "goal" | "quest", id: string): number {
  if (entity === "goal") {
    if (!tableExists(database, "quests")) return 0;
    return (
      database.query("SELECT count(*) AS n FROM quests WHERE goal_id = ?").get(id) as { n: number }
    ).n;
  }
  if (!tableExists(database, "activities")) return 0;
  return (
    database.query("SELECT count(*) AS n FROM activities WHERE quest_id = ?").get(id) as {
      n: number;
    }
  ).n;
}

export function assertEditIntent(
  database: Database,
  entity: "goal" | "quest",
  id: string,
  intent: EditIntent | undefined,
): void {
  if (intent !== undefined) return;
  if (countAttachments(database, entity, id) > 0) {
    throw new Error(`${entity} ${id} has attachments; pass --reword or --replace`);
  }
}
