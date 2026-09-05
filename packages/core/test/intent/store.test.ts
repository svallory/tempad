import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db/database";
import { isUlid, newUlid } from "../../src/intent/ids";
import { EventStore } from "../../src/intent/store";

describe("event store", () => {
  test("ulids are 26 chars and sortable", () => {
    const first = newUlid();
    const second = newUlid();
    expect(isUlid(first)).toBe(true);
    expect(first < second || first === second).toBe(true);
  });

  test("append returns a record with id and recordedAt, read returns in order", () => {
    const database = openDatabase(":memory:");
    const store = new EventStore(database);
    const subject = newUlid();
    const one = store.append({
      actor: "hero",
      kind: "goal.created",
      subject,
      payload: { title: "a" },
    });
    const two = store.append({
      actor: "hero",
      kind: "goal.reworded",
      subject,
      payload: { title: "b" },
    });
    expect(one.id).toBeLessThan(two.id);
    expect(one.recordedAt).toMatch(/Z$/);
    expect(store.read({ subject }).map((event) => event.kind)).toEqual([
      "goal.created",
      "goal.reworded",
    ]);
  });

  test("read until a date excludes later events", () => {
    const database = openDatabase(":memory:");
    const store = new EventStore(database);
    const subject = newUlid();
    store.append({
      at: "2026-08-01T00:00:00.000Z",
      actor: "hero",
      kind: "goal.created",
      subject,
      payload: {},
    });
    store.append({
      at: "2026-09-01T00:00:00.000Z",
      actor: "hero",
      kind: "goal.ended",
      subject,
      payload: { reason: "achieved" },
    });
    expect(store.read({ subject, until: "2026-08-15T00:00:00.000Z" }).length).toBe(1);
  });

  test("events cannot be updated or deleted", () => {
    const database = openDatabase(":memory:");
    const store = new EventStore(database);
    store.append({
      actor: "hero",
      kind: "hero.created",
      subject: newUlid(),
      payload: { name: "x" },
    });
    expect(() => database.exec("UPDATE events SET kind = 'x'")).toThrow();
    expect(() => database.exec("DELETE FROM events")).toThrow();
  });
});
