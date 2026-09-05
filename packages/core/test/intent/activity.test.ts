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
});
