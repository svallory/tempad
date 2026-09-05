import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db/database";
import { runIntentCommand } from "../../src/intent/cli";
import { defaultIntentConfig } from "../../src/intent/config";

function harness() {
  const database = openDatabase(":memory:");
  const lines: string[] = [];
  const context = {
    database,
    config: {} as never,
    intentConfig: defaultIntentConfig(),
    stdout: (line: string) => lines.push(line),
  };
  return { database, lines, run: (args: string[]) => runIntentCommand(args, context) };
}

describe("quests", () => {
  test("add with budget and goal, lifecycle events change state", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    await run(["goal", "add", "--owner", "hero", "G"]);
    const goal = database.query("SELECT id FROM goals").get() as { id: string };
    expect(
      await run([
        "quest",
        "add",
        "--owner",
        "hero",
        "--goal",
        goal.id,
        "Ship marko-ui",
        "--budget",
        "30h",
        "--due",
        "2026-09-20",
        "--commitment",
        "promised",
      ]),
    ).toBe(0);
    const quest = database
      .query("SELECT id, budget_minutes, state, confirmed FROM quests")
      .get() as { id: string; budget_minutes: number; state: string; confirmed: number };
    expect(quest.budget_minutes).toBe(1800);
    expect(quest.state).toBe("started");
    expect(quest.confirmed).toBe(1);
    await run(["quest", "pause", quest.id, "--reason", "waiting on upstream"]);
    expect(
      (
        database.query("SELECT state, state_reason FROM quests").get() as {
          state: string;
          state_reason: string;
        }
      ).state,
    ).toBe("paused");
    await run(["quest", "done", quest.id]);
    expect((database.query("SELECT state FROM quests").get() as { state: string }).state).toBe(
      "done",
    );
  });

  test("branch makes a side quest with a nexus event; return closes it", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    await run(["quest", "add", "--owner", "hero", "Main"]);
    const main = database.query("SELECT id FROM quests").get() as { id: string };
    await run(["quest", "add", "--owner", "hero", "Compare Astryx"]);
    const side = database.query("SELECT id FROM quests WHERE title = 'Compare Astryx'").get() as {
      id: string;
    };
    expect(
      await run([
        "quest",
        "branch",
        side.id,
        "--from-activity",
        "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        "--trigger",
        "what does Astryx do for agents?",
        "--kind",
        "curiosity",
      ]),
    ).toBe(0);
    const row = database
      .query(
        "SELECT origin_activity_id, trigger, branch_kind, returned_at FROM quests WHERE id = ?",
      )
      .get(side.id) as {
      origin_activity_id: string;
      trigger: string;
      branch_kind: string;
      returned_at: string | null;
    };
    expect(row.origin_activity_id).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(row.branch_kind).toBe("curiosity");
    expect(row.returned_at).toBeNull();
    expect(await run(["quest", "return", side.id, "--to", main.id])).toBe(0);
    expect(
      (
        database.query("SELECT returned_at FROM quests WHERE id = ?").get(side.id) as {
          returned_at: string | null;
        }
      ).returned_at,
    ).not.toBeNull();
  });

  test("merge resolves to the target; confirm flips the flag", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    await run(["quest", "add", "--owner", "hero", "A"]);
    await run(["quest", "add", "--owner", "hero", "B"]);
    const [a, b] = database.query("SELECT id FROM quests ORDER BY title").all() as { id: string }[];
    expect(await run(["quest", "merge", b?.id ?? "", "--into", a?.id ?? ""])).toBe(0);
    expect(
      (
        database.query("SELECT merged_into FROM quests WHERE id = ?").get(b?.id ?? "") as {
          merged_into: string;
        }
      ).merged_into,
    ).toBe(a?.id ?? "");
  });
});
