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

describe("hero, party, client commands", () => {
  test("hero init once, twice fails", async () => {
    const { run, database } = harness();
    expect(await run(["hero", "init", "Saulo Vallory"])).toBe(0);
    expect((database.query("SELECT name FROM heroes").get() as { name: string }).name).toBe(
      "Saulo Vallory",
    );
    expect(await run(["hero", "init", "Again"])).toBe(1);
  });

  test("party add joins the hero; leave closes the span", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    expect(
      await run(["party", "add", "mosaic", "Mosaic Strategies", "--joined", "2025-07-01"]),
    ).toBe(0);
    const membership = database.query("SELECT joined_at, left_at FROM memberships").get() as {
      joined_at: string;
      left_at: string | null;
    };
    expect(membership.joined_at.startsWith("2025-07-01")).toBe(true);
    expect(membership.left_at).toBeNull();
    expect(await run(["party", "leave", "mosaic", "--reason", "contract ended"])).toBe(0);
    expect(
      (database.query("SELECT left_at FROM memberships").get() as { left_at: string | null })
        .left_at,
    ).not.toBeNull();
    expect(await run(["party", "add", "mosaic", "Dup"])).toBe(1);
  });

  test("client add", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    expect(await run(["client", "add", "liuna", "LiUNA"])).toBe(0);
    expect((database.query("SELECT slug FROM clients").get() as { slug: string }).slug).toBe(
      "liuna",
    );
  });
});
