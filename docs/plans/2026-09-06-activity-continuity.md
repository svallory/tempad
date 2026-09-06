# Activity Continuity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an activity mean one contiguous stretch of attention: activities close (idle, switch, session end), returning to an objective after a gap opens a new activity with `continues`, and the classifier gets a recent-context slice instead of one trace so it can actually match. Add `tempad w5 eval` to measure the activities/traces ratio against real history without touching the real database.

**Architecture:** Task 1 lands the schema and pure lifecycle functions the other two tasks depend on: a migration, config keys, and `src/w5/lifecycle.ts` wired into `runner.ts`/`backfill.ts`. Task 2 (depends on 1) rewrites the classifier's window/prompt/schema/apply chain to use the new lifecycle primitives and slice data. Task 3 (depends on 1 only) adds `force` to backfill and the `w5 eval` command; it needs the schema and config from task 1 but not task 2's classifier changes, so it can run in parallel with task 2 once task 1 merges.

**Tech Stack:** Bun 1.3, `bun:sqlite`, TypeScript strict, `bun test`. No new runtime dependencies.

**Spec:** `docs/specs/2026-09-06-activity-continuity-design.md`. Builds on `docs/specs/2026-09-05-intent-model-and-w5-hook-design.md` and `docs/plans/2026-09-05-w5-hook.md` (read for existing conventions: `EventStore`, `applyIncremental`, `Projection`, `ClassifierWindow`/`ClassifierResult`, `W5Config`).

## Global Constraints

- Same as the w5-hook plan: bun only, full-word identifiers, no `any`, no non-null assertions, commits `type(w5): summary`, one per task.
- Migration files that are pure `ALTER TABLE ... ADD COLUMN` statements get the tolerant per-statement path in `src/db/database.ts` (`runMigration`); keep new ALTERs in their own migration file, never mixed with a `CREATE TRIGGER` body, so that tolerance still applies.
- `activities`, `traces`, `quests`, `questions` are projection tables owned by `src/intent/projections/activity.ts` and `quest.ts`, not by a migration — a new column on one of those tables goes into the projection's own `createSql` (for a fresh database) _and_ into a migration's `ALTER TABLE ... ADD COLUMN` (for an existing database), exactly like `retracted_at` did in `0006_retractions.sql`.
- Tests never call the network or the real `TEMPAD_HOME`; classifiers in tests are fakes implementing `Classifier`.

## Interfaces task 1 produces, consumed by tasks 2 and 3

- `packages/core/src/w5/lifecycle.ts`:
  - `closeIdleActivities(store, database, input: { sessionId: string; windowStartedAt: string; idleMinutes: number; now: string }): { closed: string[] }` — closes every open activity of the session whose last live trace's `ended_at` is more than `idleMinutes` before `windowStartedAt`, with `reason: "idle"`, `closed_at` = that trace's `ended_at`.
  - `closeActivityOnSwitch(store, database, input: { activityId: string; closedAt: string }): void` — appends `activity.closed` with `reason: "switch"`.
  - `closeSessionActivities(store, database, input: { sessionId: string; now: string }): { closed: string[] }` — closes every still-open activity of the session with `reason: "session_end"`, `closed_at` = each activity's last live trace's `ended_at` (or `now` if it has no trace), and clears `w5_runs.session_note` for that session.
  - `openActivityContinuing(store, database, input: { quest?: string; objective: string; at: string; actor: Actor; continues?: string }): string` — same shape as `openActivity` in `src/intent/api.ts` plus `continues`, appending `activity.opened` with `continues` in the payload when given. Task 2's `apply.ts` calls this instead of `openActivity` directly whenever a `continuesActivity` candidate is present.
- `activities` projection (`src/intent/projections/activity.ts`) gains columns `continues TEXT` and reads/writes `reason` inside `activity.closed`'s existing `outcome` handling (see Task 1 below for the exact SQL).
- `w5_runs` gains `session_note TEXT`.
- `W5Config` (`src/intent/config.ts`) gains `activityIdleMinutes`, `memoryHours`, `memoryActivities`, `overlapMessages`, all read from `[w5]` in `tempad.toml` with the defaults in the spec's "Config changes" table.
- `EVENT_KINDS` (`src/intent/events.ts`) needs no new kind — `activity.opened`/`activity.closed` are reused with new payload fields, which is backward compatible since projections read fields by name.
- `w5_jobs.kind` becomes reachable end to end: `packages/core/hooks/w5-stop.sh` forwards `hook_event_name` as `--kind`, `enqueueJob` (`src/w5/jobs.ts`) accepts and stores it, `runEnqueue` (`src/w5/cli.ts`) parses `--kind` and passes it through, and `Job.kind` carries the real value instead of always `"classify"`. Task 2 only reads `job.kind === "session_end"` in `runner.ts`; it does not touch `jobs.ts`, `cli.ts`, or the hook script.

---

## Task 1: activity-lifecycle

**Budget:** M. **Files:**

- Create: `packages/core/src/db/migrations/0007_activity_lifecycle.sql`, `packages/core/src/w5/lifecycle.ts`
- Modify: `packages/core/src/db/schema.sql`, `packages/core/src/intent/projections/activity.ts`, `packages/core/src/intent/config.ts`, `packages/core/tempad.example.toml`, `CLAUDE.md`, `packages/core/src/w5/jobs.ts`, `packages/core/src/w5/cli.ts`, `packages/core/hooks/w5-stop.sh`
- Test: `packages/core/test/w5/lifecycle.test.ts`, `packages/core/test/intent/config.test.ts` (extend if it exists, else create), `packages/core/test/intent/projections/activity.test.ts` (extend if it exists), `packages/core/test/w5/jobs.test.ts` (extend), `packages/core/test/w5/hooks.test.ts` (extend)

**Interfaces:**

- Migration `0007_activity_lifecycle.sql`:
  ```sql
  ALTER TABLE activities ADD COLUMN continues TEXT;
  ALTER TABLE activities ADD COLUMN close_reason TEXT;
  ALTER TABLE w5_runs ADD COLUMN session_note TEXT;
  ```
  All three are pure `ALTER TABLE ... ADD COLUMN`, so `runMigration`'s tolerant path applies unchanged.
- `activityProjection.createSql` (`src/intent/projections/activity.ts`) gains `continues TEXT` and `close_reason TEXT` on the `activities` table definition (so a fresh database has them without the migration).
- `activity.closed` case in `activityProjection.apply` becomes:
  ```ts
  case "activity.closed":
    database
      .query("UPDATE activities SET closed_at = ?, outcome = ?, close_reason = ? WHERE id = ?")
      .run(
        event.at,
        payload.outcome ? String(payload.outcome) : null,
        payload.reason ? String(payload.reason) : null,
        event.subject,
      );
    return;
  ```
- `activity.opened` case gains `continues`:
  ```ts
  case "activity.opened":
    database
      .query(
        "INSERT OR REPLACE INTO activities (id, quest_id, objective, opened_at, revision, continues) VALUES (?, ?, ?, ?, 1, ?)",
      )
      .run(
        event.subject,
        payload.quest ? String(payload.quest) : null,
        String(payload.objective),
        event.at,
        payload.continues ? String(payload.continues) : null,
      );
    return;
  ```
- `w5_runs` DDL (`packages/core/src/db/schema.sql`, and wherever `w5_runs` is created in migration `0005_w5.sql`'s mirrored copy in `schema.sql`) gains `session_note TEXT`; `schema.sql`'s job is a snapshot mirror per the existing convention at the bottom of that file (see the comment block already there for `retracted_at`) — add a matching comment line noting `close_reason`, `continues`, and `session_note` were added by `0007_activity_lifecycle.sql`.
- `packages/core/src/w5/lifecycle.ts`:
  ```ts
  import type { Database } from "bun:sqlite";
  import type { Actor } from "../intent/events";
  import { newUlid } from "../intent/ids";
  import { applyIncremental } from "../intent/projections";
  import type { EventStore } from "../intent/store";

  export interface CloseIdleActivitiesInput {
    sessionId: string;
    windowStartedAt: string;
    idleMinutes: number;
    now: string;
  }

  export function closeIdleActivities(
    store: EventStore,
    database: Database,
    input: CloseIdleActivitiesInput,
  ): { closed: string[] } {
    const rows = database
      .query(
        `SELECT activities.id as id,
                (SELECT MAX(traces.ended_at) FROM traces
                   WHERE traces.activity_id = activities.id AND traces.retracted_at IS NULL) as lastEndedAt
           FROM activities
           JOIN traces ON traces.activity_id = activities.id AND traces.retracted_at IS NULL
          WHERE traces.session_id = ?
            AND activities.closed_at IS NULL
            AND activities.retracted_at IS NULL
          GROUP BY activities.id`,
      )
      .all(input.sessionId) as { id: string; lastEndedAt: string | null }[];

    const closed: string[] = [];
    for (const row of rows) {
      if (!row.lastEndedAt) continue;
      const idleMinutesElapsed =
        (Date.parse(input.windowStartedAt) - Date.parse(row.lastEndedAt)) / 60_000;
      if (idleMinutesElapsed <= input.idleMinutes) continue;
      applyIncremental(
        database,
        store.append({
          actor: "system",
          kind: "activity.closed",
          subject: row.id,
          at: row.lastEndedAt,
          payload: { reason: "idle" },
        }),
      );
      closed.push(row.id);
    }
    return { closed };
  }

  export function closeActivityOnSwitch(
    store: EventStore,
    database: Database,
    input: { activityId: string; closedAt: string },
  ): void {
    applyIncremental(
      database,
      store.append({
        actor: "hook",
        kind: "activity.closed",
        subject: input.activityId,
        at: input.closedAt,
        payload: { reason: "switch" },
      }),
    );
  }

  export function closeSessionActivities(
    store: EventStore,
    database: Database,
    input: { sessionId: string; now: string },
  ): { closed: string[] } {
    const rows = database
      .query(
        `SELECT activities.id as id,
                (SELECT MAX(traces.ended_at) FROM traces
                   WHERE traces.activity_id = activities.id AND traces.retracted_at IS NULL) as lastEndedAt
           FROM activities
           JOIN traces ON traces.activity_id = activities.id AND traces.retracted_at IS NULL
          WHERE traces.session_id = ?
            AND activities.closed_at IS NULL
            AND activities.retracted_at IS NULL
          GROUP BY activities.id`,
      )
      .all(input.sessionId) as { id: string; lastEndedAt: string | null }[];

    const closed: string[] = [];
    for (const row of rows) {
      applyIncremental(
        database,
        store.append({
          actor: "hook",
          kind: "activity.closed",
          subject: row.id,
          at: row.lastEndedAt ?? input.now,
          payload: { reason: "session_end" },
        }),
      );
      closed.push(row.id);
    }
    database
      .query("UPDATE w5_runs SET session_note = NULL WHERE session_id = ?")
      .run(input.sessionId);
    return { closed };
  }

  export interface OpenActivityContinuingInput {
    quest?: string;
    objective: string;
    at: string;
    actor: Actor;
    continues?: string;
  }

  export function openActivityContinuing(
    store: EventStore,
    database: Database,
    input: OpenActivityContinuingInput,
  ): string {
    const id = newUlid();
    applyIncremental(
      database,
      store.append({
        actor: input.actor,
        kind: "activity.opened",
        subject: id,
        at: input.at,
        payload: { quest: input.quest, objective: input.objective, continues: input.continues },
      }),
    );
    return id;
  }
  ```
- `W5Config` (`src/intent/config.ts`) gains `activityIdleMinutes: number; memoryHours: number; memoryActivities: number; overlapMessages: number`; `defaultIntentConfig()` sets `45, 8, 10, 3`; `loadIntentConfig` reads `activity_idle_minutes`, `memory_hours`, `memory_activities`, `overlap_messages` via the existing `number(key, fallback)` helper.
- `tempad.example.toml`'s `[w5]` block gains the four keys with their defaults, in the same order as the interface fields, right after `timeout_seconds`.
- `CLAUDE.md`'s "w5 hook" section gains one paragraph (after the "Retractions" paragraph) documenting `activity.closed`'s `reason` field and the four config keys, matching the style of the existing "Retractions" / "`tempad w5 dedupe`" paragraphs (one paragraph, bolded lead phrase, no bullet list).
- `runner.ts`'s `runOnce` calls `closeIdleActivities(store, database, { sessionId: job.sessionId, windowStartedAt: <window's first message ts, or `now` if the window is empty>, idleMinutes: intentConfig.activityIdleMinutes, now })` right after `buildWindow` and before `classifier.classify`, so idle closes happen before the classifier reads the "open activities" slice. Task 1 wires `job.kind` end to end (below); task 2 is the one that reads it in `runner.ts` to call `closeSessionActivities` on a `"session_end"` job — task 1 does not call `closeSessionActivities` from `runOnce` itself, only makes `job.kind` correct.
- `backfill.ts`'s per-chunk loop calls `closeIdleActivities` with `windowStartedAt` = the chunk's `startedAt`, before `classifier.classify(chunkWindow)`.

### Job kind wiring (hook → enqueue → job → runner)

The `SessionEnd` lifecycle behavior in task 2 depends on `w5_jobs.kind` actually carrying `"session_end"` for a job enqueued by the `SessionEnd` hook. Today it cannot: `w5-stop.sh` parses `hook_event_name` only to decide `--forced`, never forwards it; `runEnqueue` in `cli.ts` has no `--kind` option; `enqueueJob`'s `INSERT` hardcodes `'classify'`. Task 1 fixes all three so task 2 only has to read `job.kind`.

- `packages/core/hooks/w5-stop.sh`: replace the `if [ "$hook_event_name" != "Stop" ]` block with one that maps the hook event to a `--kind` value and always passes `--forced` for anything other than `Stop`:
  ```sh
  case "$hook_event_name" in
    Stop) kind="classify" ;;
    SessionEnd) kind="session_end" ;;
    *) kind="classify" ;;
  esac

  if [ "$hook_event_name" != "Stop" ]; then
    "${_bin[@]}" w5 enqueue --session "$session_id" --forced --kind "$kind" || true
  else
    "${_bin[@]}" w5 enqueue --session "$session_id" --kind "$kind" || true
  fi
  ```
- `EnqueueJobInput` (`src/w5/jobs.ts`) gains `kind?: string` (default `"classify"` when omitted). `enqueueJob`'s `INSERT` uses `input.kind ?? "classify"` instead of the literal `'classify'`. The duplicate-upgrade path (an existing queued job for the session gets `forced` flipped to 1) also upgrades `kind` to the new request's kind when it differs, with the same `UPDATE` statement extended to set `kind = ?`. `Job.kind` (already a field on the `Job` interface, currently always `"classify"` in practice) now reflects the stored value; `claimNextJob`'s `SELECT *` already returns it, no change needed there.
- `runEnqueue` (`src/w5/cli.ts`) gains a `kind` string option (`parseArgs` `options: { session: ..., forced: ..., kind: { type: "string" } }`) and passes `kind: values.kind` through to `enqueueJob`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/test/w5/lifecycle.test.ts
import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db/database";
import { newUlid } from "../../src/intent/ids";
import { applyIncremental, ensureTables } from "../../src/intent/projections";
import { registerAllProjections } from "../../src/intent/projections/register";
import { EventStore } from "../../src/intent/store";
import {
  closeActivityOnSwitch,
  closeIdleActivities,
  closeSessionActivities,
  openActivityContinuing,
} from "../../src/w5/lifecycle";

registerAllProjections();

function seedActivityWithTrace(
  database: ReturnType<typeof openDatabase>,
  store: EventStore,
  input: { activityId: string; sessionId: string; endedAt: string },
) {
  database
    .query(
      "INSERT INTO activities (id, quest_id, objective, opened_at, revision) VALUES (?, NULL, 'work', '2026-09-06T09:00:00.000Z', 1)",
    )
    .run(input.activityId);
  database
    .query(
      `INSERT INTO traces (id, activity_id, tool, place, source, started_at, ended_at, who, what, why, where_text, how, confidence, classified_by, session_id, recorded_at)
       VALUES (?, ?, 'claude-code', 'p', 'session', '2026-09-06T09:00:00.000Z', ?, 'hero', 'work', 'ship', 'org/p', 'claude-code', 0.9, 'assistant', ?, '2026-09-06T09:00:00.000Z')`,
    )
    .run(newUlid(), input.activityId, input.endedAt, input.sessionId);
}

describe("lifecycle", () => {
  test("closeIdleActivities closes only activities idle past the threshold", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    seedActivityWithTrace(database, store, {
      activityId: "A-old",
      sessionId: "s1",
      endedAt: "2026-09-06T09:10:00.000Z",
    });
    seedActivityWithTrace(database, store, {
      activityId: "A-recent",
      sessionId: "s1",
      endedAt: "2026-09-06T09:55:00.000Z",
    });

    const result = closeIdleActivities(store, database, {
      sessionId: "s1",
      windowStartedAt: "2026-09-06T10:00:00.000Z",
      idleMinutes: 45,
      now: "2026-09-06T10:00:00.000Z",
    });

    expect(result.closed).toEqual(["A-old"]);
    const rows = database
      .query("SELECT id, closed_at, close_reason FROM activities ORDER BY id")
      .all() as { id: string; closed_at: string | null; close_reason: string | null }[];
    expect(rows.find((r) => r.id === "A-old")).toEqual({
      id: "A-old",
      closed_at: "2026-09-06T09:10:00.000Z",
      close_reason: "idle",
    });
    expect(rows.find((r) => r.id === "A-recent")?.closed_at).toBeNull();
  });

  test("closeActivityOnSwitch closes with reason switch at the given time", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    seedActivityWithTrace(database, store, {
      activityId: "A1",
      sessionId: "s1",
      endedAt: "2026-09-06T09:10:00.000Z",
    });

    closeActivityOnSwitch(store, database, { activityId: "A1", closedAt: "2026-09-06T09:12:00.000Z" });

    const row = database
      .query("SELECT closed_at, close_reason FROM activities WHERE id = 'A1'")
      .get() as { closed_at: string; close_reason: string };
    expect(row).toEqual({ closed_at: "2026-09-06T09:12:00.000Z", close_reason: "switch" });
  });

  test("closeSessionActivities closes every open activity of the session and clears the note", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    seedActivityWithTrace(database, store, {
      activityId: "A1",
      sessionId: "s1",
      endedAt: "2026-09-06T09:10:00.000Z",
    });
    seedActivityWithTrace(database, store, {
      activityId: "A2",
      sessionId: "s1",
      endedAt: "2026-09-06T09:20:00.000Z",
    });
    database
      .query(
        "INSERT INTO w5_runs (session_id, last_run_at, session_note) VALUES ('s1', '2026-09-06T09:20:00.000Z', 'heading toward X')",
      )
      .run();

    const result = closeSessionActivities(store, database, { sessionId: "s1", now: "2026-09-06T09:30:00.000Z" });

    expect(result.closed.sort()).toEqual(["A1", "A2"]);
    const reasons = database.query("SELECT close_reason FROM activities").all() as {
      close_reason: string;
    }[];
    expect(reasons.every((r) => r.close_reason === "session_end")).toBe(true);
    const note = database.query("SELECT session_note FROM w5_runs WHERE session_id = 's1'").get() as {
      session_note: string | null;
    };
    expect(note.session_note).toBeNull();
  });

  test("openActivityContinuing stores the continues link", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);

    const id = openActivityContinuing(store, database, {
      objective: "back to walk order",
      at: "2026-09-06T12:00:00.000Z",
      actor: "hook",
      continues: "A-old",
    });

    const row = database.query("SELECT continues FROM activities WHERE id = ?").get(id) as {
      continues: string | null;
    };
    expect(row.continues).toBe("A-old");
  });
});
```

Extend `packages/core/test/intent/config.test.ts` (or create it following the pattern of other `intent` tests) with a case asserting `loadIntentConfig` reads `activity_idle_minutes`, `memory_hours`, `memory_activities`, `overlap_messages` from a TOML fixture string and that `defaultIntentConfig().w5` has `activityIdleMinutes: 45, memoryHours: 8, memoryActivities: 10, overlapMessages: 3`.

Add to `packages/core/test/w5/jobs.test.ts` (extending the existing `describe("w5 jobs", ...)` block):

```ts
test("enqueueJob stores kind, defaulting to classify, and upgrades kind on duplicate", () => {
  const database = openDatabase(":memory:");
  enqueueJob(database, { sessionId: "s3", forced: false, now: "2026-09-06T10:00:00.000Z", throttleMinutes: 10 });
  expect((database.query("SELECT kind FROM w5_jobs WHERE session_id = 's3'").get() as { kind: string }).kind).toBe(
    "classify",
  );

  enqueueJob(database, {
    sessionId: "s3",
    forced: true,
    kind: "session_end",
    now: "2026-09-06T10:01:00.000Z",
    throttleMinutes: 10,
  });
  const row = database.query("SELECT kind, forced FROM w5_jobs WHERE session_id = 's3'").get() as {
    kind: string;
    forced: number;
  };
  expect(row).toEqual({ kind: "session_end", forced: 1 });

  const job = claimNextJob(database, "2026-09-06T10:02:00.000Z");
  expect(job?.kind).toBe("session_end");
});
```

Add to `packages/core/test/w5/hooks.test.ts` (extending the existing hook-script test that spawns `w5-stop.sh` with a fake `tempad` on `PATH`):

```ts
test("w5-stop.sh forwards SessionEnd as --kind session_end and Stop as --kind classify", async () => {
  // reuse this file's existing spawnHook helper against the two hook_event_name payloads
  const stopArgv = await spawnHookAndCaptureArgv({ session_id: "s1", hook_event_name: "Stop" });
  expect(stopArgv).toEqual(["w5", "enqueue", "--session", "s1", "--kind", "classify"]);

  const sessionEndArgv = await spawnHookAndCaptureArgv({ session_id: "s1", hook_event_name: "SessionEnd" });
  expect(sessionEndArgv).toEqual([
    "w5",
    "enqueue",
    "--session",
    "s1",
    "--forced",
    "--kind",
    "session_end",
  ]);
});
```

(`spawnHookAndCaptureArgv` is the existing helper in that file that runs `w5-stop.sh` via `Bun.spawn` with a fake `tempad` script recording its argv — adapt the exact helper name/shape already present in `hooks.test.ts` rather than introducing a second one.)

- [ ] **Step 2: Run to verify failure.** `cd packages/core && bun test test/w5/lifecycle.test.ts test/w5/jobs.test.ts test/w5/hooks.test.ts` → FAIL (module does not exist / kind not forwarded).
- [ ] **Step 3: Implement** the migration, projection changes, `lifecycle.ts`, config fields, `tempad.example.toml`, `CLAUDE.md` paragraph, the `runner.ts`/`backfill.ts` call sites described above, and the job-kind wiring (`jobs.ts`, `cli.ts`'s `runEnqueue`, `hooks/w5-stop.sh`).
- [ ] **Step 4: Run tests, typecheck, lint, dprint.** `bun test`, `bunx tsc --noEmit -p packages/core`, `bun run lint`, `dprint check` — all clean.
- [ ] **Step 5: Commit.** `git commit -m "feat(w5): activity lifecycle — idle, switch, and session-end closes, continues links"`

---

## Task 2: classifier-memory

**Budget:** L. **Depends on:** Task 1 (merged). **Files:**

- Modify: `packages/core/src/w5/window.ts`, `packages/core/src/w5/prompt.ts`, `packages/core/src/w5/classifier.ts`, `packages/core/src/w5/classifier-shared.ts`, `packages/core/src/w5/apply.ts`, `packages/core/src/w5/runner.ts`, `packages/core/src/w5/jobs.ts` (`completeJob` signature only — `kind` plumbing is task 1's)
- Test: `packages/core/test/w5/window.test.ts`, `packages/core/test/w5/classifier.test.ts`, `packages/core/test/w5/apply.test.ts`, `packages/core/test/w5/runner.test.ts`, `packages/core/test/w5/jobs.test.ts` (all extend existing files)

Task 2 does not touch `packages/core/src/w5/cli.ts` at all — no new command, no changed flag — so it shares no file with Task 3, which owns `cli.ts` and its own new `eval.ts` module.

**Interfaces:**

- `ClassifierWindow` (`src/w5/classifier.ts`) replaces `previousTrace: { activityId, what, questId } | null` with:
  ```ts
  sessionOpenActivities: {
    activityId: string; what: string; why: string; questId: string | null; questTitle: string | null;
    openedAt: string; lastTraceEndedAt: string;
  }[];
  recentActivities: {
    activityId: string; what: string; why: string; questId: string | null; questTitle: string | null;
    openedAt: string; lastTraceEndedAt: string; closedAt: string | null; closeReason: string | null;
  }[];
  recentSideQuests: { id: string; title: string; trigger: string }[];
  overlapMessages: { ts: string; role: string; text: string }[];
  previousSessionNote: string | null;
  ```
  `openQuests` is unchanged. Callers that used `previousTrace` (`apply.ts`) are updated in this task — there is no compatibility shim, since task 2 owns every caller.
- `buildWindow(database, input: { sessionId: string; sinceTs: string | null; maxMessages: number; memoryHours: number; memoryActivities: number; overlapMessages: number })`: adds the four queries below to the existing session/messages/openQuests query. `input` grows the three new numeric fields (no default inside `window.ts`; callers pass `intentConfig.w5.*`).
  - `sessionOpenActivities`: `activities` joined to its latest live trace and to `quests`, `WHERE traces.session_id = ? AND activities.closed_at IS NULL AND activities.retracted_at IS NULL`.
  - `recentActivities`: same join, `WHERE (activities.opened_at >= ? OR activities.closed_at >= ?) AND traces.session_id != ? AND place LIKE ? ORDER BY COALESCE(activities.closed_at, activities.opened_at) DESC LIMIT ?` — the cutoff is `now - memoryHours` hours (computed from `sinceTs ?? session.started_at`... actually from the window's reference time, which `buildWindow`'s caller passes as `input.sinceTs` when set, else the session's own `started_at`), the project filter matches the session's `org/project` against `traces.place`, and the cap is `memoryActivities`.
  - `recentSideQuests`: `quests WHERE origin_activity_id IS NOT NULL AND retracted_at IS NULL ORDER BY branched_at DESC LIMIT 3`, scoped to quests reachable by the same `org` (owner party matches session org, or owner is hero), joined to fetch `trigger`.
  - `overlapMessages`: the `overlapMessages` (config value, distinct name collision with the field — call the config parameter `overlapMessageCount` inside `window.ts` to avoid shadowing) messages immediately before `sinceTs` (or before the cut when `sinceTs` is null), same table/shape as `messages`.
  - `previousSessionNote`: `SELECT session_note FROM w5_runs WHERE session_id = ?`.
- `buildSystemPrompt()` (`src/w5/prompt.ts`) states: reusing an existing activity is the default; opening a new one needs `newActivityReason`; exactly one of `matchedActivity`/`continuesActivity`/`newActivityReason` must be set per segment; the overlap section is context only and must not be classified; `sessionNote` is a top-level field on the response, at most 300 characters. `buildUserPrompt(window)` renders four new sections in this order after "previous trace" is removed: "your open activities this session", "recent activities in this project" (with closed/close reason), "recent side quests", "context only — do not classify" (the overlap messages), and appends "your note from the previous run: <text>" when `previousSessionNote` is non-null, before the "messages" section.
- `ClassifierSegment` gains `continuesActivity: string | null` and `newActivityReason: string | null`, alongside the existing `matchedActivity: string | null`. `ClassifierResult` gains a top-level `sessionNote: string | null`.
- `validateResult(raw, window?)` (`src/w5/classifier.ts`) adds: for each segment, exactly one of `matchedActivity`, `continuesActivity`, `newActivityReason` must be non-null (problem message names all three field names so the existing test regex style — matching two problem substrings — keeps working); `continuesActivity`, when set, must be a string; `sessionNote` must be `null` or a string of at most 300 characters (problem: `sessionNote: expected null or a string of at most 300 characters`).
- `apply.ts`'s `resolveActivityForSegment` is replaced by a function that takes the three-way candidate and returns which path was taken:
  ```ts
  function resolveActivityForSegment(
    store: EventStore,
    database: Database,
    heroId: string,
    segment: ClassifierSegment,
    now: string,
  ): {
    activityId: string;
    questId: string | null;
    activityOpened: boolean;
    questCreated: boolean;
    questConflict: boolean;
  }
  ```
  Rules: `matchedActivity` set → reuse it; if its stored `quest_id` differs from `segment.matchedQuest`, set `questConflict: true` and keep the activity's existing `questId` (never reassign). `continuesActivity` set → resolve/create the quest exactly as today's "open" path does, then call `openActivityContinuing(..., continues: segment.continuesActivity)` instead of `openActivity`. `newActivityReason` set (or none of the three — validation guarantees exactly one, so this branch is unreachable but kept as a safety default matching today's behavior) → resolve/create the quest, call `openActivityContinuing(..., continues: undefined)`.
- `applyResult` additionally: before the segment loop, drops any segment whose `startedAt`/`endedAt` both fall within `[window.overlapMessages[0].ts, window.overlapMessages.at(-1).ts]` when `window.overlapMessages.length > 0` (log-free skip, just `continue`); tracks `previous` per _session_ using `window.sessionOpenActivities` seeded state instead of the removed `window.previousTrace` (the segment loop's existing `previous` variable now initializes from the most-recently-opened entry of `sessionOpenActivities`, or `null`); calls `closeActivityOnSwitch(store, database, { activityId: previous.activityId, closedAt: segment.startedAt })` whenever `segment.isSwitch` is true and `previous !== null` and the resolved activity for this segment differs from `previous.activityId`; adds `questConflict` to `AppliedSummary` (`AppliedSummary` gains `questConflicts: number`) and logs one line per conflict via a new required `options.log: (line: string) => void` (added to `ApplyOptions`, mirroring `RunOnceOptions.log`); returns `sessionNote` pass-through is not `apply`'s job — `runner.ts` reads `result.sessionNote` directly.
- `runner.ts`'s `runOnce`: after `buildWindow`, calls `closeIdleActivities` (task 1) before `classifier.classify`; after `applyResult`, writes `result.sessionNote` (task 2's `ClassifierResult.sessionNote`) to `w5_runs.session_note` in the same `completeJob` call — `completeJob`'s signature (`src/w5/jobs.ts`, currently `completeJob(database, id, lastMessageTs, now?)`) gains `sessionNote` appended as the **last** parameter, after `now`: `completeJob(database, id, lastMessageTs, now, sessionNote?)` — the existing optional `now` keeps its position so the one existing call site in `runner.ts` (positional, currently `completeJob(database, job.id, lastMessage?.ts ?? sinceTs, now)`) still type-checks unchanged for callers that don't pass a note, and the four existing calls in `test/w5/jobs.test.ts` are unaffected since none of them pass a 4th argument. `runOnce` reads `job.kind` (wired end to end by task 1 — see "Job kind wiring" under Task 1) and, when it equals `"session_end"`, calls `closeSessionActivities` after `applyResult` instead of leaving activities open; task 2 adds no new kind value and no hook/CLI/jobs-table plumbing, only this one read.

- [ ] **Step 1: Write the failing tests**

  - `window.test.ts`: extend the existing fixture with a second, closed activity from an earlier session in the same project (`recentActivities` includes it with `closeReason`), a side quest with a `trigger`, and messages before the `sinceTs` cut (asserting they show up in `overlapMessages`, not `messages`); assert `sessionOpenActivities` picks up an activity from the _current_ session that is still open.
  - `classifier.test.ts`: extend `good` fixture segments to set exactly one of the three candidate fields each; add a case asserting `validateResult` rejects a segment with both `matchedActivity` and `continuesActivity` set, and one with all three null; add a case asserting a `sessionNote` over 300 characters is rejected; extend `buildUserPrompt` assertions to check the new section headings appear and the overlap section is labeled "do not classify".
  - `apply.test.ts`: add a case where `matchedActivity` is set but the stored quest differs from `matchedQuest` — asserts the activity's `quest_id` is unchanged and `summary.questConflicts === 1`; add a case with `continuesActivity` set — asserts the new activity's `continues` column equals the closed activity's id and its quest matches the closed activity's quest by default; add a case where two consecutive segments both set `isSwitch: true` against different resolved activities — asserts `closeActivityOnSwitch` fired (activity's `closed_at`/`close_reason` set) for the first segment's activity at the second segment's `startedAt`; add a case where a segment's timestamps fall inside `window.overlapMessages`'s ts range — asserts no trace is recorded for it.
  - `runner.test.ts`: extend the fake classifier to return `sessionNote`, assert it lands in `w5_runs.session_note` after `runOnce`; add a case with a job of `kind: "session_end"` asserting every open activity of the session is closed with `reason: "session_end"` after the run and `session_note` is cleared.

- [ ] **Step 2: Run to verify failure.** All four suites fail against the new interfaces.
- [ ] **Step 3: Implement** per Interfaces, in order: `classifier.ts` schema/validation, `prompt.ts`, `window.ts`, `apply.ts`, `jobs.ts`'s `completeJob` signature extension, `runner.ts`.
- [ ] **Step 4: Gates clean.** `bun test`, `bunx tsc --noEmit -p packages/core`, `bun run lint`, `dprint check`.
- [ ] **Step 5: Commit.** `git commit -m "feat(w5): classifier memory slice, three-way activity matching, session notes"`

---

## Task 3: continuity-eval

**Budget:** M. **Depends on:** Task 1 (merged) only — does not need Task 2's classifier changes; the `force` flag and metrics work against `ClassifierWindow`/`ClassifierResult` shapes already present after Task 1 merges (a fake classifier stands in for the real one either way, exactly as `backfill.test.ts` does today). **Files:**

- Create: `packages/core/src/w5/eval.ts`
- Modify: `packages/core/src/w5/backfill.ts` (`force` option), `packages/core/src/w5/cli.ts` (`w5 eval` and `--force` on `w5 backfill`)
- Test: `packages/core/test/w5/eval.test.ts`, extend `packages/core/test/w5/backfill.test.ts`

**Interfaces:**

- `BackfillOptions` (`src/w5/backfill.ts`) gains `force?: boolean` (default `false`). `isWindowCovered` is called as `options.force ? false : isWindowCovered(...)` inside the `pendingChunks` filter, so a forced run treats every chunk as pending regardless of `w5_windows` or legacy trace coverage.
- `packages/core/src/w5/eval.ts`:
  ```ts
  export interface EvalOptions {
    from: string;
    to: string;
    sourceDbPath: string;
    scratchDir: string;
    now: string;
    classifier: Classifier;
    log: (line: string) => void;
  }

  export interface EvalMetrics {
    copiedDbPath: string;
    traces: number;
    activities: number;
    ratio: number;
    medianActivityDurationMinutes: number;
    continuesLinks: number;
    questConflicts: number;
    sample: {
      what: string; why: string; questTitle: string | null; durationMinutes: number | null; sessionTitle: string | null;
    }[];
  }

  export async function runEval(options: EvalOptions): Promise<EvalMetrics>;
  ```
  `runEval`: copies the file at `sourceDbPath` to `<scratchDir>/eval-<now-as-filename-safe-timestamp>.db` with `Bun.write(dest, Bun.file(sourceDbPath))` (never opens `sourceDbPath` for writing); opens the copy with `openDatabase`; calls `backfill(copiedDatabase, <minimal Config>, intentConfigDefaults, options.classifier, { days: <computed from from/to>, now: options.now, log: options.log, force: true })` — actually calls a new `backfillRange` wrapper, OR (simpler, chosen here) computes `days` as the whole-day span from `options.from` to `options.to` and reuses `backfill`'s existing `ended_at >= cutoff` semantics with `cutoff = options.from` and an added upper bound; since `backfill`'s session query has no upper bound today, this task adds one: `backfill`'s `BackfillOptions` gains an optional `to?: string` (defaults to no upper bound, preserving current callers), and the session query becomes `WHERE ended_at >= ? AND ended_at <= ? ORDER BY ended_at ASC` when `to` is set. `runEval` passes `to: options.to`.
  After backfill, computes metrics directly against the copied database: `traces` = `SELECT COUNT(*) FROM traces WHERE retracted_at IS NULL`; `activities` = `SELECT COUNT(*) FROM activities WHERE retracted_at IS NULL`; `ratio = activities / traces` (0 when `traces === 0`); `medianActivityDurationMinutes` from `SELECT opened_at, closed_at FROM activities WHERE closed_at IS NOT NULL AND retracted_at IS NULL`, sorted durations, standard median (average of the two middle values on an even count); `continuesLinks` = `SELECT COUNT(*) FROM activities WHERE continues IS NOT NULL`; `questConflicts` summed from the `AppliedSummary[]` `backfill` (extended to return per-window summaries, or — simpler and chosen here — `backfill`'s `BackfillResult` gains a `questConflicts: number` field, summed internally the same way `windowsClassified` already is); `sample` = 20 rows via `ORDER BY RANDOM() LIMIT 20` joined to their quest title and session title through `traces.session_id` → `claude_sessions.title`.
- `cli.ts`: `runBackfill` gains `--force` (boolean flag) plumbed to `backfill`'s new `force` option. A new `runEval` CLI handler parses `--from`, `--to`, `--db` (optional, defaults to `context.config.home/tempad.db`), builds a classifier via the existing `buildClassifier`, calls `eval.ts`'s `runEval` with `scratchDir = join(context.config.home, "scratch")`, and prints the metrics block: one line per scalar metric, then one line per sampled activity. Dispatched from `runW5Command` as `if (subcommand === "eval") return runEval(rest, context);`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/test/w5/eval.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/db/database";
import { ensureTables } from "../../src/intent/projections";
import { registerAllProjections } from "../../src/intent/projections/register";
import type { Classifier, ClassifierResult, ClassifierWindow } from "../../src/w5/classifier";
import { runEval } from "../../src/w5/eval";

registerAllProjections();

class FakeClassifier implements Classifier {
  async classify(window: ClassifierWindow): Promise<ClassifierResult> {
    const first = window.messages[0]?.ts ?? "2026-09-01T10:00:00.000Z";
    const last = window.messages.at(-1)?.ts ?? first;
    return {
      segments: [
        {
          startedAt: first,
          endedAt: last,
          what: "work",
          why: "ship",
          matchedQuest: null,
          proposedQuest: null,
          matchedActivity: null,
          continuesActivity: null,
          newActivityReason: "no prior activity",
          isSwitch: false,
          trigger: null,
          confidence: 0.9,
          questions: [],
        },
      ],
      sessionNote: null,
    };
  }
}

function seedSourceDb(path: string): void {
  const database = openDatabase(path);
  ensureTables(database);
  database
    .query(
      `INSERT INTO claude_sessions (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch, started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
       VALUES ('s1', '/c', 'p', '/c/p/s1.jsonl', '/w/p', 'personal', 'p', 'p session', 'main', '2026-09-01T10:00:00.000Z', '2026-09-01T10:30:00.000Z', 1, 0, '[]', 'host', '2026-09-01T10:30:00.000Z')`,
    )
    .run();
  database
    .query(
      `INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview)
       VALUES ('m1', 's1', '2026-09-01T10:00:00.000Z', 'user', 0, 'do the thing')`,
    )
    .run();
  database.close();
}

describe("w5 eval", () => {
  test("copies the source db, force-reclassifies the range, and reports metrics without touching the source", () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-eval-"));
    const sourcePath = join(dir, "source.db");
    seedSourceDb(sourcePath);
    const sourceMtimeBefore = Bun.file(sourcePath).lastModified;

    return runEval({
      from: "2026-09-01",
      to: "2026-09-02",
      sourceDbPath: sourcePath,
      scratchDir: dir,
      now: "2026-09-02T00:00:00.000Z",
      classifier: new FakeClassifier(),
      log: () => {},
    }).then((metrics) => {
      expect(metrics.traces).toBe(1);
      expect(metrics.activities).toBe(1);
      expect(metrics.ratio).toBe(1);
      expect(metrics.copiedDbPath).not.toBe(sourcePath);
      expect(Bun.file(sourcePath).lastModified).toBe(sourceMtimeBefore);
    });
  });
});
```

Extend `backfill.test.ts` with a case: run `backfill` once, then run it again with `force: true` and assert `windowsClassified` on the second run is not zero (proving `force` bypasses the `w5_windows` coverage check that would otherwise report the session as skipped).

- [ ] **Step 2: Run to verify failure.** Both new/extended tests FAIL.
- [ ] **Step 3: Implement** `force`/`to` on `backfill`, `BackfillResult.questConflicts`, `eval.ts`, and the `cli.ts` wiring (`--force` flag, `w5 eval` subcommand).
- [ ] **Step 4: Gates clean.**
- [ ] **Step 5: Commit.** `git commit -m "feat(w5): backfill force flag and w5 eval command"`

---

## Self-review

- Spec coverage: activity lifecycle (idle/switch/session_end/continues) → Task 1; config keys → Task 1; classifier memory slice, prompt/schema changes, three-way matching, quest conflict, overlap drop, session note → Task 2; evaluation command → Task 3.
- Every file path referenced (`src/w5/window.ts`, `prompt.ts`, `apply.ts`, `runner.ts`, `backfill.ts`, `classifier.ts`, `classifier-shared.ts`, `jobs.ts`, `src/intent/events.ts`, `api.ts`, `config.ts`, `projections/activity.ts`, `projections/quest.ts`, `projections/window.ts`, `db/migrations/0006_retractions.sql`, `db/schema.sql`, `test/w5/*.test.ts`) exists on `main` as read for this plan, or is created by the task that introduces it (`0007_activity_lifecycle.sql`, `lifecycle.ts`, `eval.ts`, their test files).
- Parallelism: Task 1 owns all job-kind wiring (`jobs.ts`'s `kind` field/parameter, `cli.ts`'s `runEnqueue --kind`, `hooks/w5-stop.sh`), so neither Task 2 nor Task 3 needs to touch the hook script or `runEnqueue`. Task 2 touches `window.ts`, `prompt.ts`, `classifier.ts`, `classifier-shared.ts`, `apply.ts`, `runner.ts`, and `jobs.ts` (only `completeJob`'s signature — a pure addition at the end of the parameter list). Task 3 touches `backfill.ts`, its own new `eval.ts`, and `cli.ts` (a new `w5 eval` subcommand and a `--force` flag on `w5 backfill`). No file is modified by both Task 2 and Task 3 — Task 2 never touches `cli.ts`, Task 3 never touches `jobs.ts` — so the two worktrees merge without conflict once Task 1 is in both bases.
- No placeholders: every task names exact function signatures, exact SQL, and exact test assertions rather than "add tests" or "similar to task N".
