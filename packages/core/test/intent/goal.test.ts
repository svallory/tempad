import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db/database";
import { runIntentCommand } from "../../src/intent/cli";
import { defaultIntentConfig } from "../../src/intent/config";
import { newUlid } from "../../src/intent/ids";
import { applyIncremental } from "../../src/intent/projections";
import { EventStore } from "../../src/intent/store";

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

describe("goals", () => {
  test("add, reword keeps id and bumps revision, end keeps row", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    expect(await run(["goal", "add", "--owner", "hero", "Make more money"])).toBe(0);
    const goal = database.query("SELECT id, revision FROM goals").get() as {
      id: string;
      revision: number;
    };
    expect(await run(["goal", "reword", goal.id, "Earn more"])).toBe(0);
    const reworded = database.query("SELECT id, title, revision FROM goals").get() as {
      id: string;
      title: string;
      revision: number;
    };
    expect(reworded.id).toBe(goal.id);
    expect(reworded.title).toBe("Earn more");
    expect(reworded.revision).toBe(goal.revision + 1);
    expect(await run(["goal", "end", goal.id, "--reason", "achieved"])).toBe(0);
    expect(
      (
        database.query("SELECT end_reason FROM goals WHERE id = ?").get(goal.id) as {
          end_reason: string;
        }
      ).end_reason,
    ).toBe("achieved");
  });

  test("replace creates a new goal and links the old one", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    await run(["goal", "add", "--owner", "hero", "Make more money"]);
    const old = database.query("SELECT id FROM goals").get() as { id: string };
    expect(
      await run(["goal", "replace", old.id, "Have more fun", "--reason", "priorities changed"]),
    ).toBe(0);
    const rows = database
      .query("SELECT id, title, end_reason, replaced_by FROM goals ORDER BY created_at")
      .all() as {
      id: string;
      title: string;
      end_reason: string | null;
      replaced_by: string | null;
    }[];
    expect(rows.length).toBe(2);
    expect(rows[0]?.end_reason).toBe("replaced");
    expect(rows[0]?.replaced_by).toBe(rows[1]?.id);
  });

  // enabled in Task 5 (needs the real quests projection to exist)
  test.skip("bare edit is refused once the goal has attachments", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    await run(["goal", "add", "--owner", "hero", "G"]);
    const goal = database.query("SELECT id FROM goals").get() as { id: string };
    expect(await run(["goal", "edit", goal.id, "G2"])).toBe(0);
    // attach a quest directly through the store (quest CLI arrives in Task 5)
    const store = new EventStore(database);
    const quest = newUlid();
    applyIncremental(
      database,
      store.append({
        actor: "hero",
        kind: "quest.created",
        subject: quest,
        payload: { owner: { kind: "hero", id: "x" }, goal: goal.id, title: "Q", confirmed: true },
      }),
    );
    expect(await run(["goal", "edit", goal.id, "G3"])).toBe(1);
  });

  test("party owner must exist", async () => {
    const { run } = harness();
    await run(["hero", "init", "S"]);
    expect(await run(["goal", "add", "--owner", "party:nope", "G"])).toBe(1);
  });
});
