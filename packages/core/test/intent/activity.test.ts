import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db/database";
import { askQuestion, openActivity, recordTrace, relinkTrace } from "../../src/intent/api";
import { runIntentCommand } from "../../src/intent/cli";
import { defaultIntentConfig } from "../../src/intent/config";
import { EventStore } from "../../src/intent/store";

describe("activities and traces", () => {
  test("record a trace, relink it, history kept", () => {
    const database = openDatabase(":memory:");
    const store = new EventStore(database);
    const first = openActivity(store, database, { objective: "fix walk order", actor: "hook" });
    const second = openActivity(store, database, { objective: "compare Astryx", actor: "hook" });
    const trace = recordTrace(store, database, {
      activity: first,
      tool: "claude-code",
      place: "~/work/marko-ui",
      source: "session",
      sourceRef: "sess-1",
      startedAt: "2026-09-04T15:00:00.000Z",
      endedAt: "2026-09-04T15:30:00.000Z",
      who: "hero",
      what: "reading Astryx docs",
      why: "unknown",
      where: "marko-ui",
      how: "claude-code",
      confidence: 0.4,
      classifiedBy: "hook",
      actor: "hook",
      sessionId: "sess-1",
    });
    relinkTrace(store, database, trace, second, "misclassified", "hero");
    const links = database
      .query(
        "SELECT activity_id, superseded_at FROM trace_links WHERE trace_id = ? ORDER BY linked_at",
      )
      .all(trace) as { activity_id: string; superseded_at: string | null }[];
    expect(links.length).toBe(2);
    expect(links[0]?.superseded_at).not.toBeNull();
    expect(links[1]?.activity_id).toBe(second);
    expect(
      (
        database.query("SELECT activity_id FROM traces WHERE id = ?").get(trace) as {
          activity_id: string;
        }
      ).activity_id,
    ).toBe(second);
  });

  test("answer a question with a new quest links the activity", async () => {
    const database = openDatabase(":memory:");
    const store = new EventStore(database);
    const lines: string[] = [];
    const context = {
      database,
      config: {} as never,
      intentConfig: defaultIntentConfig(),
      stdout: (line: string) => lines.push(line),
    };
    await runIntentCommand(["hero", "init", "S"], context);
    const activity = openActivity(store, database, { objective: "compare Astryx", actor: "hook" });
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
      sessionId: "s",
      kind: "which_quest",
      text: "Side quest or new direction?",
      actor: "hook",
    });
    expect(
      await runIntentCommand(
        ["answer", question, "--quest", "new:Compare Astryx", "--why", "curiosity"],
        context,
      ),
    ).toBe(0);
    const row = database
      .query("SELECT state, answer FROM questions WHERE id = ?")
      .get(question) as { state: string; answer: string };
    expect(row.state).toBe("answered");
    const quest = database.query("SELECT id, confirmed FROM quests").get() as {
      id: string;
      confirmed: number;
    };
    expect(quest.confirmed).toBe(0);
    expect(
      (
        database.query("SELECT quest_id FROM activities WHERE id = ?").get(activity) as {
          quest_id: string;
        }
      ).quest_id,
    ).toBe(quest.id);
  });

  test("answer stores why text when --why is given", async () => {
    const database = openDatabase(":memory:");
    const store = new EventStore(database);
    const lines: string[] = [];
    const context = {
      database,
      config: {} as never,
      intentConfig: defaultIntentConfig(),
      stdout: (line: string) => lines.push(line),
    };
    await runIntentCommand(["hero", "init", "S"], context);
    const activity = openActivity(store, database, { objective: "compare Astryx", actor: "hook" });
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
      text: "Side quest or new direction?",
      actor: "hook",
    });
    expect(
      await runIntentCommand(
        ["answer", question, "--quest", "new:Compare Astryx", "--why", "curiosity"],
        context,
      ),
    ).toBe(0);
    const row = database
      .query("SELECT answer, answered_by FROM questions WHERE id = ?")
      .get(question) as { answer: string; answered_by: string };
    expect(row.answer).toBe("curiosity");
    expect(row.answered_by).toBe("hero");
  });

  test("answer falls back to the quest reference when --why is omitted", async () => {
    const database = openDatabase(":memory:");
    const store = new EventStore(database);
    const lines: string[] = [];
    const context = {
      database,
      config: {} as never,
      intentConfig: defaultIntentConfig(),
      stdout: (line: string) => lines.push(line),
    };
    await runIntentCommand(["hero", "init", "S"], context);
    await runIntentCommand(["quest", "add", "--owner", "hero", "Existing quest"], context);
    const quest = database.query("SELECT id FROM quests").get() as { id: string };
    const activity = openActivity(store, database, { objective: "compare Astryx", actor: "hook" });
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
      text: "Side quest or new direction?",
      actor: "hook",
    });
    expect(await runIntentCommand(["answer", question, "--quest", quest.id], context)).toBe(0);
    const row = database.query("SELECT answer FROM questions WHERE id = ?").get(question) as {
      answer: string;
    };
    expect(row.answer).toBe(quest.id);
  });
});

describe("tempad answer --belongs", () => {
  /** A trace under a quest, plus a `belongs` question about it. */
  async function seedBelongsQuestion() {
    const database = openDatabase(":memory:");
    const store = new EventStore(database);
    const lines: string[] = [];
    const context = {
      database,
      config: {} as never,
      intentConfig: defaultIntentConfig(),
      stdout: (line: string) => lines.push(line),
    };
    await runIntentCommand(["hero", "init", "S"], context);
    await runIntentCommand(
      ["quest", "add", "Ship marko-ui", "--objective", "86 components", "--owner", "hero"],
      context,
    );
    const quest = database.query("SELECT id FROM quests").get() as { id: string };
    const activity = openActivity(store, database, {
      objective: "fix walk order",
      quest: quest.id,
      actor: "hook",
    });
    const trace = recordTrace(store, database, {
      activity,
      tool: "claude-code",
      place: "p",
      source: "session",
      startedAt: "2026-09-04T15:00:00.000Z",
      endedAt: "2026-09-04T15:30:00.000Z",
      who: "hero",
      what: "x",
      why: "unknown",
      where: "w",
      how: "h",
      confidence: 0.9,
      classifiedBy: "assistant",
      actor: "hook",
    });
    const question = askQuestion(store, database, {
      trace,
      sessionId: "s1",
      kind: "belongs",
      text: "belongs",
      guess: "a competitor comparison",
      actor: "hook",
    });
    return { database, context, question, activity, quest };
  }

  test("--belongs answers the question and leaves the trace and its quest alone", async () => {
    const { database, context, question, activity, quest } = await seedBelongsQuestion();

    expect(
      await runIntentCommand(
        ["answer", question, "--belongs", "--why", "it is the same work"],
        context,
      ),
    ).toBe(0);

    const row = database
      .query("SELECT state, answer FROM questions WHERE id = ?")
      .get(question) as { state: string; answer: string };
    expect(row.state).toBe("answered");
    expect(row.answer).toBe("it is the same work");

    // "Yes it belongs" confirms the declared quest: nothing moves.
    const activityRow = database
      .query("SELECT quest_id as questId FROM activities WHERE id = ?")
      .get(activity) as { questId: string | null };
    expect(activityRow.questId).toBe(quest.id);
    expect(
      (database.query("SELECT COUNT(*) as count FROM quests").get() as { count: number }).count,
    ).toBe(1);
  });

  test("the question.answered payload records belongs: true", async () => {
    const { database, context, question } = await seedBelongsQuestion();

    await runIntentCommand(["answer", question, "--belongs"], context);

    const event = database
      .query("SELECT payload FROM events WHERE kind = 'question.answered' AND subject = ?")
      .get(question) as { payload: string };
    expect(JSON.parse(event.payload).belongs).toBe(true);
  });

  test("--belongs and --quest together are refused", async () => {
    const { context, question } = await seedBelongsQuestion();

    expect(
      await runIntentCommand(["answer", question, "--belongs", "--quest", "new:Other"], context),
    ).toBe(2);
  });

  test("neither --belongs nor --quest is refused", async () => {
    const { context, question } = await seedBelongsQuestion();

    expect(await runIntentCommand(["answer", question], context)).toBe(2);
  });

  test("--quest on a belongs question still moves the trace's activity", async () => {
    const { database, context, question, activity } = await seedBelongsQuestion();

    expect(
      await runIntentCommand(
        ["answer", question, "--quest", "new:Compare Astryx", "--why", "different work"],
        context,
      ),
    ).toBe(0);

    const moved = database
      .query("SELECT title FROM quests WHERE id = (SELECT quest_id FROM activities WHERE id = ?)")
      .get(activity) as { title: string };
    expect(moved.title).toBe("Compare Astryx");
  });

  test("--origin current on a new quest records the branch with its trigger and kind", async () => {
    const { database, context, question, activity } = await seedBelongsQuestion();

    expect(
      await runIntentCommand(
        [
          "answer",
          question,
          "--quest",
          "new:Compare Astryx",
          "--origin",
          "current",
          "--trigger",
          "what does Astryx do for agents?",
          "--kind",
          "curiosity",
        ],
        context,
      ),
    ).toBe(0);

    const branched = database
      .query("SELECT payload FROM events WHERE kind = 'quest.branched'")
      .get() as { payload: string };
    const payload = JSON.parse(branched.payload) as {
      from_activity: string;
      trigger: string;
      kind: string;
    };
    expect(payload.from_activity).toBe(activity);
    expect(payload.trigger).toBe("what does Astryx do for agents?");
    expect(payload.kind).toBe("curiosity");
  });

  test("--origin is refused without a new quest, and an unknown --kind is refused", async () => {
    const { context, question } = await seedBelongsQuestion();

    expect(
      await runIntentCommand(
        ["answer", question, "--quest", "new:X", "--origin", "current", "--kind", "sideways"],
        context,
      ),
    ).toBe(2);
  });
});
