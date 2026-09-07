import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db/database";
import {
  currentDeclaredQuest,
  currentDeclaredQuestForSubagent,
  declareQuest,
  hasAnyDeclaration,
} from "../../src/intent/declarations";
import { newUlid } from "../../src/intent/ids";
import { applyIncremental, ensureTables } from "../../src/intent/projections";
import { registerAllProjections } from "../../src/intent/projections/register";
import { EventStore } from "../../src/intent/store";

registerAllProjections();

function seedHero(database: ReturnType<typeof openDatabase>, store: EventStore): string {
  const id = newUlid();
  applyIncremental(
    database,
    store.append({ actor: "hero", kind: "hero.created", subject: id, payload: { name: "Saulo" } }),
  );
  return id;
}

describe("declarations", () => {
  test("declareQuest with an existing quest id makes it the current declared quest", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    const heroId = seedHero(database, store);
    const questId = newUlid();
    applyIncremental(
      database,
      store.append({
        actor: "hero",
        kind: "quest.created",
        subject: questId,
        payload: { owner: { kind: "hero", id: heroId }, title: "Ship X", confirmed: true },
      }),
    );

    declareQuest(store, database, {
      sessionId: "s1",
      questId,
      plan: ["write code", "ship it"],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-07T09:00:00.000Z",
      heroId,
    });

    const declared = currentDeclaredQuest(database, {
      sessionId: "s1",
      at: "2026-09-07T09:05:00.000Z",
    });
    expect(declared).toEqual({
      questId,
      title: "Ship X",
      aim: null,
      plan: ["write code", "ship it"],
      scope: "session",
      parentSessionId: null,
    });
  });

  test("declareQuest with --new creates a declared, confirmed quest and it round-trips", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    const heroId = seedHero(database, store);

    const result = declareQuest(store, database, {
      sessionId: "s1",
      newQuest: { title: "New thing", aim: "do the new thing", commitment: "personal" },
      plan: [],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-07T09:00:00.000Z",
      heroId,
    });

    expect(result.created).toBe(true);
    const quest = database
      .query("SELECT confirmed, origin_kind FROM quests WHERE id = ?")
      .get(result.questId) as { confirmed: number; origin_kind: string };
    expect(quest).toEqual({ confirmed: 1, origin_kind: "declared" });

    const declared = currentDeclaredQuest(database, {
      sessionId: "s1",
      at: "2026-09-07T09:05:00.000Z",
    });
    expect(declared?.questId).toBe(result.questId);
  });

  test("the most recent declaration at or before `at` wins", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    const heroId = seedHero(database, store);
    const first = declareQuest(store, database, {
      sessionId: "s1",
      newQuest: { title: "First", aim: "a", commitment: "personal" },
      plan: [],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-07T09:00:00.000Z",
      heroId,
    });
    const second = declareQuest(store, database, {
      sessionId: "s1",
      newQuest: { title: "Second", aim: "b", commitment: "personal" },
      plan: [],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-07T10:00:00.000Z",
      heroId,
    });

    expect(
      currentDeclaredQuest(database, { sessionId: "s1", at: "2026-09-07T09:30:00.000Z" })?.questId,
    ).toBe(first.questId);
    expect(
      currentDeclaredQuest(database, { sessionId: "s1", at: "2026-09-07T10:30:00.000Z" })?.questId,
    ).toBe(second.questId);
  });

  test("a subagent declaration is scoped to its parent session and does not leak to the parent's own query", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    const heroId = seedHero(database, store);
    declareQuest(store, database, {
      sessionId: "sub1",
      parentSessionId: "s1",
      newQuest: { title: "Subtask", aim: "help", commitment: "personal" },
      plan: [],
      scope: "subagent",
      declaredBy: "agent",
      at: "2026-09-07T09:00:00.000Z",
      heroId,
    });

    expect(
      currentDeclaredQuest(database, { sessionId: "s1", at: "2026-09-07T09:05:00.000Z" }),
    ).toBeNull();
    expect(
      currentDeclaredQuestForSubagent(database, {
        sessionId: "sub1",
        parentSessionId: "s1",
        at: "2026-09-07T09:05:00.000Z",
      })?.title,
    ).toBe("Subtask");
  });

  test("hasAnyDeclaration is false until a declaration exists for that session", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    const heroId = seedHero(database, store);
    expect(hasAnyDeclaration(database, "s1")).toBe(false);
    declareQuest(store, database, {
      sessionId: "s1",
      newQuest: { title: "X", aim: "y", commitment: "personal" },
      plan: [],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-07T09:00:00.000Z",
      heroId,
    });
    expect(hasAnyDeclaration(database, "s1")).toBe(true);
  });
});
