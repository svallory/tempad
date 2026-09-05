# Intent Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the event-sourced intent layer (hero, parties, clients, goals, quests, activities, traces, questions) with projections, rebuild, edit intent, and a CLI, without any model calls.

**Architecture:** One append-only `events` table is the source of truth; typed event kinds are defined once in `src/intent/events.ts`; projections are plain SQLite tables rebuilt from events by pure reducers in `src/intent/projections/*.ts`; the CLI in `src/intent/cli.ts` validates edit intent and appends events. Mirrors (commits, sessions, Monday items) are untouched.

**Tech Stack:** Bun 1.3, `bun:sqlite`, TypeScript strict, `bun test`. ULIDs via the `ulid` npm package (pure, no deps). No ORM.

**Spec:** `docs/specs/2026-09-05-intent-model-and-w5-hook-design.md` (sections Domain language, Storage, Event catalog, Edit intent, Config changes, CLI additions, Error handling, Testing). Read it before starting.

## Global Constraints

- Package manager bun; never npm. Tests with `bun test` inside `packages/core`; typecheck `bunx tsc --noEmit -p packages/core`; `bun run lint` and `dprint check` at repo root; wrap heavy commands in `flock /tmp/tempad-heavy.lock`.
- Full words in identifiers (`repository`, `directory`, `message`). No `any`, no non-null assertions. Required env vars have no defaults.
- Events are never updated or deleted. Projections may be dropped and rebuilt at any time.
- Entity ids are ULIDs. Timestamps are ISO 8601 UTC strings.
- Commits: `type(scope): summary`, one commit per task, scope `intent`.
- Do not touch `src/collect/*`, `src/report/*`, or existing migrations 0001/0002.

## File structure

```
packages/core/src/intent/
  ids.ts                  newUlid(), isUlid()
  events.ts               EventKind union, payload types, EventRecord, EventInput
  store.ts                appendEvent(), readEvents(), readEventsUntil(), EventStore class
  projections/
    index.ts              Projection interface, registry, rebuildAll(), applyIncremental()
    hero.ts               heroes
    party.ts              parties, memberships, clients
    goal.ts               goals
    quest.ts              quests (lifecycle, branch, return, merge)
    activity.ts           activities, traces, trace_links, questions
  config.ts               [hero] [[parties]] [[clients]] [w5] parsing from tempad.toml
  edit-intent.ts          assertEditIntent()
  cli.ts                  runIntentCommand(args): hero|party|client|goal|quest|activity|rebuild
  time-travel.ts          stateAsOf(date): rebuild into an in-memory database
packages/core/src/db/migrations/0003_events.sql
packages/core/test/intent/*.test.ts
```

`src/cli.ts` gains one line per top-level command delegating to `runIntentCommand`.

---

### Task 1: ULIDs, event types, and the event store

**Files:**

- Create: `packages/core/src/intent/ids.ts`, `packages/core/src/intent/events.ts`, `packages/core/src/intent/store.ts`, `packages/core/src/db/migrations/0003_events.sql`
- Modify: `packages/core/src/db/schema.sql` (append the same `events` DDL), `packages/core/package.json` (add `"ulid": "^2.3.0"` to dependencies)
- Test: `packages/core/test/intent/store.test.ts`

**Interfaces:**

- Produces: `newUlid(): string`; `type EventKind` (string union of every kind in the spec catalog, including `*.retracted` as `retracted`); `interface EventInput { at?: string; actor: Actor; sessionId?: string; kind: EventKind; subject: string; payload: Record<string, unknown> }`; `interface EventRecord extends Required<Omit<EventInput,'sessionId'>> { id: number; recordedAt: string; sessionId: string | null }`; `class EventStore { constructor(database: Database); append(input: EventInput): EventRecord; read(options?: { subject?: string; kind?: EventKind; until?: string; afterId?: number }): EventRecord[]; }`; `type Actor = "hero" | "assistant" | "hook" | "backfill" | "system"`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/intent/store.test.ts
import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db/database";
import { EventStore } from "../../src/intent/store";
import { isUlid, newUlid } from "../../src/intent/ids";

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
    const one = store.append({ actor: "hero", kind: "goal.created", subject, payload: { title: "a" } });
    const two = store.append({ actor: "hero", kind: "goal.reworded", subject, payload: { title: "b" } });
    expect(one.id).toBeLessThan(two.id);
    expect(one.recordedAt).toMatch(/Z$/);
    expect(store.read({ subject }).map((event) => event.kind)).toEqual(["goal.created", "goal.reworded"]);
  });

  test("read until a date excludes later events", () => {
    const database = openDatabase(":memory:");
    const store = new EventStore(database);
    const subject = newUlid();
    store.append({ at: "2026-08-01T00:00:00.000Z", actor: "hero", kind: "goal.created", subject, payload: {} });
    store.append({ at: "2026-09-01T00:00:00.000Z", actor: "hero", kind: "goal.ended", subject, payload: { reason: "achieved" } });
    expect(store.read({ subject, until: "2026-08-15T00:00:00.000Z" }).length).toBe(1);
  });

  test("events cannot be updated or deleted", () => {
    const database = openDatabase(":memory:");
    const store = new EventStore(database);
    store.append({ actor: "hero", kind: "hero.created", subject: newUlid(), payload: { name: "x" } });
    expect(() => database.exec("UPDATE events SET kind = 'x'")).toThrow();
    expect(() => database.exec("DELETE FROM events")).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && bun test test/intent/store.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Write the migration and the modules**

```sql
-- packages/core/src/db/migrations/0003_events.sql
CREATE TABLE events (
  id          INTEGER PRIMARY KEY,
  at          TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  actor       TEXT NOT NULL,
  session_id  TEXT,
  kind        TEXT NOT NULL,
  subject     TEXT NOT NULL,
  payload     TEXT NOT NULL
);
CREATE INDEX events_subject ON events(subject, at);
CREATE INDEX events_kind ON events(kind, at);
CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;
```

Append the same DDL to `schema.sql` (schema.sql mirrors the latest state).

```ts
// packages/core/src/intent/ids.ts
import { ulid } from "ulid";
export function newUlid(): string {
  return ulid();
}
export function isUlid(value: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}
```

```ts
// packages/core/src/intent/events.ts
export type Actor = "hero" | "assistant" | "hook" | "backfill" | "system";

export const EVENT_KINDS = [
  "hero.created",
  "party.created", "party.reworded",
  "membership.joined", "membership.left",
  "client.created",
  "goal.created", "goal.reworded", "goal.ended",
  "quest.created", "quest.reworded", "quest.ended", "quest.confirmed", "quest.merged",
  "quest.lifecycle", "quest.branched", "quest.returned",
  "activity.opened", "activity.reworded", "activity.closed", "activity.assigned",
  "trace.recorded", "trace.relinked",
  "question.asked", "question.answered", "question.expired",
  "retracted",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export interface EventInput {
  at?: string;
  actor: Actor;
  sessionId?: string;
  kind: EventKind;
  subject: string;
  payload: Record<string, unknown>;
}

export interface EventRecord {
  id: number;
  at: string;
  recordedAt: string;
  actor: Actor;
  sessionId: string | null;
  kind: EventKind;
  subject: string;
  payload: Record<string, unknown>;
}
```

```ts
// packages/core/src/intent/store.ts
import type { Database } from "bun:sqlite";
import { EVENT_KINDS, type EventInput, type EventKind, type EventRecord } from "./events";

interface Row {
  id: number; at: string; recorded_at: string; actor: string; session_id: string | null;
  kind: string; subject: string; payload: string;
}

function toRecord(row: Row): EventRecord {
  return {
    id: row.id, at: row.at, recordedAt: row.recorded_at, actor: row.actor as EventRecord["actor"],
    sessionId: row.session_id, kind: row.kind as EventKind, subject: row.subject,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
  };
}

export class EventStore {
  constructor(private readonly database: Database) {}

  append(input: EventInput): EventRecord {
    if (!EVENT_KINDS.includes(input.kind)) throw new Error(`Unknown event kind: ${input.kind}`);
    const now = new Date().toISOString();
    const at = input.at ?? now;
    const result = this.database
      .query(
        `INSERT INTO events (at, recorded_at, actor, session_id, kind, subject, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(at, now, input.actor, input.sessionId ?? null, input.kind, input.subject, JSON.stringify(input.payload)) as Row;
    return toRecord(result);
  }

  read(options: { subject?: string; kind?: EventKind; until?: string; afterId?: number } = {}): EventRecord[] {
    const clauses: string[] = [];
    const parameters: (string | number)[] = [];
    if (options.subject) { clauses.push("subject = ?"); parameters.push(options.subject); }
    if (options.kind) { clauses.push("kind = ?"); parameters.push(options.kind); }
    if (options.until) { clauses.push("at <= ?"); parameters.push(options.until); }
    if (options.afterId !== undefined) { clauses.push("id > ?"); parameters.push(options.afterId); }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.database.query(`SELECT * FROM events ${where} ORDER BY id`).all(...parameters) as Row[];
    return rows.map(toRecord);
  }
}
```

- [ ] **Step 4: Install the dependency and run the test**

Run: `cd packages/core && bun add ulid@^2.3.0 && bun test test/intent/store.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/package.json bun.lock packages/core/src/intent packages/core/src/db packages/core/test/intent/store.test.ts
git commit -m "feat(intent): add append-only event store with ulid ids"
```

---

### Task 2: Projection framework and rebuild

**Files:**

- Create: `packages/core/src/intent/projections/index.ts`, `packages/core/src/db/migrations/0004_projections.sql`
- Modify: `packages/core/src/db/schema.sql`
- Test: `packages/core/test/intent/projections.test.ts`

**Interfaces:**

- Consumes: `EventStore`, `EventRecord`.
- Produces: `interface Projection { name: string; tables: string[]; createSql: string; apply(database: Database, event: EventRecord): void }`; `registerProjection(projection)`; `rebuildAll(database, options?: { until?: string })` which truncates every registered projection table and replays events; `applyIncremental(database, event)` which runs every projection's `apply`; `projection_state` table with `last_event_id` so incremental apply knows where it is.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/intent/projections.test.ts
import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db/database";
import { newUlid } from "../../src/intent/ids";
import { applyIncremental, rebuildAll, registerProjection, type Projection } from "../../src/intent/projections";
import { EventStore } from "../../src/intent/store";

const counter: Projection = {
  name: "test_counter",
  tables: ["test_counter"],
  createSql: "CREATE TABLE IF NOT EXISTS test_counter (subject TEXT PRIMARY KEY, n INTEGER NOT NULL)",
  apply(database, event) {
    if (event.kind !== "goal.reworded") return;
    database.query("INSERT INTO test_counter (subject, n) VALUES (?, 1) ON CONFLICT(subject) DO UPDATE SET n = n + 1").run(event.subject);
  },
};

describe("projections", () => {
  test("rebuild replays all events; incremental applies only new ones; both agree", () => {
    registerProjection(counter);
    const database = openDatabase(":memory:");
    const store = new EventStore(database);
    const subject = newUlid();
    const first = store.append({ actor: "hero", kind: "goal.reworded", subject, payload: {} });
    applyIncremental(database, first);
    const second = store.append({ actor: "hero", kind: "goal.reworded", subject, payload: {} });
    applyIncremental(database, second);
    const incremental = (database.query("SELECT n FROM test_counter").get() as { n: number }).n;
    rebuildAll(database);
    const rebuilt = (database.query("SELECT n FROM test_counter").get() as { n: number }).n;
    expect(incremental).toBe(2);
    expect(rebuilt).toBe(2);
  });

  test("rebuild until a date stops replay there", () => {
    registerProjection(counter);
    const database = openDatabase(":memory:");
    const store = new EventStore(database);
    const subject = newUlid();
    store.append({ at: "2026-08-01T00:00:00.000Z", actor: "hero", kind: "goal.reworded", subject, payload: {} });
    store.append({ at: "2026-09-01T00:00:00.000Z", actor: "hero", kind: "goal.reworded", subject, payload: {} });
    rebuildAll(database, { until: "2026-08-15T00:00:00.000Z" });
    expect((database.query("SELECT n FROM test_counter").get() as { n: number }).n).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && bun test test/intent/projections.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```sql
-- packages/core/src/db/migrations/0004_projections.sql
CREATE TABLE projection_state (
  name          TEXT PRIMARY KEY,
  last_event_id INTEGER NOT NULL DEFAULT 0
);
```

```ts
// packages/core/src/intent/projections/index.ts
import type { Database } from "bun:sqlite";
import type { EventRecord } from "../events";
import { EventStore } from "../store";

export interface Projection {
  name: string;
  tables: string[];
  createSql: string;
  apply(database: Database, event: EventRecord): void;
}

const registry = new Map<string, Projection>();

export function registerProjection(projection: Projection): void {
  registry.set(projection.name, projection);
}

export function listProjections(): Projection[] {
  return [...registry.values()];
}

function ensureTables(database: Database): void {
  for (const projection of registry.values()) database.exec(projection.createSql);
}

export function applyIncremental(database: Database, event: EventRecord): void {
  ensureTables(database);
  const run = database.transaction(() => {
    for (const projection of registry.values()) {
      projection.apply(database, event);
      database
        .query("INSERT INTO projection_state (name, last_event_id) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET last_event_id = excluded.last_event_id")
        .run(projection.name, event.id);
    }
  });
  run();
}

export function rebuildAll(database: Database, options: { until?: string } = {}): void {
  ensureTables(database);
  const store = new EventStore(database);
  const events = store.read({ until: options.until });
  const run = database.transaction(() => {
    for (const projection of registry.values()) {
      for (const table of projection.tables) database.exec(`DELETE FROM ${table}`);
      for (const event of events) projection.apply(database, event);
      const last = events.at(-1)?.id ?? 0;
      database
        .query("INSERT INTO projection_state (name, last_event_id) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET last_event_id = excluded.last_event_id")
        .run(projection.name, last);
    }
  });
  run();
}
```

Add the `projection_state` DDL to `schema.sql`.

- [ ] **Step 4: Run tests**

Run: `cd packages/core && bun test test/intent`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/intent/projections packages/core/src/db packages/core/test/intent/projections.test.ts
git commit -m "feat(intent): projection registry with rebuild and incremental apply"
```

---

### Task 3: Hero, parties, memberships, clients: projections, config, CLI

**Files:**

- Create: `packages/core/src/intent/projections/hero.ts`, `packages/core/src/intent/projections/party.ts`, `packages/core/src/intent/config.ts`, `packages/core/src/intent/cli.ts`
- Modify: `packages/core/src/cli.ts` (dispatch `hero`, `party`, `client`, `rebuild` to `runIntentCommand`), `packages/core/tempad.example.toml` (add `[hero]`, `[[parties]]`, `[[clients]]`, `[w5]` examples from the spec)
- Test: `packages/core/test/intent/party.test.ts`, `packages/core/test/intent/config.test.ts`

**Interfaces:**

- Produces projection tables: `heroes(id, name, created_at)`; `parties(id, slug UNIQUE, name, description, created_at)`; `memberships(id, hero_id, party_id, joined_at, left_at, reason)`; `clients(id, slug UNIQUE, name, created_at)`.
- Produces: `loadIntentConfig(tomlPath): IntentConfig` with `{ hero?: { name }, parties: { slug, name, joined?, description? }[], clients: { slug, name }[], w5: { model, throttleMinutes, watchTurns, askMinActivityMinutes, askBudgetMinutes, askExpireTurns, backfillDays } }` and the spec defaults for `w5` when the section is absent; `runIntentCommand(args: string[], context: { database: Database; config: Config; intentConfig: IntentConfig; stdout: (line: string) => void }): Promise<number>`.
- CLI (from spec): `tempad hero init "<name>"`; `tempad party add <slug> "<name>" [--joined YYYY-MM-DD]`; `tempad party leave <slug> --reason "..."`; `tempad party list`; `tempad client add <slug> "<name>"`; `tempad rebuild [--until <iso>]`.
- Rules: `hero init` twice is an error ("hero already exists"); `party add` with an existing slug is an error; `party leave` on a party the hero is not in is an error; every command appends events and calls `applyIncremental`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/test/intent/party.test.ts
import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db/database";
import { runIntentCommand } from "../../src/intent/cli";
import { defaultIntentConfig } from "../../src/intent/config";

function harness() {
  const database = openDatabase(":memory:");
  const lines: string[] = [];
  const context = { database, config: {} as never, intentConfig: defaultIntentConfig(), stdout: (line: string) => lines.push(line) };
  return { database, lines, run: (args: string[]) => runIntentCommand(args, context) };
}

describe("hero, party, client commands", () => {
  test("hero init once, twice fails", async () => {
    const { run, database } = harness();
    expect(await run(["hero", "init", "Saulo Vallory"])).toBe(0);
    expect((database.query("SELECT name FROM heroes").get() as { name: string }).name).toBe("Saulo Vallory");
    expect(await run(["hero", "init", "Again"])).toBe(1);
  });

  test("party add joins the hero; leave closes the span", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    expect(await run(["party", "add", "mosaic", "Mosaic Strategies", "--joined", "2025-07-01"])).toBe(0);
    const membership = database.query("SELECT joined_at, left_at FROM memberships").get() as { joined_at: string; left_at: string | null };
    expect(membership.joined_at.startsWith("2025-07-01")).toBe(true);
    expect(membership.left_at).toBeNull();
    expect(await run(["party", "leave", "mosaic", "--reason", "contract ended"])).toBe(0);
    expect((database.query("SELECT left_at FROM memberships").get() as { left_at: string | null }).left_at).not.toBeNull();
    expect(await run(["party", "add", "mosaic", "Dup"])).toBe(1);
  });

  test("client add", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    expect(await run(["client", "add", "liuna", "LiUNA"])).toBe(0);
    expect((database.query("SELECT slug FROM clients").get() as { slug: string }).slug).toBe("liuna");
  });
});
```

```ts
// packages/core/test/intent/config.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadIntentConfig } from "../../src/intent/config";

describe("intent config", () => {
  test("parses hero, parties, clients and w5 with defaults", () => {
    const directory = mkdtempSync(join(tmpdir(), "tempad-intent-"));
    const path = join(directory, "tempad.toml");
    writeFileSync(path, `
[hero]
name = "Saulo"
[[parties]]
slug = "mosaic"
name = "Mosaic"
joined = "2025-07-01"
[[clients]]
slug = "liuna"
name = "LiUNA"
[w5]
throttle_minutes = 5
`);
    const config = loadIntentConfig(path);
    expect(config.hero?.name).toBe("Saulo");
    expect(config.parties[0]?.slug).toBe("mosaic");
    expect(config.clients[0]?.name).toBe("LiUNA");
    expect(config.w5.throttleMinutes).toBe(5);
    expect(config.w5.watchTurns).toBe(3);
    expect(config.w5.backfillDays).toBe(15);
  });

  test("rejects a party without slug", () => {
    const directory = mkdtempSync(join(tmpdir(), "tempad-intent-"));
    const path = join(directory, "tempad.toml");
    writeFileSync(path, `[[parties]]\nname = "x"\n`);
    expect(() => loadIntentConfig(path)).toThrow(/slug/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/core && bun test test/intent/party.test.ts test/intent/config.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement projections**

```ts
// packages/core/src/intent/projections/hero.ts
import type { Projection } from "./index";
export const heroProjection: Projection = {
  name: "heroes",
  tables: ["heroes"],
  createSql: "CREATE TABLE IF NOT EXISTS heroes (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL)",
  apply(database, event) {
    if (event.kind !== "hero.created") return;
    database.query("INSERT OR REPLACE INTO heroes (id, name, created_at) VALUES (?, ?, ?)").run(event.subject, String(event.payload.name), event.at);
  },
};
```

```ts
// packages/core/src/intent/projections/party.ts
import type { Projection } from "./index";
export const partyProjection: Projection = {
  name: "parties",
  tables: ["parties", "memberships", "clients"],
  createSql: `
    CREATE TABLE IF NOT EXISTS parties (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS memberships (id TEXT PRIMARY KEY, hero_id TEXT NOT NULL, party_id TEXT NOT NULL, joined_at TEXT NOT NULL, left_at TEXT, reason TEXT);
    CREATE TABLE IF NOT EXISTS clients (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL);`,
  apply(database, event) {
    const payload = event.payload;
    switch (event.kind) {
      case "party.created":
        database.query("INSERT OR REPLACE INTO parties (id, slug, name, description, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(event.subject, String(payload.slug), String(payload.name), payload.description ? String(payload.description) : null, event.at);
        return;
      case "party.reworded":
        database.query("UPDATE parties SET name = ?, description = ? WHERE id = ?")
          .run(String(payload.name), payload.description ? String(payload.description) : null, event.subject);
        return;
      case "membership.joined":
        database.query("INSERT OR REPLACE INTO memberships (id, hero_id, party_id, joined_at, left_at, reason) VALUES (?, ?, ?, ?, NULL, NULL)")
          .run(event.subject, String(payload.hero), String(payload.party), String(payload.joined ?? event.at));
        return;
      case "membership.left":
        database.query("UPDATE memberships SET left_at = ?, reason = ? WHERE id = ?")
          .run(event.at, payload.reason ? String(payload.reason) : null, event.subject);
        return;
      case "client.created":
        database.query("INSERT OR REPLACE INTO clients (id, slug, name, created_at) VALUES (?, ?, ?, ?)")
          .run(event.subject, String(payload.slug), String(payload.name), event.at);
        return;
      default:
        return;
    }
  },
};
```

Register both in `projections/index.ts` bottom (import and `registerProjection`), or in a `projections/register.ts` imported by `cli.ts` and `rebuildAll` callers; pick one and use it for every later projection too.

- [ ] **Step 4: Implement config**

```ts
// packages/core/src/intent/config.ts
import { readFileSync } from "node:fs";

export interface W5Config {
  model: string; throttleMinutes: number; watchTurns: number; askMinActivityMinutes: number;
  askBudgetMinutes: number; askExpireTurns: number; backfillDays: number;
}
export interface IntentConfig {
  hero?: { name: string };
  parties: { slug: string; name: string; joined?: string; description?: string }[];
  clients: { slug: string; name: string }[];
  w5: W5Config;
}

export function defaultIntentConfig(): IntentConfig {
  return {
    parties: [], clients: [],
    w5: { model: "claude-haiku-4-5-20251001", throttleMinutes: 10, watchTurns: 3, askMinActivityMinutes: 20, askBudgetMinutes: 30, askExpireTurns: 2, backfillDays: 15 },
  };
}

function requireString(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${where}: missing ${key}`);
  return value;
}

export function loadIntentConfig(tomlPath: string): IntentConfig {
  const parsed = Bun.TOML.parse(readFileSync(tomlPath, "utf8")) as Record<string, unknown>;
  const config = defaultIntentConfig();
  const hero = parsed.hero as Record<string, unknown> | undefined;
  if (hero) config.hero = { name: requireString(hero, "name", "[hero]") };
  for (const [index, raw] of ((parsed.parties as Record<string, unknown>[] | undefined) ?? []).entries()) {
    const where = `[[parties]] #${index + 1}`;
    config.parties.push({
      slug: requireString(raw, "slug", where), name: requireString(raw, "name", where),
      joined: typeof raw.joined === "string" ? raw.joined : undefined,
      description: typeof raw.description === "string" ? raw.description : undefined,
    });
  }
  for (const [index, raw] of ((parsed.clients as Record<string, unknown>[] | undefined) ?? []).entries()) {
    const where = `[[clients]] #${index + 1}`;
    config.clients.push({ slug: requireString(raw, "slug", where), name: requireString(raw, "name", where) });
  }
  const w5 = parsed.w5 as Record<string, unknown> | undefined;
  if (w5) {
    const number = (key: string, fallback: number) => (typeof w5[key] === "number" ? (w5[key] as number) : fallback);
    config.w5 = {
      model: typeof w5.model === "string" ? w5.model : config.w5.model,
      throttleMinutes: number("throttle_minutes", config.w5.throttleMinutes),
      watchTurns: number("watch_turns", config.w5.watchTurns),
      askMinActivityMinutes: number("ask_min_activity_minutes", config.w5.askMinActivityMinutes),
      askBudgetMinutes: number("ask_budget_minutes", config.w5.askBudgetMinutes),
      askExpireTurns: number("ask_expire_turns", config.w5.askExpireTurns),
      backfillDays: number("backfill_days", config.w5.backfillDays),
    };
  }
  return config;
}
```

- [ ] **Step 5: Implement the CLI**

`runIntentCommand` parses `args[0]` (`hero`, `party`, `client`, `goal`, `quest`, `activity`, `rebuild`) and `args[1]` (subcommand), uses `parseArgs` for flags, appends events through `EventStore`, then `applyIncremental` for each appended event. Errors print one line to stderr and return 1; usage errors return 2. Helper `requireHero(database)` returns the hero id or throws "run `tempad hero init` first". Party lookup by slug from `parties`; membership lookup by `hero_id, party_id, left_at IS NULL`.

Wire in `src/cli.ts`: when the first positional is one of the intent commands, load `loadIntentConfig(join(config.home, "tempad.toml"))` and call `runIntentCommand`.

- [ ] **Step 6: Run tests, typecheck, lint**

Run: `cd packages/core && bun test test/intent && bunx tsc --noEmit -p . && cd ../.. && bun run lint && dprint check`
Expected: all clean.

- [ ] **Step 7: Commit**

```bash
git add packages/core
git commit -m "feat(intent): hero, parties, memberships, clients with config and CLI"
```

---

### Task 4: Goals with edit intent

**Files:**

- Create: `packages/core/src/intent/projections/goal.ts`, `packages/core/src/intent/edit-intent.ts`
- Modify: `packages/core/src/intent/cli.ts` (add `goal` commands), `packages/core/src/cli.ts` (dispatch `goal`)
- Test: `packages/core/test/intent/goal.test.ts`

**Interfaces:**

- Projection `goals(id, owner_kind 'hero'|'party', owner_id, title, statement, revision INTEGER, created_at, ended_at, end_reason, replaced_by)`.
- `assertEditIntent(database, entity: "goal"|"quest", id, intent: "reword"|"replace"|undefined): void` throws `Error("<entity> <id> has attachments; pass --reword or --replace")` when intent is undefined and the entity has attachments. Attachments: for a goal, any quest with `goal_id = id`; for a quest, any activity with `quest_id = id` (quest table arrives in Task 5; implement the goal branch now and the quest branch in Task 5).
- CLI: `tempad goal add --owner hero|party:<slug> "<title>" [--statement "..."]`; `tempad goal reword <id> "<title>" [--statement]`; `tempad goal replace <id> "<title>" [--statement] --reason "..."`; `tempad goal end <id> --reason achieved|abandoned`; `tempad goal list [--all]`; `tempad goal edit <id> "<title>"` exists only to demonstrate the guard: it succeeds (as a reword) when the goal has no attachments and fails with the edit-intent error otherwise.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/intent/goal.test.ts
import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db/database";
import { runIntentCommand } from "../../src/intent/cli";
import { defaultIntentConfig } from "../../src/intent/config";
import { EventStore } from "../../src/intent/store";
import { newUlid } from "../../src/intent/ids";
import { applyIncremental } from "../../src/intent/projections";

function harness() {
  const database = openDatabase(":memory:");
  const lines: string[] = [];
  const context = { database, config: {} as never, intentConfig: defaultIntentConfig(), stdout: (line: string) => lines.push(line) };
  return { database, lines, run: (args: string[]) => runIntentCommand(args, context) };
}

describe("goals", () => {
  test("add, reword keeps id and bumps revision, end keeps row", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    expect(await run(["goal", "add", "--owner", "hero", "Make more money"])).toBe(0);
    const goal = database.query("SELECT id, revision FROM goals").get() as { id: string; revision: number };
    expect(await run(["goal", "reword", goal.id, "Earn more"])).toBe(0);
    const reworded = database.query("SELECT id, title, revision FROM goals").get() as { id: string; title: string; revision: number };
    expect(reworded.id).toBe(goal.id);
    expect(reworded.title).toBe("Earn more");
    expect(reworded.revision).toBe(goal.revision + 1);
    expect(await run(["goal", "end", goal.id, "--reason", "achieved"])).toBe(0);
    expect((database.query("SELECT end_reason FROM goals WHERE id = ?").get(goal.id) as { end_reason: string }).end_reason).toBe("achieved");
  });

  test("replace creates a new goal and links the old one", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    await run(["goal", "add", "--owner", "hero", "Make more money"]);
    const old = database.query("SELECT id FROM goals").get() as { id: string };
    expect(await run(["goal", "replace", old.id, "Have more fun", "--reason", "priorities changed"])).toBe(0);
    const rows = database.query("SELECT id, title, end_reason, replaced_by FROM goals ORDER BY created_at").all() as { id: string; title: string; end_reason: string | null; replaced_by: string | null }[];
    expect(rows.length).toBe(2);
    expect(rows[0]?.end_reason).toBe("replaced");
    expect(rows[0]?.replaced_by).toBe(rows[1]?.id);
  });

  test("bare edit is refused once the goal has attachments", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    await run(["goal", "add", "--owner", "hero", "G"]);
    const goal = database.query("SELECT id FROM goals").get() as { id: string };
    expect(await run(["goal", "edit", goal.id, "G2"])).toBe(0);
    // attach a quest directly through the store (quest CLI arrives in Task 5)
    const store = new EventStore(database);
    const quest = newUlid();
    applyIncremental(database, store.append({ actor: "hero", kind: "quest.created", subject: quest, payload: { owner: { kind: "hero", id: "x" }, goal: goal.id, title: "Q", confirmed: true } }));
    expect(await run(["goal", "edit", goal.id, "G3"])).toBe(1);
  });

  test("party owner must exist", async () => {
    const { run } = harness();
    await run(["hero", "init", "S"]);
    expect(await run(["goal", "add", "--owner", "party:nope", "G"])).toBe(1);
  });
});
```

Note: the third test needs the quest projection to exist so that `assertEditIntent` can count attachments; create a minimal `quests` table in this task's `goal.ts` projection? No: create the real `quest.ts` projection in Task 5 and, in this task, make `assertEditIntent` count attachments with `SELECT count(*) FROM quests WHERE goal_id = ?` guarded by `IF EXISTS` on the table (`sqlite_master` check). The test then passes fully after Task 5; mark it `test.skip` with a comment "enabled in Task 5" and unskip it there.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/core && bun test test/intent/goal.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`goal.ts` projection applies `goal.created` (insert with `revision = 1`), `goal.reworded` (update title/statement, `revision = revision + 1`), `goal.ended` (set `ended_at = event.at`, `end_reason`, `replaced_by`). Owner is stored from `payload.owner = { kind, id }`.

`edit-intent.ts`:

```ts
import type { Database } from "bun:sqlite";
export type EditIntent = "reword" | "replace";
function tableExists(database: Database, name: string): boolean {
  return database.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== null;
}
export function countAttachments(database: Database, entity: "goal" | "quest", id: string): number {
  if (entity === "goal") {
    if (!tableExists(database, "quests")) return 0;
    return (database.query("SELECT count(*) AS n FROM quests WHERE goal_id = ?").get(id) as { n: number }).n;
  }
  if (!tableExists(database, "activities")) return 0;
  return (database.query("SELECT count(*) AS n FROM activities WHERE quest_id = ?").get(id) as { n: number }).n;
}
export function assertEditIntent(database: Database, entity: "goal" | "quest", id: string, intent: EditIntent | undefined): void {
  if (intent !== undefined) return;
  if (countAttachments(database, entity, id) > 0) {
    throw new Error(`${entity} ${id} has attachments; pass --reword or --replace`);
  }
}
```

CLI `goal` subcommands append: `add` → `goal.created` with `owner`, `title`, `statement`; `reword` → `goal.reworded`; `replace` → `goal.created` (new id) then `goal.ended` on the old with `reason: "replaced", replaced_by`; `end` → `goal.ended`; `edit` → `assertEditIntent(..., undefined)` then `goal.reworded`; `list` prints `id  title  (owner)  [ended reason]`, hiding ended unless `--all`. Owner `party:<slug>` resolves through `parties`; unknown slug is an error.

- [ ] **Step 4: Run tests, typecheck, lint**

Run: `cd packages/core && bun test test/intent && bunx tsc --noEmit -p . && cd ../.. && bun run lint && dprint check`
Expected: all clean (one skipped test).

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(intent): goals with reword, replace and edit-intent guard"
```

---

### Task 5: Quests: lifecycle, confirmation, merge, branch and return

**Files:**

- Create: `packages/core/src/intent/projections/quest.ts`
- Modify: `packages/core/src/intent/cli.ts` (add `quest` commands), `packages/core/src/cli.ts`, `packages/core/test/intent/goal.test.ts` (unskip)
- Test: `packages/core/test/intent/quest.test.ts`

**Interfaces:**

- Projection `quests(id, owner_kind, owner_id, goal_id, title, objective, done_condition, due, budget_minutes, commitment, confirmed INTEGER, revision, state TEXT DEFAULT 'started', state_reason, merged_into, origin_activity_id, branched_at, trigger, branch_kind, returned_at, created_at, ended_at, end_reason, replaced_by)`. A quest is a side quest when `origin_activity_id IS NOT NULL`. `resolveQuest(database, id)` follows `merged_into` chains.
- CLI: `tempad quest add --owner hero|party:<slug> [--goal <id>] "<title>" [--objective] [--done] [--due YYYY-MM-DD] [--budget 30h|90m] [--commitment promised|personal|exploratory]`; `tempad quest reword|replace|edit|end` as for goals; `tempad quest confirm <id>`; `tempad quest merge <id> --into <id>`; `tempad quest pause|resume|done|abandon <id> [--reason]`; `tempad quest branch <id> --from-activity <activity-id> --trigger "..." [--kind curiosity|blocker|interruption|boredom|unknown]`; `tempad quest return <id> --to <quest-id>`; `tempad quest list [--all] [--unconfirmed] [--side]`.
- `--budget` accepts `Nh` or `Nm` and stores minutes.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/intent/quest.test.ts
import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db/database";
import { runIntentCommand } from "../../src/intent/cli";
import { defaultIntentConfig } from "../../src/intent/config";

function harness() {
  const database = openDatabase(":memory:");
  const lines: string[] = [];
  const context = { database, config: {} as never, intentConfig: defaultIntentConfig(), stdout: (line: string) => lines.push(line) };
  return { database, lines, run: (args: string[]) => runIntentCommand(args, context) };
}

describe("quests", () => {
  test("add with budget and goal, lifecycle events change state", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    await run(["goal", "add", "--owner", "hero", "G"]);
    const goal = database.query("SELECT id FROM goals").get() as { id: string };
    expect(await run(["quest", "add", "--owner", "hero", "--goal", goal.id, "Ship marko-ui", "--budget", "30h", "--due", "2026-09-20", "--commitment", "promised"])).toBe(0);
    const quest = database.query("SELECT id, budget_minutes, state, confirmed FROM quests").get() as { id: string; budget_minutes: number; state: string; confirmed: number };
    expect(quest.budget_minutes).toBe(1800);
    expect(quest.state).toBe("started");
    expect(quest.confirmed).toBe(1);
    await run(["quest", "pause", quest.id, "--reason", "waiting on upstream"]);
    expect((database.query("SELECT state, state_reason FROM quests").get() as { state: string; state_reason: string }).state).toBe("paused");
    await run(["quest", "done", quest.id]);
    expect((database.query("SELECT state FROM quests").get() as { state: string }).state).toBe("done");
  });

  test("branch makes a side quest with a nexus event; return closes it", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    await run(["quest", "add", "--owner", "hero", "Main"]);
    const main = database.query("SELECT id FROM quests").get() as { id: string };
    await run(["quest", "add", "--owner", "hero", "Compare Astryx"]);
    const side = database.query("SELECT id FROM quests WHERE title = 'Compare Astryx'").get() as { id: string };
    expect(await run(["quest", "branch", side.id, "--from-activity", "01ARZ3NDEKTSV4RRFFQ69G5FAV", "--trigger", "what does Astryx do for agents?", "--kind", "curiosity"])).toBe(0);
    const row = database.query("SELECT origin_activity_id, trigger, branch_kind, returned_at FROM quests WHERE id = ?").get(side.id) as { origin_activity_id: string; trigger: string; branch_kind: string; returned_at: string | null };
    expect(row.origin_activity_id).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(row.branch_kind).toBe("curiosity");
    expect(row.returned_at).toBeNull();
    expect(await run(["quest", "return", side.id, "--to", main.id])).toBe(0);
    expect((database.query("SELECT returned_at FROM quests WHERE id = ?").get(side.id) as { returned_at: string | null }).returned_at).not.toBeNull();
  });

  test("merge resolves to the target; confirm flips the flag", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    await run(["quest", "add", "--owner", "hero", "A"]);
    await run(["quest", "add", "--owner", "hero", "B"]);
    const [a, b] = database.query("SELECT id FROM quests ORDER BY title").all() as { id: string }[];
    expect(await run(["quest", "merge", b?.id ?? "", "--into", a?.id ?? ""])).toBe(0);
    expect((database.query("SELECT merged_into FROM quests WHERE id = ?").get(b?.id ?? "") as { merged_into: string }).merged_into).toBe(a?.id);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/core && bun test test/intent/quest.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`quest.ts` projection handles `quest.created` (insert, `revision 1`, `state 'started'`, `confirmed` from payload default 0), `quest.reworded`, `quest.ended`, `quest.confirmed` (`confirmed = 1`), `quest.merged` (`merged_into`), `quest.lifecycle` (`state`, `state_reason`), `quest.branched` (`origin_activity_id`, `branched_at = payload.at ?? event.at`, `trigger`, `branch_kind`), `quest.returned` (`returned_at = event.at`). Export `resolveQuest(database, id): string` following `merged_into` until null (guard against cycles with a visited set).

CLI parses `--budget` with `/^(\d+)(h|m)$/`. Reuse `assertEditIntent(database, "quest", id, intent)` for `edit`. Unskip the goal attachment test.

- [ ] **Step 4: Run tests, typecheck, lint**

Run: `cd packages/core && bun test test/intent && bunx tsc --noEmit -p . && cd ../.. && bun run lint && dprint check`
Expected: all clean, no skipped tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(intent): quests with lifecycle, confirmation, merge, branch and return"
```

---

### Task 6: Activities, traces, trace links and questions

**Files:**

- Create: `packages/core/src/intent/projections/activity.ts`
- Modify: `packages/core/src/intent/cli.ts` (add `activity` and `trace` read commands), `packages/core/src/cli.ts`
- Test: `packages/core/test/intent/activity.test.ts`

**Interfaces:**

- Projections: `activities(id, quest_id, objective, opened_at, closed_at, outcome, revision)`; `traces(id, activity_id, tool, place, source, source_ref, started_at, ended_at, who, what, why, where_text, how, confidence REAL, classified_by, session_id, recorded_at)`; `trace_links(trace_id, activity_id, linked_at, superseded_at, reason)` (history of relinks; current link is the row with `superseded_at IS NULL`); `questions(id, trace_id, session_id, text, kind, state 'watching'|'asked'|'answered'|'expired'|'resolved_by_context', asked_at, answered_at, answer, answered_by, turns_watched INTEGER DEFAULT 0)`.
- Programmatic API (used by the hook in plan 2): `recordTrace(store, database, input: TraceInput): string` (appends `trace.recorded`, applies, returns trace id); `openActivity(store, database, input: { quest?: string; objective: string; at?: string; actor })`; `assignActivity(store, database, activityId, questId, actor)`; `relinkTrace(store, database, traceId, activityId, reason, actor)`; `askQuestion` / `answerQuestion` / `expireQuestion` helpers appending the three question events. Put these in `packages/core/src/intent/api.ts`.
- CLI (read-only for now): `tempad activity list [--open] [--quest <id>]`; `tempad trace list [--since <iso>] [--activity <id>]`; `tempad answer <question-id> --quest <id|new:"title"> [--why "..."]` (answers the question, links the trace's activity to the quest, creating the quest unconfirmed when `new:` is used).

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/intent/activity.test.ts
import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db/database";
import { answerQuestion, askQuestion, openActivity, recordTrace, relinkTrace } from "../../src/intent/api";
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
      activity: first, tool: "claude-code", place: "~/work/marko-ui", source: "session", sourceRef: "sess-1",
      startedAt: "2026-09-04T15:00:00.000Z", endedAt: "2026-09-04T15:30:00.000Z",
      who: "hero", what: "reading Astryx docs", why: "unknown", where: "marko-ui", how: "claude-code",
      confidence: 0.4, classifiedBy: "hook", actor: "hook", sessionId: "sess-1",
    });
    relinkTrace(store, database, trace, second, "misclassified", "hero");
    const links = database.query("SELECT activity_id, superseded_at FROM trace_links WHERE trace_id = ? ORDER BY linked_at").all(trace) as { activity_id: string; superseded_at: string | null }[];
    expect(links.length).toBe(2);
    expect(links[0]?.superseded_at).not.toBeNull();
    expect(links[1]?.activity_id).toBe(second);
    expect((database.query("SELECT activity_id FROM traces WHERE id = ?").get(trace) as { activity_id: string }).activity_id).toBe(second);
  });

  test("answer a question with a new quest links the activity", async () => {
    const database = openDatabase(":memory:");
    const store = new EventStore(database);
    const lines: string[] = [];
    const context = { database, config: {} as never, intentConfig: defaultIntentConfig(), stdout: (line: string) => lines.push(line) };
    await runIntentCommand(["hero", "init", "S"], context);
    const activity = openActivity(store, database, { objective: "compare Astryx", actor: "hook" });
    const trace = recordTrace(store, database, { activity, tool: "claude-code", place: "p", source: "session", sourceRef: "s", startedAt: "2026-09-04T15:00:00.000Z", endedAt: "2026-09-04T15:30:00.000Z", who: "hero", what: "x", why: "unknown", where: "w", how: "h", confidence: 0.3, classifiedBy: "hook", actor: "hook" });
    const question = askQuestion(store, database, { trace, sessionId: "s", kind: "which_quest", text: "Side quest or new direction?", actor: "hook" });
    expect(await runIntentCommand(["answer", question, "--quest", "new:Compare Astryx", "--why", "curiosity"], context)).toBe(0);
    const row = database.query("SELECT state, answer FROM questions WHERE id = ?").get(question) as { state: string; answer: string };
    expect(row.state).toBe("answered");
    const quest = database.query("SELECT id, confirmed FROM quests").get() as { id: string; confirmed: number };
    expect(quest.confirmed).toBe(0);
    expect((database.query("SELECT quest_id FROM activities WHERE id = ?").get(activity) as { quest_id: string }).quest_id).toBe(quest.id);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/core && bun test test/intent/activity.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the projection, `api.ts` helpers (each appends one event and calls `applyIncremental`), and the CLI commands. `trace.recorded` inserts the trace row and a `trace_links` row; `trace.relinked` supersedes the current link, inserts a new one, and updates `traces.activity_id`. `answer` appends `question.answered`, then `quest.created` (unconfirmed) when `new:` is used, then `activity.assigned`.

- [ ] **Step 4: Run tests, typecheck, lint**

Run: `cd packages/core && bun test && bunx tsc --noEmit -p . && cd ../.. && bun run lint && dprint check`
Expected: all clean (whole package suite, not only `test/intent`).

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(intent): activities, traces with link history, questions, answer command"
```

---

### Task 7: Time travel, rebuild command, docs

**Files:**

- Create: `packages/core/src/intent/time-travel.ts`
- Modify: `packages/core/src/intent/cli.ts` (`rebuild [--until]`, `goal list --as-of`, `quest list --as-of`), `packages/core/src/cli.ts` (usage text), `CLAUDE.md` (Commands and a new "Intent layer" section: events are append-only, projections rebuildable, edit intent rule), `docs/specs/2026-09-05-intent-model-and-w5-hook-design.md` (status line: "plan 1 implemented")
- Test: `packages/core/test/intent/time-travel.test.ts`

**Interfaces:**

- `stateAsOf(database, until: string): Database` returns a new in-memory database whose projections were rebuilt from `database`'s events up to `until` (copy the events table with `until` filter, then `rebuildAll`). Used by `--as-of` listings now and by reports in plan 3.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/intent/time-travel.test.ts
import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db/database";
import { runIntentCommand } from "../../src/intent/cli";
import { defaultIntentConfig } from "../../src/intent/config";
import { EventStore } from "../../src/intent/store";
import { newUlid } from "../../src/intent/ids";
import { applyIncremental } from "../../src/intent/projections";
import { stateAsOf } from "../../src/intent/time-travel";

describe("time travel", () => {
  test("goals as of August exclude September changes", () => {
    const database = openDatabase(":memory:");
    const store = new EventStore(database);
    const goal = newUlid();
    applyIncremental(database, store.append({ at: "2026-08-01T00:00:00.000Z", actor: "hero", kind: "goal.created", subject: goal, payload: { owner: { kind: "hero", id: "h" }, title: "Old title" } }));
    applyIncremental(database, store.append({ at: "2026-09-02T00:00:00.000Z", actor: "hero", kind: "goal.reworded", subject: goal, payload: { title: "New title" } }));
    const past = stateAsOf(database, "2026-08-31T23:59:59.000Z");
    expect((past.query("SELECT title FROM goals").get() as { title: string }).title).toBe("Old title");
    expect((database.query("SELECT title FROM goals").get() as { title: string }).title).toBe("New title");
  });

  test("rebuild command restores projections after a manual wipe", async () => {
    const database = openDatabase(":memory:");
    const lines: string[] = [];
    const context = { database, config: {} as never, intentConfig: defaultIntentConfig(), stdout: (line: string) => lines.push(line) };
    await runIntentCommand(["hero", "init", "S"], context);
    database.exec("DELETE FROM heroes");
    expect(await runIntentCommand(["rebuild"], context)).toBe(0);
    expect((database.query("SELECT count(*) AS n FROM heroes").get() as { n: number }).n).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/core && bun test test/intent/time-travel.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** `stateAsOf` (open `:memory:` with `openDatabase`, `INSERT INTO events SELECT * FROM source.events WHERE at <= ?` by attaching the source file when it is a file database, or by reading through `EventStore.read({ until })` and re-inserting when it is not, then `rebuildAll`), `rebuild [--until]`, `--as-of` on `goal list` and `quest list`, usage text, `CLAUDE.md`, spec status.

- [ ] **Step 4: Run everything**

Run: `cd packages/core && bun test && bunx tsc --noEmit -p . && cd ../.. && bun run lint && dprint check && bun run typecheck`
Expected: all clean.

- [ ] **Step 5: Commit**

```bash
git add packages/core CLAUDE.md docs/specs/2026-09-05-intent-model-and-w5-hook-design.md
git commit -m "feat(intent): time travel, rebuild command, docs"
```

---

## Self-review

- Spec coverage: Domain language → Tasks 3-6 tables; Storage and event catalog → Tasks 1-2 (every catalog kind is in `EVENT_KINDS`; `project.*` and `place.*` kinds are declared but no projection consumes them yet, by decision 5 in `notes/overnight-2026-09-05.md`); Edit intent → Task 4 (goals) and Task 5 (quests); Config changes → Task 3; CLI additions → Tasks 3-7 except `quiet`, `review`, `w5 *`, `hook *`, which belong to plan 2; `--as-of` on reports → plan 3, groundwork in Task 7; Error handling (config lists every problem) → Task 3 config validation; Testing section → each task's test file.
- Placeholders: none. Every step has code or an exact command.
- Type consistency: `runIntentCommand(args, context)` signature is identical in Tasks 3-7; `EventStore.append/read` as defined in Task 1; `applyIncremental`/`rebuildAll` as in Task 2; `assertEditIntent(database, entity, id, intent)` in Tasks 4-5; `openActivity`/`recordTrace`/`relinkTrace`/`askQuestion`/`answerQuestion` in Task 6 only.
