import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db/database";
import { runIntentCommand } from "../../src/intent/cli";
import { defaultIntentConfig } from "../../src/intent/config";
import { resolveQuest } from "../../src/intent/projections/quest";

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

  test("list hides merged quests unless --all is passed", async () => {
    const { run, database, lines } = harness();
    await run(["hero", "init", "S"]);
    await run(["quest", "add", "--owner", "hero", "A"]);
    await run(["quest", "add", "--owner", "hero", "B"]);
    const [a, b] = database.query("SELECT id FROM quests ORDER BY title").all() as { id: string }[];
    await run(["quest", "merge", b?.id ?? "", "--into", a?.id ?? ""]);

    lines.length = 0;
    await run(["quest", "list"]);
    expect(lines.some((line) => line.startsWith(`${b?.id}  `))).toBe(false);
    expect(lines.some((line) => line.startsWith(`${a?.id}  `))).toBe(true);

    lines.length = 0;
    await run(["quest", "list", "--all"]);
    expect(lines.some((line) => line.startsWith(`${b?.id}  `))).toBe(true);
  });

  test("assigning an activity to a merged quest resolves through the merge", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    await run(["quest", "add", "--owner", "hero", "A"]);
    await run(["quest", "add", "--owner", "hero", "B"]);
    const [a, b] = database.query("SELECT id FROM quests ORDER BY title").all() as { id: string }[];
    expect(await run(["quest", "merge", b?.id ?? "", "--into", a?.id ?? ""])).toBe(0);

    const { askQuestion, openActivity, recordTrace } = await import("../../src/intent/api");
    const { EventStore } = await import("../../src/intent/store");
    const store = new EventStore(database);
    const activity = openActivity(store, database, { objective: "work", actor: "hook" });
    const trace = recordTrace(store, database, {
      activity,
      tool: "claude-code",
      place: "p",
      source: "session",
      sourceRef: "s",
      startedAt: "2026-09-04T15:00:00.000Z",
      endedAt: "2026-09-04T15:30:00.000Z",
      who: "hero",
      what: "x",
      why: "unknown",
      where: "w",
      how: "h",
      confidence: 0.3,
      classifiedBy: "hook",
      actor: "hook",
    });
    const question = askQuestion(store, database, {
      trace,
      kind: "which_quest",
      text: "Which quest?",
      actor: "hook",
    });
    expect(await run(["answer", question, "--quest", b?.id ?? ""])).toBe(0);
    const row = database.query("SELECT quest_id FROM activities WHERE id = ?").get(activity) as {
      quest_id: string;
    };
    expect(row.quest_id).toBe(a?.id ?? "");
  });

  test("reword without --objective keeps the existing objective (no NULL write)", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    await run(["quest", "add", "--owner", "hero", "Q", "--objective", "Original objective"]);
    const quest = database.query("SELECT id FROM quests").get() as { id: string };
    expect(await run(["quest", "reword", quest.id, "New title"])).toBe(0);
    const row = database
      .query("SELECT title, objective FROM quests WHERE id = ?")
      .get(quest.id) as { title: string; objective: string | null };
    expect(row.title).toBe("New title");
    expect(row.objective).toBe("Original objective");
  });

  test("unknown quest id: confirm/pause/resume/done/abandon/branch/return fail without appending events", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    const before = (database.query("SELECT count(*) AS n FROM events").get() as { n: number }).n;

    expect(await run(["quest", "confirm", "nope"])).toBe(1);
    expect(await run(["quest", "pause", "nope"])).toBe(1);
    expect(await run(["quest", "resume", "nope"])).toBe(1);
    expect(await run(["quest", "done", "nope"])).toBe(1);
    expect(await run(["quest", "abandon", "nope"])).toBe(1);
    expect(
      await run(["quest", "branch", "nope", "--from-activity", "act1", "--trigger", "t"]),
    ).toBe(1);
    expect(await run(["quest", "return", "nope", "--to", "alsonope"])).toBe(1);

    const after = (database.query("SELECT count(*) AS n FROM events").get() as { n: number }).n;
    expect(after).toBe(before);
  });

  test("merge resolves both ids and refuses merging a quest into itself", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    await run(["quest", "add", "--owner", "hero", "A"]);
    const a = database.query("SELECT id FROM quests").get() as { id: string };

    // direct self-merge is refused
    expect(await run(["quest", "merge", a.id, "--into", a.id])).toBe(1);

    // merging into an unknown quest fails
    expect(await run(["quest", "merge", a.id, "--into", "nope"])).toBe(1);

    // merging an unknown quest fails
    expect(await run(["quest", "merge", "nope", "--into", a.id])).toBe(1);
  });

  test("merge refuses when both sides resolve to the same underlying quest through a prior merge", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    await run(["quest", "add", "--owner", "hero", "A"]);
    await run(["quest", "add", "--owner", "hero", "B"]);
    const [a, b] = database.query("SELECT id FROM quests ORDER BY title").all() as {
      id: string;
    }[];
    expect(await run(["quest", "merge", b?.id ?? "", "--into", a?.id ?? ""])).toBe(0);
    // b is now merged into a; merging b into a again resolves to the same quest on both sides
    expect(await run(["quest", "merge", b?.id ?? "", "--into", a?.id ?? ""])).toBe(1);
  });

  test("resolveQuest throws on a merge cycle", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    await run(["quest", "add", "--owner", "hero", "A"]);
    await run(["quest", "add", "--owner", "hero", "B"]);
    const [a, b] = database.query("SELECT id FROM quests ORDER BY title").all() as {
      id: string;
    }[];
    // build a cycle directly at the projection level (a -> b -> a)
    database.query("UPDATE quests SET merged_into = ? WHERE id = ?").run(b?.id ?? "", a?.id ?? "");
    database.query("UPDATE quests SET merged_into = ? WHERE id = ?").run(a?.id ?? "", b?.id ?? "");
    expect(() => resolveQuest(database, a?.id ?? "")).toThrow(/cycle/);
  });

  test("answer with --quest new:... never writes the literal string into the event payload", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);

    const { askQuestion, openActivity, recordTrace } = await import("../../src/intent/api");
    const { EventStore } = await import("../../src/intent/store");
    const store = new EventStore(database);
    const activity = openActivity(store, database, { objective: "work", actor: "hook" });
    const trace = recordTrace(store, database, {
      activity,
      tool: "claude-code",
      place: "p",
      source: "session",
      sourceRef: "s",
      startedAt: "2026-09-04T15:00:00.000Z",
      endedAt: "2026-09-04T15:30:00.000Z",
      who: "hero",
      what: "x",
      why: "unknown",
      where: "w",
      how: "h",
      confidence: 0.3,
      classifiedBy: "hook",
      actor: "hook",
    });
    const question = askQuestion(store, database, {
      trace,
      kind: "which_quest",
      text: "Which quest?",
      actor: "hook",
    });

    expect(await run(["answer", question, "--quest", 'new:"Explore Astryx"'])).toBe(0);

    const newQuest = database.query("SELECT id, title FROM quests").get() as {
      id: string;
      title: string;
    };
    expect(newQuest.title).toBe('"Explore Astryx"');

    const answeredEvent = database
      .query("SELECT payload FROM events WHERE kind = 'question.answered' AND subject = ?")
      .get(question) as { payload: string };
    const payload = JSON.parse(answeredEvent.payload) as { quest: string };
    expect(payload.quest).toBe(newQuest.id);
    expect(payload.quest.startsWith("new:")).toBe(false);

    const activityRow = database
      .query("SELECT quest_id FROM activities WHERE id = ?")
      .get(activity) as { quest_id: string };
    expect(activityRow.quest_id).toBe(newQuest.id);
  });

  test("rebuild --until <date> prints a warning that projections are stuck in the past", async () => {
    const { run, lines } = harness();
    await run(["hero", "init", "S"]);
    await run(["quest", "add", "--owner", "hero", "A"]);

    lines.length = 0;
    expect(await run(["rebuild", "--until", "2026-01-01T00:00:00.000Z"])).toBe(0);
    expect(
      lines.some(
        (line) =>
          line ===
          "projections now reflect state as of 2026-01-01T00:00:00.000Z; run tempad rebuild to restore",
      ),
    ).toBe(true);

    lines.length = 0;
    expect(await run(["rebuild"])).toBe(0);
    expect(lines.length).toBe(0);
  });
});
