import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db/database";
import { runIntentCommand } from "../../src/intent/cli";
import { defaultIntentConfig } from "../../src/intent/config";
import { newUlid } from "../../src/intent/ids";
import { applyIncremental } from "../../src/intent/projections";
import { EventStore } from "../../src/intent/store";
import { stateAsOf } from "../../src/intent/time-travel";

describe("time travel", () => {
  test("goals as of August exclude September changes", () => {
    const database = openDatabase(":memory:");
    const store = new EventStore(database);
    const goal = newUlid();
    applyIncremental(
      database,
      store.append({
        at: "2026-08-01T00:00:00.000Z",
        actor: "hero",
        kind: "goal.created",
        subject: goal,
        payload: { owner: { kind: "hero", id: "h" }, title: "Old title" },
      }),
    );
    applyIncremental(
      database,
      store.append({
        at: "2026-09-02T00:00:00.000Z",
        actor: "hero",
        kind: "goal.reworded",
        subject: goal,
        payload: { title: "New title" },
      }),
    );
    const past = stateAsOf(database, "2026-08-31T23:59:59.000Z");
    expect((past.query("SELECT title FROM goals").get() as { title: string }).title).toBe(
      "Old title",
    );
    expect((database.query("SELECT title FROM goals").get() as { title: string }).title).toBe(
      "New title",
    );
  });

  test("rebuild command restores projections after a manual wipe", async () => {
    const database = openDatabase(":memory:");
    const lines: string[] = [];
    const context = {
      database,
      config: {} as never,
      intentConfig: defaultIntentConfig(),
      stdout: (line: string) => lines.push(line),
    };
    await runIntentCommand(["hero", "init", "S"], context);
    database.exec("DELETE FROM heroes");
    expect(await runIntentCommand(["rebuild"], context)).toBe(0);
    expect((database.query("SELECT count(*) AS n FROM heroes").get() as { n: number }).n).toBe(1);
  });
});
