# Declared Quests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quest identity comes from the executing agent's own declaration, not the classifier. The classifier becomes a verifier: it flags stretches of work that don't match the session's declared quest (`belongs: false`) instead of matching or inventing quests. Sessions with no declaration get asked to declare; sessions that never will (backfilled history) fall back to today's inference behavior. Non-Claude evidence (commits, Monday items) is attributed to a quest at report time via the declaring session active at that moment.

**Architecture:** Strictly serial — Task 1 → Task 2 → Task 3, each merged before the next starts. Task 1 lands the schema, event, CLI, skill, and hook-context pieces every declared session needs, independent of the classifier — a database can record and query declarations with zero changes to `window.ts`/`prompt.ts`/`classifier.ts`/`apply.ts`. Task 2 (depends on Task 1) rewrites the classifier/window/prompt/apply chain to run in verifier mode when `[w5].mode = "declared"`, including the alias scheme, the `belongs`/`declare` question kinds, the parent-session rollup (carried entirely in the `quest.declared` event payload, no schema change), and the inference fallback for undeclared backfill sessions. Task 3 (depends on Task 2, serially — its `doubts`/`doubtsAnswered` metrics and `belongs`/`declare` fixtures don't exist until Task 2 lands) adds non-Claude attribution to the report layer and `--declare`/metrics to `w5 eval`.

**Tech Stack:** Bun 1.3, `bun:sqlite`, TypeScript strict, `bun test`. No new runtime dependencies.

**Spec:** `docs/specs/2026-09-07-declared-quests-design.md`. Builds on `docs/specs/2026-09-05-intent-model-and-w5-hook-design.md` and `docs/specs/2026-09-06-activity-continuity-design.md` (read for existing conventions: `EventStore`, `applyIncremental`, `Projection`, `ClassifierWindow`/`ClassifierResult`, `W5Config`, `openActivityContinuing`, the alias-free activity id scheme this plan changes).

## Global Constraints

- Same as prior w5 plans: bun only, full-word identifiers, no `any`, no non-null assertions, commits `type(w5): summary`, one per task.
- A pure `ALTER TABLE ... ADD COLUMN` migration gets `runMigration`'s tolerant per-statement path in `src/db/database.ts`; keep it in its own file, never mixed with a `CREATE TRIGGER` body.
- `quests`, `activities`, `traces`, `questions` are projection tables owned by `src/intent/projections/quest.ts` and `activity.ts`, not by a migration — a new column goes into the projection's own `createSql` (fresh database) _and_ a migration's `ALTER TABLE` (existing database), exactly like `origin_kind` does in Task 1.
- Tests never call the network or the real `TEMPAD_HOME`; classifiers in tests are fakes implementing `Classifier`.
- Declarations are events (`quest.declared`), never a new mutable table — `currentDeclaredQuest` queries `events` directly, matching how `stateAsOf` treats the event log as the source of truth for anything time-travel-sensitive.

## Interfaces task 1 produces, consumed by tasks 2 and 3

- `packages/core/src/intent/declarations.ts`:
  - `declareQuest(store: EventStore, database: Database, input: DeclareQuestInput): { questId: string; created: boolean }` — appends `quest.created` (only when `input.new` is set, with `origin_kind: "declared"`, `confirmed: true`) then `quest.declared`; returns the resolved quest id and whether it was newly created.
  - `currentDeclaredQuest(database: Database, input: { sessionId: string; at: string }): DeclaredQuest | null`
  - `currentDeclaredQuestForSubagent(database: Database, input: { sessionId: string; parentSessionId: string; at: string }): DeclaredQuest | null`
  - `hasAnyDeclaration(database: Database, sessionId: string): boolean` — used by Task 2's inference-fallback decision (once per session, not per chunk).
  - `DeclaredQuest = { questId: string; title: string; objective: string | null; plan: string[]; scope: "session" | "subagent"; parentSessionId: string | null }` — `scope`/`parentSessionId` are what let Task 2 find a subagent's parent purely from the declaration event, with no schema or collector change.
  - `DeclareQuestInput`: see Task 1, Step 3 below for the exact shape (mirrors the CLI's parsed flags one-to-one).
- `EVENT_KINDS` (`src/intent/events.ts`) gains `"quest.declared"`, inserted after `"quest.returned"`.
- `quests` projection (`src/intent/projections/quest.ts`) gains column `origin_kind TEXT NOT NULL DEFAULT 'inferred'`; `quest.created`'s apply reads `payload.origin_kind ?? "inferred"`.
- `W5Config` (`src/intent/config.ts`) gains `mode: "declared" | "inferred"` (default `"declared"`) and `inferenceFallback: boolean` (default `true`), read from `[w5].mode` / `[w5].inference_fallback`.
- `tempad quest declare` (CLI) and `tempad skill install` gain the shapes in Task 1.
- `runContext`/`buildAdditionalContext` (`w5/cli.ts`, `w5/hooks.ts`) gain the declared-quest hook-context line, consumed unchanged by `w5-prompt.sh` (no shell script edit needed — it already forwards whatever `w5 context` prints).
- Task 2 does **not** touch `intent/declarations.ts`, `intent/events.ts`'s existing kinds, or `intent/cli.ts`'s `quest declare` branch — only reads `currentDeclaredQuest`/`currentDeclaredQuestForSubagent`/`hasAnyDeclaration` from `declarations.ts` and reads `intentConfig.mode`/`inferenceFallback`. It does add new functions to `w5/hooks.ts` (alongside, not instead of, Task 1's `buildDeclarationLine`) and a new migration `0009_verifier_questions.sql` — see Task 2's own Files list.
- Task 3 runs after Task 2 is merged (serial, not parallel — see Task 3's header) and depends on Task 2's `doubts`/`belongs`/`declare` additions; it does not touch `window.ts`, `prompt.ts`, `classifier.ts`, or `apply.ts` — only reads `currentDeclaredQuest` from `declarations.ts` and adds to `report/intent-queries.ts`, `report/daily.ts`, `report/project.ts`, `report/weekly.ts`, `w5/eval.ts`, `w5/cli.ts` (the `--declare` flag only).

---

## Task 1: declare-core

**Budget:** M. **Files:**

- Create: `packages/core/src/db/migrations/0008_declared_quests.sql`, `packages/core/src/intent/declarations.ts`, `packages/core/skills/tempad-quest/SKILL.md`
- Modify: `packages/core/src/db/schema.sql`, `packages/core/src/intent/events.ts`, `packages/core/src/intent/projections/quest.ts`, `packages/core/src/intent/config.ts`, `packages/core/src/intent/cli.ts`, `packages/core/src/w5/cli.ts`, `packages/core/src/w5/hooks.ts`, `packages/core/tempad.example.toml`, `CLAUDE.md`
- Test: `packages/core/test/intent/declarations.test.ts` (new), `packages/core/test/intent/cli.test.ts` (extend), `packages/core/test/intent/config.test.ts` (extend), `packages/core/test/intent/projections/quest.test.ts` (extend if it exists, else create), `packages/core/test/w5/hooks.test.ts` (extend), `packages/core/test/w5/cli.test.ts` (extend, for `w5 context`'s new line and `tempad skill install`)

**Interfaces:**

- Migration `0008_declared_quests.sql`:
  ```sql
  ALTER TABLE quests ADD COLUMN origin_kind TEXT NOT NULL DEFAULT 'inferred';
  ```
- `questProjection.createSql` (`src/intent/projections/quest.ts`) gains `origin_kind TEXT NOT NULL DEFAULT 'inferred'` on the `quests` table definition (after `commitment`, before `confirmed`, matching the migration's logical position).
- `quest.created` case in `questProjection.apply` — the `INSERT` gains `origin_kind` as a column, `payload.origin_kind ? String(payload.origin_kind) : "inferred"` as its bound value:
  ```ts
  case "quest.created": {
    const owner = payload.owner as { kind: string; id: string };
    database
      .query(
        `INSERT OR REPLACE INTO quests
          (id, owner_kind, owner_id, goal_id, title, objective, done_condition, due, budget_minutes, commitment, confirmed, origin_kind, revision, state, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'started', ?)`,
      )
      .run(
        event.subject,
        owner.kind,
        owner.id,
        payload.goal ? String(payload.goal) : null,
        String(payload.title),
        payload.objective ? String(payload.objective) : null,
        payload.done_condition ? String(payload.done_condition) : null,
        payload.due ? String(payload.due) : null,
        payload.budget_minutes !== undefined ? Number(payload.budget_minutes) : null,
        payload.commitment ? String(payload.commitment) : null,
        payload.confirmed === false ? 0 : 1,
        payload.origin_kind ? String(payload.origin_kind) : "inferred",
        event.at,
      );
    return;
  }
  ```
- `EVENT_KINDS` (`src/intent/events.ts`): insert `"quest.declared"` immediately after `"quest.returned"`.
- `schema.sql`'s trailing comment block (after the note on `0007_activity_lifecycle.sql`) gains one line: `-- Migration 0008_declared_quests.sql added origin_kind TEXT NOT NULL DEFAULT 'inferred' to quests.`
- `packages/core/src/intent/declarations.ts`:
  ```ts
  import type { Database } from "bun:sqlite";
  import type { Actor } from "./events";
  import { newUlid } from "./ids";
  import { applyIncremental } from "./projections";
  import type { EventStore } from "./store";

  export type Commitment = "promised" | "personal" | "exploratory";
  export type BranchKind = "waiting" | "blocker" | "curiosity" | "unknown";

  export interface NewQuestInput {
    title: string;
    objective: string;
    commitment: Commitment;
    project?: string;
    origin?: string;
    trigger?: string;
    kind?: BranchKind;
  }

  export interface DeclareQuestInput {
    sessionId: string;
    parentSessionId?: string;
    questId?: string;
    newQuest?: NewQuestInput;
    plan: string[];
    scope: "session" | "subagent";
    declaredBy: "agent" | "hero";
    at: string;
    heroId: string;
  }

  export interface DeclareQuestResult {
    questId: string;
    created: boolean;
  }

  export function declareQuest(
    store: EventStore,
    database: Database,
    input: DeclareQuestInput,
  ): DeclareQuestResult {
    let questId = input.questId ?? null;
    let created = false;

    if (questId === null && input.newQuest) {
      questId = newUlid();
      applyIncremental(
        database,
        store.append({
          actor: input.declaredBy === "hero" ? "hero" : "hook",
          kind: "quest.created",
          subject: questId,
          at: input.at,
          payload: {
            owner: { kind: "hero", id: input.heroId },
            title: input.newQuest.title,
            objective: input.newQuest.objective,
            commitment: input.newQuest.commitment,
            confirmed: true,
            origin_kind: "declared",
          },
        }),
      );
      created = true;
      if (input.newQuest.origin) {
        applyIncremental(
          database,
          store.append({
            actor: input.declaredBy === "hero" ? "hero" : "hook",
            kind: "quest.branched",
            subject: input.newQuest.origin,
            at: input.at,
            payload: {
              from_activity: questId,
              trigger: input.newQuest.trigger ?? "unknown",
              kind: input.newQuest.kind ?? "unknown",
            },
          }),
        );
      }
    }

    if (questId === null) {
      throw new Error("declareQuest: exactly one of questId or newQuest is required");
    }

    applyIncremental(
      database,
      store.append({
        actor: input.declaredBy === "hero" ? "hero" : "hook",
        kind: "quest.declared",
        subject: questId,
        at: input.at,
        sessionId: input.sessionId,
        payload: {
          session_id: input.sessionId,
          quest_id: questId,
          new: input.newQuest
            ? {
                title: input.newQuest.title,
                objective: input.newQuest.objective,
                commitment: input.newQuest.commitment,
                project: input.newQuest.project,
                origin: input.newQuest.origin,
                trigger: input.newQuest.trigger,
                kind: input.newQuest.kind,
              }
            : undefined,
          plan: input.plan,
          scope: input.scope,
          parent_session_id: input.parentSessionId,
          declared_by: input.declaredBy,
          at: input.at,
        },
      }),
    );

    return { questId, created };
  }

  export interface DeclaredQuest {
    questId: string;
    title: string;
    objective: string | null;
    plan: string[];
    scope: "session" | "subagent";
    parentSessionId: string | null;
  }

  function resolveDeclaration(
    database: Database,
    sessionId: string,
    scope: "session" | "subagent",
    at: string,
    parentSessionId?: string,
  ): DeclaredQuest | null {
    const rows = database
      .query(
        `SELECT payload FROM events
          WHERE kind = 'quest.declared' AND at <= ?
          ORDER BY at DESC, id DESC`,
      )
      .all(at) as { payload: string }[];

    for (const row of rows) {
      const payload = JSON.parse(row.payload) as {
        session_id: string;
        quest_id?: string;
        scope: string;
        parent_session_id?: string;
        plan: string[];
      };
      if (payload.scope !== scope) continue;
      if (scope === "session" && payload.session_id !== sessionId) continue;
      if (
        scope === "subagent" &&
        (payload.session_id !== sessionId || payload.parent_session_id !== parentSessionId)
      ) {
        continue;
      }

      const questId = payload.quest_id;
      if (!questId) continue;
      const quest = database
        .query("SELECT title, objective FROM quests WHERE id = ? AND retracted_at IS NULL")
        .get(questId) as { title: string; objective: string | null } | null;
      if (!quest) continue;
      return {
        questId,
        title: quest.title,
        objective: quest.objective,
        plan: payload.plan,
        scope: payload.scope as "session" | "subagent",
        parentSessionId: payload.parent_session_id ?? null,
      };
    }
    return null;
  }

  export function currentDeclaredQuest(
    database: Database,
    input: { sessionId: string; at: string },
  ): DeclaredQuest | null {
    return resolveDeclaration(database, input.sessionId, "session", input.at);
  }

  export function currentDeclaredQuestForSubagent(
    database: Database,
    input: { sessionId: string; parentSessionId: string; at: string },
  ): DeclaredQuest | null {
    return resolveDeclaration(
      database,
      input.sessionId,
      "subagent",
      input.at,
      input.parentSessionId,
    );
  }

  export function hasAnyDeclaration(database: Database, sessionId: string): boolean {
    const row = database
      .query(
        `SELECT 1 FROM events
          WHERE kind = 'quest.declared' AND json_extract(payload, '$.session_id') = ?
          LIMIT 1`,
      )
      .get(sessionId);
    return row !== null;
  }
  ```
  Note: `quest_id` in the payload is always the **resolved** quest id (the caller's `input.questId` when given, else the id `declareQuest` just created via `new`) — never the raw, possibly-absent `input.questId` — so `resolveDeclaration` always has something to read back regardless of which of `questId`/`newQuest` the caller passed.
- `W5Config` (`src/intent/config.ts`) gains `mode: "declared" | "inferred"` and `inferenceFallback: boolean`. `defaultIntentConfig()` sets `mode: "declared"`, `inferenceFallback: true`. `loadIntentConfig` gains a `boolean(key, fallback)` helper sibling to the existing `number()` helper (`typeof w5[key] === "boolean" ? (w5[key] as boolean) : fallback`) and a `parseMode(value, fallback)` helper (`value === "declared" || value === "inferred" ? value : fallback`, mirroring `parseBackend`); reads `mode` and `inference_fallback` from `[w5]`.
- `tempad.example.toml`'s `[w5]` block gains `mode = "declared"` and `inference_fallback = true`, placed after `overlap_messages` (the last key from the continuity plan).
- `CLAUDE.md`'s "w5 hook" section gains one paragraph after the "Backfill resilience" paragraph (matching the file's established style: bolded lead phrase, one paragraph, no bullets) explaining `[w5].mode`/`inference_fallback` and pointing at the new spec for the rest — do not repeat the spec's content, one or two sentences plus a reference, matching how the existing paragraphs cross-reference `docs/specs/`.
- `tempad quest declare` in `runQuestCommand` (`src/intent/cli.ts:403`), a new `if (subcommand === "declare")` branch inserted after the `"list"` branch and before the final `console.error("usage: ...")`:
  ```ts
  if (subcommand === "declare") {
    const { values } = parseArgs({
      args: rest,
      options: {
        session: { type: "string" },
        parent: { type: "string" },
        quest: { type: "string" },
        new: { type: "string" },
        objective: { type: "string" },
        commitment: { type: "string", default: "personal" },
        project: { type: "string" },
        origin: { type: "string" },
        trigger: { type: "string" },
        kind: { type: "string" },
        plan: { type: "string" },
        by: { type: "string", default: "agent" },
        at: { type: "string" },
      },
      strict: true,
    });

    const usage =
      'usage: tempad quest declare --session <id> [--parent <id>] (--quest <id> | --new "<title>" --objective "<text>" [--commitment promised|personal|exploratory] [--project <slug>] [--origin <quest id> --trigger "<sentence>" --kind waiting|blocker|curiosity|unknown]) [--plan "a; b; c"] [--by agent|hero] [--at <iso>]';

    if (!values.session) {
      console.error(usage);
      return 2;
    }
    if ((values.quest && values.new) || (!values.quest && !values.new)) {
      console.error(usage);
      return 2;
    }
    if (values.new && !values.objective) {
      console.error(usage);
      return 2;
    }
    if (values.origin && (!values.trigger || !values.kind)) {
      console.error(usage);
      return 2;
    }
    const heroRow = context.database.query("SELECT id FROM heroes LIMIT 1").get() as {
      id: string;
    } | null;
    if (!heroRow) {
      console.error("run `tempad hero init` first");
      return 1;
    }

    const plan = values.plan
      ? values.plan
          .split(";")
          .map((part) => part.trim())
          .filter((part) => part.length > 0)
      : [];

    const result = declareQuest(store, context.database, {
      sessionId: values.session,
      parentSessionId: values.parent,
      questId: values.quest,
      newQuest: values.new
        ? {
            title: values.new,
            objective: values.objective as string,
            commitment: (values.commitment as Commitment) ?? "personal",
            project: values.project,
            origin: values.origin,
            trigger: values.trigger,
            kind: values.kind as BranchKind | undefined,
          }
        : undefined,
      plan,
      scope: values.parent ? "subagent" : "session",
      declaredBy: values.by === "hero" ? "hero" : "agent",
      at: values.at ?? new Date().toISOString(),
      heroId: heroRow.id,
    });
    context.stdout(`declared ${result.questId}${result.created ? " (new)" : ""}`);
    return 0;
  }
  ```
  Add `import { declareQuest, type BranchKind, type Commitment } from "./declarations";` to `cli.ts`'s import block, and update the final usage line (`console.error("usage: tempad quest add|reword|...")`) to append `|declare`.
- `runContext` (`src/w5/cli.ts:132`) gains, before building `questions`/`text`:
  ```ts
  const declared = currentDeclaredQuest(context.database, {
    sessionId: values.session,
    at: new Date().toISOString(),
  });
  const declarationLine = buildDeclarationLine(declared, values.session);
  ```
  and the final assembly changes from `if (text.length > 0) context.stdout(text);` to joining `declarationLine` and the existing question `text` (both may be non-empty independently — declaration line always prints, question text only when there are asked questions):
  ```ts
  const parts = [declarationLine, text].filter((part) => part.length > 0);
  if (parts.length > 0) context.stdout(parts.join("\n"));
  ```
  Add `import { currentDeclaredQuest } from "../intent/declarations";` to `w5/cli.ts`.
- `buildDeclarationLine` in `w5/hooks.ts` (new export, sibling to `buildAdditionalContext`):
  ```ts
  export function buildDeclarationLine(
    declared: { title: string } | null,
    sessionId: string,
  ): string {
    const quest = declared ? declared.title : "none";
    return `tempad: session ${sessionId}, declared quest: ${quest}. Declare with the tempad-quest skill if this prompt starts a different objective.`;
  }
  ```
  `quest` is either the declared title or the literal string `"none"` — there is no other punctuation between it and the sentence that follows.
- `packages/core/skills/tempad-quest/SKILL.md`: a skill file following the existing Claude Code skill format (frontmatter `name`/`description`, then prose instructions) — content per the spec's "Skill: `tempad-quest`" section: declare at session start from the user's prompt; re-declare on objective change (`--origin` when it's a side quest); always declare with `--parent <session id>` inside a subagent before starting work; read the current declaration from the `UserPromptSubmit` hook context line rather than tracking it separately.
- `tempad skill install --scope user|project` — a new top-level CLI command (parallel to `tempad w5 hook install`), added to whatever dispatches top-level subcommands in `src/cli.ts` (read that file's existing dispatch table first; follow its exact pattern for adding a new top-level command name). Copies `packages/core/skills/tempad-quest/SKILL.md` to `~/.claude/skills/tempad-quest/SKILL.md` (`--scope user`, default) or `.claude/skills/tempad-quest/SKILL.md` (`--scope project`), creating parent directories as needed (`mkdirSync(..., { recursive: true })`, matching `w5/hooks.ts`'s `writeSettings` pattern).

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/test/intent/declarations.test.ts
import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db/database";
import { newUlid } from "../../src/intent/ids";
import { applyIncremental, ensureTables } from "../../src/intent/projections";
import { registerAllProjections } from "../../src/intent/projections/register";
import { EventStore } from "../../src/intent/store";
import {
  currentDeclaredQuest,
  currentDeclaredQuestForSubagent,
  declareQuest,
  hasAnyDeclaration,
} from "../../src/intent/declarations";

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
      objective: null,
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
      newQuest: { title: "New thing", objective: "do the new thing", commitment: "personal" },
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
      newQuest: { title: "First", objective: "a", commitment: "personal" },
      plan: [],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-07T09:00:00.000Z",
      heroId,
    });
    const second = declareQuest(store, database, {
      sessionId: "s1",
      newQuest: { title: "Second", objective: "b", commitment: "personal" },
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
      newQuest: { title: "Subtask", objective: "help", commitment: "personal" },
      plan: [],
      scope: "subagent",
      declaredBy: "agent",
      at: "2026-09-07T09:00:00.000Z",
      heroId,
    });

    expect(currentDeclaredQuest(database, { sessionId: "s1", at: "2026-09-07T09:05:00.000Z" })).toBeNull();
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
      newQuest: { title: "X", objective: "y", commitment: "personal" },
      plan: [],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-07T09:00:00.000Z",
      heroId,
    });
    expect(hasAnyDeclaration(database, "s1")).toBe(true);
  });
});
```

Extend `packages/core/test/intent/config.test.ts` with a case asserting `loadIntentConfig` reads `mode = "inferred"` and `inference_fallback = false` from a TOML fixture, and that `defaultIntentConfig().w5` has `mode: "declared", inferenceFallback: true`.

Add to `packages/core/test/intent/cli.test.ts` (extending its existing quest-command tests):

```ts
test("quest declare with --new creates and declares a quest, printed as 'declared <id> (new)'", () => {
  // seed a hero via the CLI's own hero init path (follow this file's existing setup helper)
  const exitCode = runIntentCommand(
    [
      "quest",
      "declare",
      "--session",
      "s1",
      "--new",
      "Ship the thing",
      "--objective",
      "get it out",
    ],
    context,
  );
  expect(exitCode).toBe(0);
  expect(stdoutLines.at(-1)).toMatch(/^declared .+ \(new\)$/);
});

test("quest declare requires exactly one of --quest or --new", () => {
  const exitCode = runIntentCommand(["quest", "declare", "--session", "s1"], context);
  expect(exitCode).toBe(2);
});

test("quest declare --origin requires --trigger and --kind", () => {
  const exitCode = runIntentCommand(
    [
      "quest",
      "declare",
      "--session",
      "s1",
      "--new",
      "Side thing",
      "--objective",
      "investigate",
      "--origin",
      "some-quest-id",
    ],
    context,
  );
  expect(exitCode).toBe(2);
});
```

(`runIntentCommand`/`stdoutLines`/`context` are this file's existing test harness names — adapt to whatever helper `cli.test.ts` already uses for other quest subcommands rather than inventing a new one.)

Add to `packages/core/test/w5/hooks.test.ts`:

```ts
test("buildDeclarationLine renders the quest title or 'none'", () => {
  expect(buildDeclarationLine({ title: "Ship X" }, "s1")).toBe(
    "tempad: session s1, declared quest: Ship X. Declare with the tempad-quest skill if this prompt starts a different objective.",
  );
  expect(buildDeclarationLine(null, "s1")).toBe(
    "tempad: session s1, declared quest: none. Declare with the tempad-quest skill if this prompt starts a different objective.",
  );
});
```

Add to `packages/core/test/w5/cli.test.ts` (extending the existing `w5 context` test):

```ts
test("w5 context prints the declaration line before any question lines", () => {
  // seed a declared quest for the session via declareQuest, then an asked question
  const output = runW5Context(["--session", "s1"], context); // adapt to this file's existing invocation helper
  const lines = output.split("\n");
  expect(lines[0]).toMatch(/^tempad: session s1, declared quest: /);
});
```

- [ ] **Step 2: Run to verify failure.** `cd packages/core && bun test test/intent/declarations.test.ts test/intent/cli.test.ts test/intent/config.test.ts test/w5/hooks.test.ts test/w5/cli.test.ts` → FAIL (module does not exist / subcommand unrecognized / fields missing).
- [ ] **Step 3: Implement** the migration, projection change, `declarations.ts`, config fields, the `quest declare` CLI branch, `runContext`'s declaration line, `tempad skill install`, the skill file, `tempad.example.toml`, and the `CLAUDE.md` paragraph.
- [ ] **Step 4: Run tests, typecheck, lint, dprint.** `bun test`, `bunx tsc --noEmit -p packages/core`, `bun run lint`, `dprint check` — all clean.
- [ ] **Step 5: Commit.** `git commit -m "feat(w5): quest declarations, origin_kind, and the tempad-quest skill"`

---

## Task 2: verifier

**Budget:** L. **Depends on:** Task 1 (merged). **Files:**

- Create: `packages/core/src/db/migrations/0009_verifier_questions.sql`
- Modify: `packages/core/src/w5/classifier.ts`, `packages/core/src/w5/prompt.ts`, `packages/core/src/w5/window.ts`, `packages/core/src/w5/apply.ts`, `packages/core/src/w5/runner.ts`, `packages/core/src/w5/backfill.ts`, `packages/core/src/w5/hooks.ts`, `packages/core/src/w5/cli.ts` (`runContext` only, to call the new hand-back renderers), `packages/core/src/intent/projections/activity.ts` (the `questions` table's `createSql`, for `guess TEXT`), `packages/core/src/intent/cli.ts` (`runAnswerCommand` only)
- Test: `packages/core/test/w5/classifier.test.ts`, `packages/core/test/w5/window.test.ts`, `packages/core/test/w5/apply.test.ts`, `packages/core/test/w5/runner.test.ts`, `packages/core/test/w5/backfill.test.ts`, `packages/core/test/w5/hooks.test.ts` (extend, for the new `buildBelongsHandback`/`buildDeclareHandback`), `packages/core/test/intent/cli.test.ts` (all extend existing files)

Task 2 does not touch `intent/declarations.ts` or `intent/events.ts` — it only imports `currentDeclaredQuest`/`currentDeclaredQuestForSubagent`/`hasAnyDeclaration` from Task 1's `declarations.ts` and reads `intentConfig.mode`/`inferenceFallback`. It does touch `w5/hooks.ts` (new hand-back renderers, below) and `w5/cli.ts`'s `runContext` (to call them) — Task 1 owns `buildDeclarationLine` and the declaration-line wiring in `runContext`; Task 2 adds new functions alongside it in the same file rather than editing what Task 1 wrote.

**Interfaces:**

- `ClassifierWindow` (`src/w5/classifier.ts`): `openQuests` and `recentSideQuests` are removed; gains `declaredQuest: { title: string; objective: string | null; plan: string[] } | null`, `parentDeclaredQuest: { title: string; objective: string | null; plan: string[] } | null`, `activityAliases: Record<string, string>` (alias -> real activity id). `sessionOpenActivities`/`recentActivities` keep their existing field names but `activityId` now holds the **alias** (`"A1"`, `"A2"`, …), not the real id — every reader of `activityId` on these two arrays (only `prompt.ts` and `apply.ts`'s `mostRecentOpen` seed) is updated to treat it as an alias.
- `ClassifierSegment`: `matchedQuest` and `proposedQuest` are removed; `belongs: boolean` and `guess: string | null` are added; `matchedActivity`/`continuesActivity` are now alias strings, not ids. `QuestionKind` becomes `"belongs" | "declare"`; `QUESTION_KINDS` updated to match. `Commitment` and `COMMITMENTS` are removed from `classifier.ts` (moved to `intent/declarations.ts` in Task 1 — `classifier.ts` no longer needs them since `proposedQuest` is gone); `apply.ts`/other files that imported `Commitment` from `classifier.ts` now import it from `intent/declarations.ts`.
- `validateSegment` (`classifier.ts`): the `matchedQuest`/`proposedQuest` blocks are deleted. New: `belongs` must be boolean; when `belongs === false`, `guess` must be a non-empty string (problem: `${where}.guess: expected a non-empty string when belongs is false`); when `belongs === true`, `guess` is forced to `null` if the model sent a string (repaired, not rejected — matching the selector-repair philosophy already in this function). The three-way selector check is unchanged in logic but validates `matchedActivity`/`continuesActivity` as keys of `window.activityAliases` when `window` is passed (an alias not in the map is treated as if it were `null` before the "exactly one" count, then re-defaulted by the existing selector-repair logic — this reuses `selectorDefaulted`/`selectorAmbiguous` counting rather than adding a third counter).
- `buildSystemPrompt()` (`prompt.ts`): rewritten to describe verifier mode — segment the window, judge whether each segment belongs to the declared quest (given below the fold), set `guess` only when it doesn't, and the unchanged three-way activity-selector rule (now phrased in terms of aliases `A1`, `A2`, …). No more mention of `matchedQuest`/`proposedQuest`/`questions`.
- `buildUserPrompt(window)` (`prompt.ts`): renders `declaredQuest`/`parentDeclaredQuest` (when set) as a leading section ("your declared quest: <title> — <objective>. plan: <plan.join("; ")>", or "your declared quest: none (ask to declare)" when null) before the activities sections; the "open quests"/"recent side quests" sections are deleted entirely; the "your open activities"/"recent activities" sections render the alias (`activity.activityId`, now an alias) instead of a real id — no other line-format change.
- `buildWindow` (`window.ts`): the `openQuests` and `recentSideQuests` queries are deleted. Parent linkage needs no schema or collector change: `parent_session_id` already lives on the `quest.declared` event payload itself (Task 1's `declarations.ts`), set by the skill, which tells a subagent to pass its parent's session id (learned from the parent's own hook-context line, in turn learned from the parent's own session id) into its own `--parent` flag when it declares. So `buildWindow` finds the session's parent, if any, the same way it finds everything else about a declaration: it calls `currentDeclaredQuest(database, { sessionId: input.sessionId, at: windowEnd })` first; if that declaration's `scope` is `"subagent"` (a new field the resolved `DeclaredQuest` carries — Task 1's `DeclaredQuest` gains `parentSessionId: string | null`, populated from the declaration event's own `parent_session_id`), `buildWindow` then calls `currentDeclaredQuestForSubagent(database, { sessionId: input.sessionId, parentSessionId: declaredQuest.parentSessionId, at: windowEnd })` to get `declaredQuest` proper and separately calls `currentDeclaredQuest(database, { sessionId: declaredQuest.parentSessionId, at: windowEnd })` for `parentDeclaredQuest`. A session with no declaration yet has no parent to look up either — `parentDeclaredQuest` is `null` until the first declaration arrives, exactly like `declaredQuest` itself. After building `sessionOpenActivities`/`recentActivities` with their existing queries (unchanged SQL), an alias pass assigns `A1..An` in list order (session activities first, then recent) and returns `activityAliases` as the reverse map; each row's `activityId` field in the returned arrays is replaced by its alias.
- `apply.ts`: `resolveQuest`, `createQuest`, `reuseActivity`'s quest-conflict/quest-proposed-on-matched logic, and `branchQuest`'s call site in the `isSwitch` block are all deleted. `resolveActivityForSegment` takes an additional `declaredQuestId: string | null` parameter and every branch (`matchedActivity`/`continuesActivity`/new) ends by calling `assignActivity`/`openActivityContinuing` with `quest: declaredQuestId ?? undefined` unconditionally — no per-segment quest decision remains. `applyResult` resolves `declaredQuestId` once per window (before the segment loop) via `currentDeclaredQuest`/`currentDeclaredQuestForSubagent` based on whether the window carries a `parentDeclaredQuest`; when `intentConfig.mode === "inferred"` OR (`intentConfig.mode === "declared"` AND `inferenceFallback` AND `!hasAnyDeclaration(database, window.sessionId)`), `applyResult` instead runs today's pre-verifier logic unchanged (this is why `resolveQuest`/`createQuest`/`branchQuest` are kept in the codebase, just no longer called from the declared-mode path — **do not delete them**, gate the two code paths behind `options.mode: "declared" | "inferred"` added to `ApplyOptions`, set by `runner.ts`/`backfill.ts` from `intentConfig.mode` and the per-session `hasAnyDeclaration` check). When declared mode has no declaration for the window's session at all yet (`currentDeclaredQuest` returns `null` and `hasAnyDeclaration` is `true` — meaning a declaration exists later in the session but not yet at this point in time, OR `inferenceFallback` is `false`), every segment's activity is opened/reused with `quest: undefined` (nullable, already valid) and exactly one `"declare"`-kind question is asked for the whole window (not per segment) via `askQuestion`. `AppliedSummary.questConflicts` is renamed `doubts`; a `belongs: false` segment increments it and calls `askQuestion` with `kind: "belongs"`, `text` set to the rendered hand-back sentence (a new `renderBelongsHandback(declaredTitle: string, guess: string, questionId: string)` helper in `apply.ts`, called after the question id is known — actually two-phase: `askQuestion` returns the id, so `text` must be set via a follow-up event or the id is generated before calling `askQuestion`; simplest: generate the question id with `newUlid()` in `apply.ts` before calling a lower-level append, OR accept that `text` cannot embed the question's own id and instead have `runContext`'s hand-back rendering (Task 1's `w5/hooks.ts`, extended in this task) build the full sentence at read time from the question row's `kind`/a stored `guess` field — **this task adds `guess TEXT` to the `questions` table** (`ALTER TABLE questions ADD COLUMN guess TEXT` in a migration `0009_verifier_questions.sql`, plus the projection's `createSql`) and `buildAdditionalContext`/a new `buildBelongsHandback`/`buildDeclareHandback` in `w5/hooks.ts` render the exact hand-back text from `kind`+`guess`+the declared quest's title (looked up at render time via the question's `session_id` and `currentDeclaredQuest`), so `apply.ts` only ever needs to call `askQuestion` with a plain internal `text` value that is never shown to the user (existing `AskQuestionInput.text` becomes informational/debug only for `belongs`/`declare` kinds — the display text is always rendered fresh in `w5/hooks.ts`, which already recomputes text server-side rather than trusting a stored rendering, consistent with `buildAdditionalContext` never reading `text` for its output today either, since it currently only reads `question.id`/`question.kind`).
- `runner.ts`: reads `intentConfig.mode` and `hasAnyDeclaration` (only for a non-subagent session with `intentConfig.mode === "declared"`) to compute the `ApplyOptions.mode`/effective-inference flag once, before calling `buildWindow`, and passes `parentSessionId` through to `buildWindow` when applicable (see the `buildWindow` note above about deferring true subagent-window support if no collector column exists — if deferred, `runner.ts` simply never passes `parentSessionId`, and `parentDeclaredQuest` is always `null` for now, which is forward-compatible).
- `backfill.ts`: the same `hasAnyDeclaration`-per-session gate as `runner.ts`, computed once per session (not per chunk) before the chunk loop, exactly where the file's existing `sessionPending`/`sessionSuccesses` per-session bookkeeping already lives; `BackfillResult.questConflicts` renamed `doubts`.
- `runAnswerCommand` (`intent/cli.ts:846`) gains a `belongs: { type: "boolean", default: false }` option; the usage/validation becomes "exactly one of `--belongs` or `--quest`"; the `--belongs` branch appends `question.answered` with `payload: { answeredBy: actor, belongs: true, why: values.why }` and returns 0 without touching the trace/activity; the existing `--quest` branch (trace relink + optional quest creation) is unchanged except its usage string now mentions `--belongs` as the alternative, and gains the optional `--origin current --trigger ... --kind ...` handling described in the spec (only meaningful together with `--quest new:"..."`, validated the same way `quest declare`'s `--origin` is in Task 1).

- [ ] **Step 1: Write the failing tests**

  - `classifier.test.ts`: rewrite the `good` fixture to the new segment shape (`belongs`, `guess`, alias-based `matchedActivity`); add cases: `validateResult` rejects `belongs: false` with `guess: null`; repairs `belongs: true` with a non-null `guess` back to `null`; rejects an alias not present in `window.activityAliases`. Delete every `matchedQuest`/`proposedQuest` assertion.
  - `window.test.ts`: assert `sessionOpenActivities`/`recentActivities` return aliases (`"A1"`, `"A2"`, …) in `activityAliases` and in each row's `activityId`; assert `declaredQuest` is populated from a seeded `quest.declared` event at the window's reference time; assert `openQuests`/`recentSideQuests` are gone from the returned shape (a TypeScript-level check via the interface, plus a runtime check that the object has no such keys).
  - `apply.test.ts`: replace every `matchedQuest`/`proposedQuest` case with: a segment `belongs: false` → `askQuestion` fires with `kind: "belongs"`, `summary.doubts === 1`, the activity's quest is still the session's declared quest (never reassigned); a segment `belongs: true` on a declared session → activity gets the declared quest, no question; a session with `hasAnyDeclaration() === false` and `inferenceFallback: true` → old-style `matchedQuest`/`proposedQuest` fields (fixture switches shape per test) drive quest resolution exactly as before this plan; a session with `hasAnyDeclaration() === false` and `inferenceFallback: false` → activity's `quest_id` is `null` and exactly one `"declare"` question is asked for the whole window regardless of segment count.
  - `runner.test.ts`/`backfill.test.ts`: extend the fake classifier to the new segment shape; add a case per file asserting the `doubts` field name (not `questConflicts`) appears in the result/summary.
  - `intent/cli.test.ts`: add cases for `tempad answer --belongs --why "..."` (no relink, `question.answered` with `belongs: true`) and the existing `--quest` path still working unchanged.

- [ ] **Step 2: Run to verify failure.** All suites fail against the new interfaces.
- [ ] **Step 3: Implement** per Interfaces, in order: `classifier.ts` schema/validation, `prompt.ts`, `window.ts` (including the alias pass), `apply.ts` (including the `questions.guess` migration), `runner.ts`, `backfill.ts`, `intent/cli.ts`'s `--belongs` option.
- [ ] **Step 4: Gates clean.** `bun test`, `bunx tsc --noEmit -p packages/core`, `bun run lint`, `dprint check`.
- [ ] **Step 5: Commit.** `git commit -m "feat(w5): verifier mode — belongs/declare questions, activity aliases, inference fallback"`

---

## Task 3: declared-eval

**Budget:** M. **Depends on:** Task 2 (merged) — serial, not parallel. `EvalMetrics.doubts`/`doubtsAnswered` and `BackfillResult.doubts` (the rename from `questConflicts`) only exist once Task 2 lands; `--declare`'s fixtures exercise the `belongs`/`declare` question kinds Task 2 introduces. Running Task 3 before Task 2 would mean building against a `doubts` field, a `belongs` question kind, and a `ClassifierSegment` shape none of which exist yet. **Files:**

- Modify: `packages/core/src/w5/eval.ts`, `packages/core/src/w5/cli.ts` (`w5 eval`'s `--declare` flag only), `packages/core/src/report/intent-queries.ts`, `packages/core/src/report/daily.ts` (the quest-title `origin_kind` suffix, at the `groupByQuest`/`unconfirmed` line — see below), `packages/core/src/report/weekly.ts` (the `doubts` column)
- Test: `packages/core/test/w5/eval.test.ts` (extend), `packages/core/test/report/intent-queries.test.ts` (extend if it exists, else create), `packages/core/test/report/daily.test.ts` (extend), `packages/core/test/report/weekly.test.ts` (extend)

**Interfaces:**

- `EvalOptions` (`eval.ts`) gains `declareFile?: string`. `runEval`, immediately after `copyDatabase` and opening the copy, when `declareFile` is set: reads it (`Bun.TOML.parse` for `.toml`, `JSON.parse` for `.json`, chosen by file extension) as `{ session_id: string; at: string; quest?: string; new?: { title: string; objective: string; commitment: string; project?: string } }[]`, and for each entry calls `declareQuest` (imported from `intent/declarations.ts`) against the copy, using a hero id resolved once via the copy's own `heroes` table (if the copy has no hero row — an eval database built from a fixture with no `hero.created` event — `runEval` seeds one first via a plain `hero.created` append, matching how other eval fixtures already need a hero for quest ownership).
- `EvalMetrics` (`eval.ts`): `questConflicts` renamed `doubts`; gains `doubtsAnswered: number` (`SELECT COUNT(*) FROM questions WHERE kind IN ('belongs','declare') AND state IN ('resolved_by_context','answered') AND ...` scoped to the range the same way other metrics are, via a join to `traces`/`activities` on `opened_at`/`started_at` in `[from, to)`) and `tracesUnattributed: number` (`SELECT COUNT(*) FROM traces JOIN activities ON activities.id = traces.activity_id WHERE traces.retracted_at IS NULL AND activities.quest_id IS NULL AND traces.started_at >= ? AND traces.started_at < ?`).
- `w5/cli.ts`'s `w5 eval` argument parsing gains `--declare` (`{ type: "string" }`), passed through as `EvalOptions.declareFile`.
- `report/intent-queries.ts`:
  - `ActivityRow` gains `questOriginKind: string | null`; `queryActivities` (`intent-queries.ts:249`) selects `quests.origin_kind as questOriginKind` alongside the existing quest columns (left-joined, so `null` when the activity has no quest).
  - `QuestSummaryRow` (used by `queryQuests`, `intent-queries.ts:380`) gains `originKind: string`; the query selects `quests.origin_kind as originKind`.
  - New function `attributeNonClaudeEvidence(database: Database, range: DateRange): { id: string; kind: "commit" | "monday_item"; questId: string | null; questTitle: string | null }[]`: for commits, joins `gh_commits` (`authored_at` in range) to `gh_repos` (`org`, `project`) to `claude_sessions` (`org`/`project` match, `started_at <= authored_at AND ended_at >= authored_at`, picking `MAX(started_at)` on ties), then calls `currentDeclaredQuest(database, { sessionId, at: authored_at })`; for Monday items, the same shape using `monday_items`' own `org`/`project`/`updated_at`. Returns `questId: null, questTitle: null` for a commit/item with no overlapping session or no declaration at that timestamp — never invents an attribution. Doc-commented as a heuristic ("latest-started session wins on overlap") per the spec.
  - A new `querySideQuestDoubts(database: Database, range: DateRange): number` — `SELECT COUNT(*) FROM questions WHERE kind = 'belongs' AND ...` scoped to the range via the same trace/session join pattern `queryTraceIntervals` already uses.
- ``report/daily.ts``'s ``render`` function, the "Quests" section (``daily.ts:144-148``): ``groupByQuest`` (``daily.ts:243-247``, groups ``ActivityRow[]`` by ``questTitle``) already yields ``questActivities[0]?.questConfirmed === false`` as the ``unconfirmed`` suffix on line 145; the same line gains a sibling ``const inferred = questActivities[0]?.questOriginKind && questActivities[0].questOriginKind !== "declared" ? " (inferred)" : "";``, and line 148's template gains ``${inferred}`` immediately after ``${unconfirmed}``: `` `- ${questTitle}${unconfirmed}${inferred}: ${objectives} (${minutesLabel(minutes)})` ``. ``report/project.ts:118`` (``quest.confirmed ? quest.title : \``${quest.title} [unconfirmed]\`\`) gets the equivalent: `quest.originKind !== "declared" ? \`${base} (inferred)\` : base``wrapping the existing confirmed/unconfirmed expression as``base`.
- `report/weekly.ts`: `HEADERS` (`weekly.ts:75-84`) gains `"doubts"` as a new element after `"side-quest minutes"`; `DayProjectStats` (`weekly.ts:28-36`) gains `doubts: number`; `emptyStats`/`addStats`/`statsRow` (`weekly.ts:38-73`) each gain the matching field/line, mirroring exactly how `unconfirmedQuests` is threaded through all three; inside `render`'s per-key `stats` object (`weekly.ts:139-158`), `doubts` is computed the same way `sideQuests`/`unconfirmedQuests` already are — filtered by `org`/`project` from a new `querySideQuestDoubts`-sourced array fetched once per day alongside `activities`/`quests`/`sideQuests` (`weekly.ts:106-108`).

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/test/w5/eval.test.ts — extend the existing describe block
test("--declare applies declarations to the copy before rerunning, producing doubts/doubtsAnswered/tracesUnattributed", () => {
  const dir = mkdtempSync(join(tmpdir(), "tempad-eval-"));
  const sourcePath = join(dir, "source.db");
  seedSourceDb(sourcePath); // existing helper in this file
  const declareFile = join(dir, "declare.json");
  writeFileSync(
    declareFile,
    JSON.stringify([
      {
        session_id: "s1",
        at: "2026-09-01T09:00:00.000Z",
        new: { title: "Ship p", objective: "ship it", commitment: "personal" },
      },
    ]),
  );

  return runEval({
    from: "2026-09-01",
    to: "2026-09-02",
    sourceDbPath: sourcePath,
    scratchDir: dir,
    now: "2026-09-02T00:00:00.000Z",
    classifier: new FakeClassifier(), // existing fixture classifier in this file
    log: () => {},
    declareFile,
  }).then((metrics) => {
    expect(metrics.doubts).toBeDefined();
    expect(metrics.doubtsAnswered).toBe(0);
    expect(metrics.tracesUnattributed).toBe(0);
  });
});
```

Assert `backfill.test.ts`'s existing case reads `doubts` (already renamed by Task 2, merged before this task starts).

```ts
// packages/core/test/report/intent-queries.test.ts (create if it doesn't exist, following this directory's existing fixture-database pattern)
test("attributeNonClaudeEvidence attributes a commit to the declaring session active at authored_at, and leaves an unmatched commit unattributed", () => {
  // seed: a claude_session for org/project p, started_at..ended_at bracketing a commit's authored_at,
  // a quest.declared event for that session at a time <= authored_at,
  // one gh_commits row inside the bracket and one gh_commits row with no overlapping session
  const rows = attributeNonClaudeEvidence(database, { from: "...", to: "...", timeZone: "UTC" });
  expect(rows.find((r) => r.id === "in-range-sha")?.questTitle).toBe("Ship p");
  expect(rows.find((r) => r.id === "no-session-sha")?.questId).toBeNull();
});
```

```ts
// packages/core/test/report/daily.test.ts — extend the existing "Quests" section fixture
test("a quest line gets an (inferred) suffix when its origin_kind is not declared", () => {
  // seed one activity on a quest with origin_kind: "inferred" and one on origin_kind: "declared"
  const output = renderDaily(database, config, options); // this file's existing render-and-return helper
  expect(output).toContain("Ship p (inferred): ");
  expect(output).not.toContain("Ship q (inferred)");
});
```

```ts
// packages/core/test/report/weekly.test.ts — extend the existing table-fixture test
test("the weekly table gains a doubts column sourced from belongs questions in range", () => {
  // seed one 'belongs' question tied to a trace/session in the org/project under test
  const output = renderWeekly(database, config, options); // this file's existing render-and-return helper
  expect(output).toContain("doubts");
  const row = output.split("\n").find((line) => line.includes("acme/p"));
  expect(row).toContain("| 1 |"); // one doubt for that project's row
});
```

- [ ] **Step 2: Run to verify failure.** All new/extended suites FAIL.
- [ ] **Step 3: Implement** `--declare` on `runEval`, the renamed/new `EvalMetrics` fields, `attributeNonClaudeEvidence`, `querySideQuestDoubts`, the `origin_kind`/`doubts` rendering in `daily.ts`/`project.ts`/`weekly.ts`, and `cli.ts`'s `--declare` flag.
- [ ] **Step 4: Gates clean.**
- [ ] **Step 5: Commit.** `git commit -m "feat(w5): eval --declare, non-Claude attribution, doubts reporting"`

---

## Self-review

- Spec coverage: declarations/CLI/skill/hook-line/`origin_kind` → Task 1; verifier prompt/schema, alias scheme, `belongs`/`declare` questions, `apply.ts` gating, inference fallback → Task 2; non-Claude attribution, `w5 eval --declare` and its new metrics, report rendering of `origin_kind`/doubts → Task 3.
- Every file path referenced exists on `main` as read for this plan (`w5/classifier.ts`, `apply.ts`, `window.ts`, `prompt.ts`, `runner.ts`, `backfill.ts`, `eval.ts`, `hooks.ts`, `cli.ts` (both `w5/cli.ts` and `intent/cli.ts`), `intent/events.ts`, `api.ts`, `config.ts`, `projections/quest.ts`, `projections/activity.ts`, `db/schema.sql`, `report/intent-queries.ts`, `report/daily.ts`, `report/project.ts`, `report/weekly.ts`) or is created by the task introducing it (`0008_declared_quests.sql`, `0009_verifier_questions.sql`, `intent/declarations.ts`, `skills/tempad-quest/SKILL.md`, their test files).
- Sequencing, not parallelism: Task 1 → Task 2 → Task 3, strictly serial. Task 1 owns every file Task 2 and Task 3 only ever _read_ (`declarations.ts`, `events.ts`, `config.ts`'s new fields, `quest.ts`'s `origin_kind`) — neither later task edits those files again. Task 2 owns `window.ts`, `prompt.ts`, `classifier.ts`, `apply.ts`, `runner.ts`, `backfill.ts`'s classify-path changes, `w5/hooks.ts`'s new hand-back renderers, `w5/cli.ts`'s `runContext`, and `intent/cli.ts`'s `--belongs` addition. Task 3 depends on Task 2's `doubts`/`belongs`/`declare` additions and owns `eval.ts`, `report/intent-queries.ts`, `report/daily.ts`, `report/project.ts`, `report/weekly.ts`, and `w5/cli.ts`'s `--declare` flag (a different function than Task 2's `runContext` change, in the same file — safe because Task 3 starts only after Task 2 is merged, not concurrently).
- No placeholders: every task names exact function signatures, exact SQL/queries, and exact test assertions, with each interface's tests written first and the interface code itself already correct.
