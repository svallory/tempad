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

describe("sagas", () => {
  test("add, reword keeps id and bumps revision, end keeps row", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    expect(await run(["saga", "add", "--owner", "hero", "Make more money"])).toBe(0);
    const saga = database.query("SELECT id, revision FROM sagas").get() as {
      id: string;
      revision: number;
    };
    expect(await run(["saga", "reword", saga.id, "Earn more"])).toBe(0);
    const reworded = database.query("SELECT id, title, revision FROM sagas").get() as {
      id: string;
      title: string;
      revision: number;
    };
    expect(reworded.id).toBe(saga.id);
    expect(reworded.title).toBe("Earn more");
    expect(reworded.revision).toBe(saga.revision + 1);
    expect(await run(["saga", "end", saga.id, "--reason", "achieved"])).toBe(0);
    expect(
      (
        database.query("SELECT end_reason FROM sagas WHERE id = ?").get(saga.id) as {
          end_reason: string;
        }
      ).end_reason,
    ).toBe("achieved");
  });

  test("replace creates a new saga and links the old one", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    await run(["saga", "add", "--owner", "hero", "Make more money"]);
    const old = database.query("SELECT id FROM sagas").get() as { id: string };
    expect(
      await run(["saga", "replace", old.id, "Have more fun", "--reason", "priorities changed"]),
    ).toBe(0);
    const rows = database
      .query("SELECT id, title, end_reason, replaced_by FROM sagas ORDER BY created_at")
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

  test("bare edit is refused once the saga has attachments", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    await run(["saga", "add", "--owner", "hero", "G"]);
    const saga = database.query("SELECT id FROM sagas").get() as { id: string };
    expect(await run(["saga", "edit", saga.id, "G2"])).toBe(0);
    // attach a quest directly through the store (quest CLI arrives in Task 5)
    const store = new EventStore(database);
    const quest = newUlid();
    applyIncremental(
      database,
      store.append({
        actor: "hero",
        kind: "quest.created",
        subject: quest,
        payload: { owner: { kind: "hero", id: "x" }, serves: saga.id, title: "Q", confirmed: true },
      }),
    );
    expect(await run(["saga", "edit", saga.id, "G3"])).toBe(1);
  });

  test("party owner must exist", async () => {
    const { run } = harness();
    await run(["hero", "init", "S"]);
    expect(await run(["saga", "add", "--owner", "party:nope", "G"])).toBe(1);
  });

  test("reword without --statement keeps the existing statement (no NULL write)", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    await run(["saga", "add", "--owner", "hero", "G", "--statement", "Original statement"]);
    const saga = database.query("SELECT id FROM sagas").get() as { id: string };
    expect(await run(["saga", "reword", saga.id, "New title"])).toBe(0);
    const row = database.query("SELECT title, statement FROM sagas WHERE id = ?").get(saga.id) as {
      title: string;
      statement: string | null;
    };
    expect(row.title).toBe("New title");
    expect(row.statement).toBe("Original statement");
  });

  test("reword refuses a bare edit path when attached, but is allowed with attachments", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    await run(["saga", "add", "--owner", "hero", "G"]);
    const saga = database.query("SELECT id FROM sagas").get() as { id: string };
    const store = new EventStore(database);
    const quest = newUlid();
    applyIncremental(
      database,
      store.append({
        actor: "hero",
        kind: "quest.created",
        subject: quest,
        payload: { owner: { kind: "hero", id: "x" }, serves: saga.id, title: "Q", confirmed: true },
      }),
    );
    // reword is explicit wording-change intent: allowed even with attachments
    expect(await run(["saga", "reword", saga.id, "G reworded"])).toBe(0);
    // bare edit is still refused, and message names reword/replace subcommands
    const originalError = console.error;
    let message = "";
    console.error = (line: string) => {
      message = line;
    };
    expect(await run(["saga", "edit", saga.id, "G edited"])).toBe(1);
    console.error = originalError;
    expect(message).toContain(`tempad saga reword `);
    expect(message).toContain(`tempad saga replace `);
  });
});
