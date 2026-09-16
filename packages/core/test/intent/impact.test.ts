import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db/database";
import { queryImpacts, stateImpact } from "../../src/intent/api";
import { applyIncremental, ensureTables, rebuildAll } from "../../src/intent/projections";
import { registerAllProjections } from "../../src/intent/projections/register";
import { EventStore } from "../../src/intent/store";

registerAllProjections();

function harness() {
  const database = openDatabase(":memory:");
  ensureTables(database);
  const store = new EventStore(database);
  return { database, store };
}

describe("impacts projection", () => {
  test("state creates revision 1", () => {
    const { database, store } = harness();
    stateImpact(store, database, {
      subject: "commit:abc123",
      text: "Fixed login crash",
      hero: "hero",
    });
    const row = database.query("SELECT * FROM impacts WHERE subject = ?").get("commit:abc123") as {
      subject: string;
      subject_kind: string;
      text: string;
      theme: string | null;
      revision: number;
      retracted_at: string | null;
    };
    expect(row.subject_kind).toBe("commit");
    expect(row.text).toBe("Fixed login crash");
    expect(row.revision).toBe(1);
    expect(row.retracted_at).toBeNull();
  });

  test("restating the same subject is revision 2, later text wins", () => {
    const { database, store } = harness();
    stateImpact(store, database, { subject: "pr:org/repo#1", text: "First", hero: "hero" });
    stateImpact(store, database, {
      subject: "pr:org/repo#1",
      text: "Second",
      theme: "feature",
      hero: "hero",
    });
    const row = database
      .query("SELECT text, theme, revision FROM impacts WHERE subject = ?")
      .get("pr:org/repo#1") as { text: string; theme: string | null; revision: number };
    expect(row.text).toBe("Second");
    expect(row.theme).toBe("feature");
    expect(row.revision).toBe(2);
  });

  test("retracting the impact's row (subject = evidence ref, matching the rest of the codebase's convention) clears it", () => {
    const { database, store } = harness();
    const eventId = stateImpact(store, database, {
      subject: "monday:99",
      text: "Improved onboarding",
      hero: "hero",
    });
    applyIncremental(
      database,
      store.append({
        actor: "hero",
        kind: "retracted",
        subject: "monday:99",
        payload: { retracts: eventId, reason: "typo" },
      }),
    );
    const row = database
      .query("SELECT retracted_at FROM impacts WHERE subject = ?")
      .get("monday:99") as { retracted_at: string | null };
    expect(row.retracted_at).not.toBeNull();
  });

  test("queryImpacts returns only live rows for requested subjects", () => {
    const { database, store } = harness();
    stateImpact(store, database, { subject: "commit:a", text: "A", hero: "hero" });
    stateImpact(store, database, { subject: "commit:b", text: "B", hero: "hero" });
    const map = queryImpacts(database, ["commit:a", "commit:missing"]);
    expect(map.get("commit:a")).toEqual({ text: "A", theme: null });
    expect(map.has("commit:b")).toBe(false);
    expect(map.has("commit:missing")).toBe(false);
  });

  test("queryImpacts chunks subjects in groups of 500 to stay under SQLite's bind-variable limit", () => {
    const { database, store } = harness();
    const subjects = Array.from(
      { length: 1200 },
      (_, index) => `commit:${index.toString(16).padStart(7, "0")}`,
    );
    for (const subject of subjects) {
      stateImpact(store, database, { subject, text: `text for ${subject}`, hero: "hero" });
    }
    const map = queryImpacts(database, subjects);
    expect(map.size).toBe(1200);
    expect(map.get(subjects[0] as string)?.text).toBe(`text for ${subjects[0]}`);
    expect(map.get(subjects[1199] as string)?.text).toBe(`text for ${subjects[1199]}`);
  });

  test("stateImpact rejects an invalid theme", () => {
    const { database, store } = harness();
    expect(() =>
      stateImpact(store, database, {
        subject: "commit:a",
        text: "A",
        theme: "Not_Valid",
        hero: "hero",
      }),
    ).toThrow(/--theme/);
  });

  test("tempad rebuild replays impacts", () => {
    const { database, store } = harness();
    stateImpact(store, database, { subject: "commit:a", text: "A", theme: "fix", hero: "hero" });
    database.exec("DELETE FROM impacts");
    rebuildAll(database);
    const row = database
      .query("SELECT text, theme FROM impacts WHERE subject = ?")
      .get("commit:a") as { text: string; theme: string | null };
    expect(row.text).toBe("A");
    expect(row.theme).toBe("fix");
  });
});
