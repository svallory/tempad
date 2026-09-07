# Stints: minimum duration, active quests, plan grain

> Vocabulary renamed on 2026-09-07, see `docs/specs/2026-09-07-ubiquitous-language.md`.

Status: not started. Date: 2026-09-07. Extends `docs/specs/2026-09-07-declared-quests-design.md` (declarations, `origin_kind`, the verifier's `belongs`/`declare` questions, activity aliases, `w5 eval --declare`) — read it first; this spec does not repeat its event catalog or verifier mechanics, only what changes on top of a codebase that already has declared mode, the alias scheme, and `apply.ts`'s declared-mode path.

## Principle

The declared-quests eval on 2026-09-02 fixed quest identity — every stint now sits under the right quest by construction — but exposed the next problem: 179 of 228 human stints had exactly one trace (ratio 0.53, median stint duration 1.3 minutes). The verifier treats every maneuver (read the brief, restructure a component, check on a dev) as its own stint, because nothing in the domain or the prompt distinguishes a maneuver from a stint, a session can only ever have one active quest, and the plan a declaration carries (`DeclareQuestInput.plan`) is written to the event but never read by anything.

This spec closes three gaps, decided by the operator on 2026-09-07:

1. **Stint boundary**, defined once and quoted verbatim everywhere it matters, plus a minimum duration below which a stint is a maneuver folded into its quest's time rather than its own line.
2. **A session accumulates declarations** instead of the latest one silently winning — a lead running two quests in one session, or handing a quest off with `--done`, needs both quests visible to the verifier at once.
3. **The plan defines the grain.** A declaration's `--plan` becomes the list of stints (outcomes) the verifier is asked to place segments against, not a list of maneuvers — this is what stops the model from inventing a new stint for every small thing.

Out of scope: changing how time is summed (still trace minutes, per `docs/specs/2026-09-06-activity-continuity-design.md`), a UI, retroactively re-deriving stint boundaries for history already backfilled before this ships (a later `w5 eval --declare` run with plans, as already exercised for 2026-09-02, is how existing sessions get evaluated against the new rule).

## Stint boundary

Verbatim, in the README, the `tempad-quest` skill, and the verifier's system prompt (`buildDeclaredSystemPrompt`, `packages/core/src/w5/prompt.ts`):

> A stint is a stretch of the user's attention pursuing one quest. It starts when you begin pursuing an outcome and ends when that outcome is delivered, abandoned or handed off, or after an idle gap. Stints interleave. It lasts at least `stint_min_minutes` (default 5); shorter stretches are maneuvers, and their time is counted under the quest without a stint.

Three tests, also verbatim, used by the skill to instruct the executor and by the verifier prompt to instruct the model:

- **The report test**: would it be its own line in a standup or timesheet?
- **The same-answer test**: while it lasts, the answer to "what am I trying to finish" does not change.
- **The handoff test**: when the outcome leaves your hands, it is over; waiting is not a stint, checking on someone is a maneuver of the stint that handed off.

This text already exists almost verbatim in the ubiquitous-language glossary's Stint entry and in `buildDeclaredSystemPrompt`'s line `"A stint is one outcome pursued over a span; several may be open at once, so match the one the segment belongs to."` — this spec adds the minimum-duration sentence and the three named tests, which are new.

## Minimum duration

### Config

`W5Config` (`packages/core/src/intent/config.ts`) gains `stintMinMinutes: number`, default `5`, read from `[w5].stint_min_minutes`. `defaultIntentConfig()`'s `w5` object gets the field; `loadIntentConfig`'s existing `number()` helper reads it, same pattern as `stintIdleMinutes`.

### `stint.dismissed` event and projection column

A stint still opens provisionally exactly as today (`openStintContinuing`, `packages/core/src/w5/lifecycle.ts`) — the minimum is enforced at close time, not at open time, because a stint's total trace-minutes are only known once no more traces are landing on it.

`EVENT_KINDS` (`packages/core/src/intent/events.ts`) gains `"stint.dismissed"`, inserted immediately after `"stint.closed"` (payload group order: the file already groups `stint.*` together). Payload:

```ts
{ reason: "below minimum" }
```

`stints` (`packages/core/src/intent/projections/stint.ts`) gains a column `dismissed_at TEXT` on the `stints` table (`createSql`, after `close_reason`). A new `case "stint.dismissed":` in `stintProjection.apply` runs `UPDATE stints SET dismissed_at = ? WHERE id = ?` with `event.at`, `event.subject`. A migration `0012_stint_minimum.sql`:

```sql
ALTER TABLE stints ADD COLUMN dismissed_at TEXT;
```

pure `ALTER TABLE ... ADD COLUMN`, so `runMigration`'s tolerant path in `src/db/database.ts` applies unchanged, matching `0008_declared_quests.sql`'s `origin_kind` precedent.

### Close-time check

`closeIdleStints` and `closeSessionStints` (`packages/core/src/w5/lifecycle.ts`) both close a stint by appending `stint.closed` with a `reason`. Both gain the same follow-up check, factored into one new function:

```ts
function dismissIfBelowMinimum(
  store: EventStore,
  database: Database,
  stintId: string,
  closedAt: string,
  minMinutes: number,
): void {
  const row = database
    .query(
      `SELECT stints.opened_at as openedAt,
              (SELECT SUM((julianday(traces.ended_at) - julianday(traces.started_at)) * 1440)
                 FROM traces WHERE traces.stint_id = stints.id AND traces.retracted_at IS NULL) as traceMinutes
         FROM stints WHERE stints.id = ?`,
    )
    .get(stintId) as { openedAt: string; traceMinutes: number | null };
  const traceMinutes = row.traceMinutes ?? 0;
  if (traceMinutes >= minMinutes) return;
  applyIncremental(
    database,
    store.append({
      actor: "system",
      kind: "stint.dismissed",
      subject: stintId,
      at: closedAt,
      payload: { reason: "below minimum" },
    }),
  );
}
```

called once per stint id right after each `stint.closed` append in both `closeIdleStints` and `closeSessionStints`, with `input.idleMinutes`'s sibling config value (`intentConfig.stintMinMinutes`, threaded through both functions' existing `input` parameter as a new required field, matching how `idleMinutes` already arrives). Trace minutes are summed the same way `report/intent-queries.ts` already sums them elsewhere in the codebase (trace minutes, never stint spans) — this reuses that convention rather than introducing a second way to measure a stint's duration.

A dismissed stint's traces are **not** retracted and **not** reassigned: they keep their `stint_id` exactly as recorded, and through it their quest (`stints.quest_id`). Dismissal marks the stint row; it does not touch the trace or quest tables. This is why reports can render dismissed-stint time as a per-quest "short work" line (below) without any new join — the existing `traces -> stints -> quests` path already gets there, filtered by `dismissed_at`.

### Reports, `review`, the memory slice, and the ratio ignore dismissed stints

- `report/intent-queries.ts`'s stint queries (`queryStints`/whatever feeds `daily.ts`/`project.ts`/`weekly.ts`'s stint listings) add `AND stints.dismissed_at IS NULL` alongside their existing `retracted_at IS NULL` filter — a dismissed stint is not retracted (it is a real fact: this work happened) but it is not a standup line either.
- **Per-quest "short work" line**: `daily.ts` and `weekly.ts`'s per-quest rendering (the same `groupByQuest` block Task 3 of the declared-quests plan already touches for the `(inferred)` suffix) gains a sibling query summing trace minutes from dismissed stints only, grouped by quest, rendered as one extra line per quest that has any: `- short work: <minutes> min` (no title repetition — it nests under the quest's existing heading). Zero dismissed minutes for a quest renders nothing, matching how `unconfirmed`/`(inferred)` suffixes only appear when true.
- `tempad review` (`runReview`, `packages/core/src/w5/cli.ts`) is unaffected in its expired-question and unconfirmed-quest sections; nothing there queries `stints` directly today.
- `buildWindow`'s `sessionOpenStints`/`recentStints` queries (`packages/core/src/w5/window.ts`, the `ACTIVITY_SLICE_SELECT` constant) add `AND stints.dismissed_at IS NULL` — a dismissed stint is not a candidate to match or continue, since it was never a real outcome to resume.
- `w5 eval`'s ratio (`stints / traces`, `packages/core/src/w5/eval.ts`) is computed over `stints.dismissed_at IS NULL AND stints.retracted_at IS NULL`, alongside the existing `stintCount` query's `retracted_at IS NULL` clause. This is the metric this whole spec exists to move: counting a dismissed stint in the numerator would silently keep the ratio inflated by exactly the maneuvers this spec exists to fold away.

### `declare` question suppression below minimum

`apply.ts`'s "no declaration yet" path (`needsDeclaration`, `packages/core/src/w5/apply.ts`) currently asks one `declare` question per window regardless of how much undeclared work the window contains. It gains a guard: sum the window's undeclared segments' durations (`endedAt - startedAt` per segment with no resolved quest, before the loop decides whether to ask) and skip `askQuestion` when that sum is below `stintMinMinutes` — a `declare` question is exactly as premature as a stint would be for the same stretch. The doubt is still recorded in `summary` bookkeeping terms (there is nothing to dismiss, since no stint or question was created), it is just never surfaced. On the next window, if undeclared time has accumulated past the threshold, the question is asked then.

A `belongs` doubt on a stint that ends up dismissed is expired, not asked: `apply.ts` already records the doubt (`summary.doubts += 1`) and calls `askQuestion` with `kind: "belongs"` inside the per-segment loop, before the stint the segment belongs to is known to be short-lived (dismissal only happens at close time, which can be a different window or a different run entirely). So the enforcement point is `advanceQuestions` (`packages/core/src/w5/questions.ts`), not `apply.ts`: `advanceQuestions`'s per-question loop, before promoting a `watching` question to `asked`, checks whether the question's trace's stint has `dismissed_at IS NOT NULL` and if so calls `expireQuestion` directly (payload `{}`, same shape `expireQuestion` in `intent/api.ts` already writes) instead of promoting — the existing `if (row.kind === "why" && ...)` early-expire branch in `advanceQuestions` is the precedent for "expire instead of promote" on a kind-specific condition; this is the same shape for `belongs`.

## A session accumulates declarations

### The problem with "latest wins"

`currentDeclaredQuest`/`currentDeclaredQuestForSubagent` (`packages/core/src/intent/declarations.ts`) resolve the single most recent `quest.declared` event for a session/scope at time `t`. This is correct for one quest at a time, but a session legitimately pursuing two quests at once (a lead coordinating two efforts, or one that starts quest A, gets pulled to quest B, and returns to A) has no way to keep both declared: declaring B silently makes B "the" declared quest and the verifier can no longer place a segment against A without treating it as a `belongs: false` doubt against B.

### Every declaration stays active until ended

A `quest.declared` event now marks the declared quest **active** for the session from `at` onward, not just "current until superseded." A session's **active quests** at time `t` are every quest with a `quest.declared` event (`scope: "session"`, matching `session_id`, `at <= t`) that has not been ended for that session by a later `quest.declared` event carrying `done: true` for the same quest, at or before `t`.

`QuestDeclaredPayload` (the payload shape `declareQuest` writes, `packages/core/src/intent/declarations.ts`) gains an optional field:

```ts
done?: boolean; // true: this event ends the named quest's active declaration for this session
```

`declareQuest` gains a parameter path for this: `DeclareQuestInput` gains `done?: boolean`, and when `input.done` is `true`, `input.questId` is required (`--done` always names an existing quest — there is no `new` + `done` combination) and no `quest.created` branch runs; the appended `quest.declared` payload carries `done: true` and no `new`. The CLI surfaces this as `tempad quest declare --session <id> --done <quest>`, a new, simpler branch in `runQuestCommand`'s existing `if (subcommand === "declare")` block in `packages/core/src/intent/cli.ts`: `--done` is mutually exclusive with `--quest`/`--new`/`--plan`/`--origin` (a usage error otherwise, same style as the existing `--quest`/`--new` exclusivity check at cli.ts:793), and resolves `--done <quest>` through the same `resolveExistingQuest` merge-chain lookup the `--quest` branch already uses (cli.ts:815) before appending.

### `activeDeclaredQuests`

A new function in `packages/core/src/intent/declarations.ts`:

```ts
export interface ActiveDeclaredQuest extends DeclaredQuest {
  alias: string; // "Q1", "Q2", … in declaration order
}

export function activeDeclaredQuests(
  database: Database,
  input: { sessionId: string; at: string },
): ActiveDeclaredQuest[]
```

Implementation reads every `quest.declared` event for `scope: "session"`, `session_id = input.sessionId`, `at <= input.at`, ordered by `at ASC, id ASC` (oldest first, so alias numbering is stable across a session's life — a quest declared first is always `Q1`, even if a later window queries a shorter time range). It folds them in order: a plain declaration (no `done`) adds or updates that quest's plan/outcome in an ordered map keyed by `quest_id`; a `done: true` declaration removes that quest_id from the map. The final map's values, in insertion order, are returned with `alias` assigned `Q1..Qn` over the _current_ surviving set — a quest ended and a different one declared later reuses no alias, since aliases are assigned fresh from the final active set each call, not carried from a stint-alias-style stable table. (This mirrors `buildWindow`'s existing per-call stint-alias assignment in `packages/core/src/w5/window.ts` — freshly numbered every time, never persisted.)

`currentDeclaredQuest` (single-quest form) is **not removed** — non-session-scope resolution (`currentDeclaredQuestForSubagent`) still returns one quest, since a subagent has exactly one declaration path per the declared-quests spec, unchanged by this one. `currentDeclaredQuest`'s session-scope behavior becomes a thin wrapper: `activeDeclaredQuests(...).at(-1) ?? null` for any single-quest call site that still only wants "the most recently declared active quest" (there are a few: `runContext`'s non-multi-quest-aware pieces, `report/intent-queries.ts`'s `attributeNonClaudeEvidence`, `w5 eval`'s `--declare` file's single-quest fixtures) — none of these are rewritten by this spec except where explicitly named below.

### Hook context line

`runContext` (`packages/core/src/w5/cli.ts`) and `buildDeclarationLine` (`packages/core/src/w5/hooks.ts`) change to list every active quest:

```
tempad: session <id>, active quests: <title> [Q1], <title> [Q2] | none. Declare with the tempad-quest skill if this prompt starts a different outcome.
```

`buildDeclarationLine`'s signature changes from `(declared: { title: string } | null, sessionId: string)` to `(active: { title: string; alias: string }[], sessionId: string)`: an empty array renders `none` (verbatim, unchanged from today's single-quest case); one or more entries render as `<title> [<alias>]` joined by `, `. `runContext` calls `activeDeclaredQuests` instead of `currentDeclaredQuest` to build this line. Every other existing caller of `currentDeclaredQuest` for a _session_-scope lookup that only needs "the" quest (not the full list) keeps working unchanged, since `currentDeclaredQuest` itself is untouched — only `buildDeclarationLine`'s input type and `runContext`'s call site change.

### Verifier prompt: `Q1..Qn` aliases

`ClassifierWindow` (`packages/core/src/w5/classifier.ts`) changes `declaredQuest: DeclaredQuestSlice | null` to `activeQuests: (DeclaredQuestSlice & { alias: string })[]` (empty array replaces `null` for "nothing declared" — consistent with how `stintAliases` is already an object rather than nullable). `parentDeclaredQuest` keeps its existing single-quest shape (`DeclaredQuestSlice | null`) — a subagent's own declaration is still exactly one active quest at a time per the declared-quests spec (subagent scope is not touched by "a session accumulates declarations"; only session scope gains multiple active quests), so `parentDeclaredQuest` never needs an alias list of its own, but is now also listed alongside the session's own to the child prompt (below).

`buildWindow` (`packages/core/src/w5/window.ts`) replaces its single `currentDeclaredQuest` call (for the non-subagent branch) with `activeDeclaredQuests`, mapping each result to `{ title, outcome, plan, alias }`. The subagent branch is unchanged (`currentDeclaredQuestForSubagent` for `declaredQuest`... but see below: `declaredQuest` singular no longer exists on `ClassifierWindow`, replaced everywhere by `activeQuests`, so a subagent session's own `activeQuests` is a one-element array wrapping its single declaration, aliased `Q1`, for prompt-rendering uniformity — the subagent path stays a single quest in substance, just rendered through the same list shape the session path now uses).

`buildUserPrompt` (`packages/core/src/w5/prompt.ts`) replaces the single `renderDeclared("your declared quest", ...)` line with one line per active quest:

```
active quests:
  Q1: <title> — <outcome> (plan: a; b; c)
  Q2: <title> — <outcome> (plan: (none))
```

or `  (none declared — ask to declare)` when `activeQuests` is empty. When `parentDeclaredQuest` is set, it renders as today, one more line: `the parent session's declared quest: <title> — <outcome>` (unchanged wording, since the parent is still exactly one quest).

### `ClassifierSegment.quest` alias selector

The verifier's schema (`buildDeclaredSystemPrompt`) gains a required field on each segment:

```
"quest": string ("Q1".."Qn", an active quest this segment serves) | null (only when belongs is false)
```

`ClassifierSegment` (`classifier.ts`) gains `quest: string | null` — required to be a key of the window's active-quest alias set (`Q1..Qn`) when `belongs` is `true`; forced `null` (repaired, not rejected, same philosophy as `guess`) when `belongs` is `false`, since a segment that does not belong to any active quest has nothing to name. `validateSegment` gains this check alongside the existing `belongs`/`guess` pair, using the same alias-validation pattern already applied to `matchedStint`/`continuesStint` against `stintAliases` — an unrecognized `Qn` is treated as absent and re-defaulted the same way (counted under the existing `selectorDefaulted`, no new counter, since this is the same "the model named something not on the list" failure mode `matchedStint`/`continuesStint` already handle).

`apply.ts`'s declared-mode resolution (`resolveStintForSegmentDeclared`) changes its `declaredQuestId: string | null` parameter to accept the segment's own `segment.quest` alias, resolved through `window.activeQuestAliases` (a new reverse map on `ClassifierWindow`, built in `buildWindow` exactly like `stintAliases`: `{ Q1: "<real quest id>", ... }`) — every branch that previously used one window-wide `declaredQuestId` now resolves per-segment via `segment.quest`, since which of the session's several active quests a given segment serves is now a per-segment decision the model makes, not a window-wide constant. `applyResult`'s window-level `declaredQuestId` resolution (currently done once before the segment loop, `packages/core/src/w5/apply.ts`) is deleted for the multi-quest case; the subagent single-quest path (`parentDeclaredQuest`) keeps its existing window-level resolution, since a subagent's own declaration is still one quest for the life of the window.

### Doubts on an unknown alias

A segment naming a `quest` alias that is not a key of `activeQuestAliases` counts `selectorDefaulted` (as above) and, since the model was clearly trying to say "this belongs to something," is treated as a doubt: `belongs` is forced to `false` (repaired) and `guess` defaults to `"unrecognized quest alias"` when the model left it empty, so the doubt still surfaces to the human rather than silently attaching to nothing.

### Subagents see the parent's active quests too

`buildUserPrompt`'s subagent branch already renders `parentDeclaredQuest` as one line; this spec adds the full list, labeled, matching the session case: when the current session is a subagent, `parentDeclaredQuest` is replaced on `ClassifierWindow` by `parentActiveQuests: (DeclaredQuestSlice & { alias: string })[]` (aliased `PQ1..PQn`, mirroring `Q1..Qn`), built by `buildWindow` calling `activeDeclaredQuests` against the parent session id instead of `currentDeclaredQuest`. The subagent's own declaration remains the default target for `segment.quest` resolution when the subagent has one (`Q1` in its own one-element `activeQuests`); a segment naming a `PQn` alias is valid too (the subagent doing work that belongs to one of the parent's several active quests directly, e.g. a helper subagent split across two of the lead's efforts) and resolves through a combined alias map (`{ ...activeQuestAliases, ...parentActiveQuestAliases }`) built once in `buildWindow`, since `Q` and `PQ` prefixes never collide.

## The plan defines the grain

### `--plan` lists stints, never maneuvers

The skill (below) states the rule with the two examples from the brief:

- Wrong: `"read the brief; edit window.ts; run tests"` — three maneuvers of one stint.
- Right: `"Refactor the window builder and ship it as a PR"` — one stint, one outcome.

`DeclareQuestInput.plan` (`declarations.ts`) is unchanged in shape (`string[]`) — the change is entirely in how the verifier is asked to use it, not in storage.

### `stint`, `"S3"`, and `"new: <one line>"` selectors

The verifier's existing three-way selector (`matchedStint`/`continuesStint`/`newStintReason`, now against `stintAliases` `A1..An`) is **replaced**, for declared mode only, by a differently-shaped rule that folds the plan in. `ClassifierSegment` (declared mode) gains, replacing `matchedStint`/`continuesStint`/`newStintReason`:

```ts
stint: string; // one of: "P<n>" (a plan stint of the segment's quest), "S<n>" (an open stint of the session), or "new: <one line>" (the same-answer test fails against every listed stint)
```

encoded as a single string with a structural prefix rather than three optional fields, because the three candidates now come from two different sources (a quest's plan vs. the session's actually-open stints) that must be disambiguated by more than "which of three fields is non-null" — the prefix makes the source explicit in the value itself, which is what `validateSegment`'s parser needs to route to the right resolution path.

The prompt lists, per active quest `Qn`, its plan as `Pn.1..Pn.m` (one-indexed per quest, e.g. quest `Q2`'s plan items are `P2.1`, `P2.2`) alongside the session's actually-open stints as `S1..Sk` (renumbered from today's `A1..An` — the letter changes from `A` to `S` because this spec's plan-stint aliases now occupy the `P` prefix, and `S` reads as "stint" the way `A` read as "activity" before the rename; `stintAliases` on `ClassifierWindow` is renamed `openStintAliases` to match, a pure rename with no behavior change beyond the prefix, and every existing reader of `stintAliases` — `apply.ts`, `prompt.ts`, `classifier.ts`'s validation — updates to the new name). A plan stint (`P2.1`) becomes a real stint (a row in `stints`) only once a first trace lands on it — before that it is just a line in the prompt, not a database row — via a `stint.opened` event carrying a new payload field `plan_index: "P2.1"` (string, the literal alias at the moment it was first matched, kept for audit/debugging, not re-parsed later). `apply.ts`'s stint-resolution for declared mode gains a branch: `stint` starting with `P` is resolved by first checking whether a stint already exists for `(questId, plan_index)` in this session (a session-scoped in-memory map built at the top of `applyResult`, since one plan stint maps to at most one open stint per session — the same plan item matched twice in one window, or across windows without closing, must reuse the row, not open a second one); if none exists, `openStintContinuing` opens one with `plan_index` set. `stint` starting with `S` resolves through the existing open-stint alias map (renamed `openStintAliases`) exactly as `matchedStint` did. `stint` starting with `"new: "` opens a plain new stint with `outcome` taken from the text after the prefix (mirroring today's `newStintReason`, but the text is now the outcome itself rather than a justification for why nothing matched, since the "why" is the same-answer test already named in the schema instructions) and no `plan_index`.

`validateSegment`'s three-way "exactly one selector" rule is retired for declared mode (there is exactly one `stint` field now, not three optionals to reconcile) — inference mode's `matchedStint`/`continuesStint`/`newStintReason` three-way rule is **unchanged**, since inference mode has no plan to fold in and keeps today's schema and validation verbatim. A malformed `stint` string (does not start with `P`, `S`, or `new: `, or names a `Pn.m`/`Sn` alias not in the window's maps) is repaired to `"new: " + segment.what` and counted under `selectorDefaulted`, the same repair-not-reject philosophy already established.

### Executors may amend the plan

`declareQuest` already accepts a fresh `plan` on every declaration; nothing new is needed for "the latest plan for a quest in the session wins" beyond what `activeDeclaredQuests`'s fold-in-order already does — the most recent (highest `at`) plain declaration for a still-active quest carries the plan `buildWindow` reads, since `activeDeclaredQuests`'s fold keeps updating each quest's stored plan/outcome as later declarations for the same `quest_id` arrive, only removing it from the map on `done: true`. A re-declaration of an already-active quest (same `quest_id`, no `done`) is exactly "amend the plan," already representable and already handled, so the skill just states this is allowed (below).

### Old selectors are inference-only from now on

`matchedStint`/`continuesStint`/`newStintReason` remain exactly as specified in the declared-quests and activity-continuity specs, but **only for `[w5].mode = "inferred"` and backfill's per-session inference fallback**. `ClassifierSegment`'s TypeScript type keeps both shapes as a discriminated-by-mode reality (same pattern the type already uses for `matchedQuest`/`proposedQuest`/`questions` being inference-only optionals) — `stint`/`quest` optional and inference-mode-absent, `matchedStint`/`continuesStint`/`newStintReason` optional and declared-mode-absent. `validateSegment`'s existing `mode` parameter already branches on this for `belongs`/`guess`; it gains the equivalent branch for `stint` vs. the three-way fields.

## Skill

`packages/core/skills/tempad-quest/SKILL.md` is rewritten (still under 60 lines; every command in it parses against the CLI, per the existing test the brief cites) around:

1. **What TemPad tracks** — the user's attention, not the agent's: a one-line restatement of the principle already in the declared-quests spec, so the skill is self-contained for an agent that has not read the specs.
2. **Glossary lines** (verbatim from `docs/specs/2026-09-07-ubiquitous-language.md`) for Quest, Stint, Maneuver — three short definitions, quoted, not paraphrased, so the terms mean the same thing in the skill as in the spec and the prompt.
3. **When to declare**: session start (from the first prompt), every new quest (a plain re-declaration, or `--origin`/`--deviates-from` for a detour — existing content, kept), inside every subagent with `--parent` (existing content, kept), and now explicitly **when a quest is done**: `tempad quest declare --session <id> --done <quest>`.
4. **Commands**: the existing `declare`/`--new`/`--quest`/`--origin` forms, plus `--done`, plus the executor rule from the brief verbatim: _"Other work while a quest is active? If it advances the active quest, `--advances`; otherwise `--deviates-from` and say what pulled you away."_ — this is the first place `--advances`/`--serves` appear in the skill; both are documented as flags on `quest declare`/`quest add` per the ubiquitous-language spec's relation-verb table, with one line each (no new mechanics — `--serves`/`--advances` are already specified in the rename spec's relation-verb table; this skill section is the first place an executor is told to use them).
5. **The plan rule**, with the two examples from the brief (wrong: three maneuvers; right: one outcome), replacing the current one-line "Pass `--plan` ... optional" paragraph.

Content that must be **removed** to stay under 60 lines: the current "Read your current declaration first" section's full explanation of the hook line format is trimmed to two lines (what the line looks like, and "read it fresh each turn — do not track it yourself"), since the multi-quest hook line format is documented once here and the exact wording lives in `hooks.ts`, not duplicated at length in the skill.

## Config changes

`W5Config` (`packages/core/src/intent/config.ts`) gains one field:

```ts
stintMinMinutes: number; // default 5, [w5].stint_min_minutes
```

`tempad.example.toml`'s `[w5]` block gains `stint_min_minutes = 5`, placed after `inference_fallback` (the last key the declared-quests plan added).

No other config keys change. `[w5].mode`/`inference_fallback` (declared-quests spec) are unaffected; multi-quest declarations and plan-grain stints apply within declared mode exactly as today's single-quest declared mode did, with no new mode switch — a session with one active quest behaves exactly as before (its `activeQuests` array simply has one element, aliased `Q1`).

## Reports

- Per-quest "short work" line (minutes from dismissed stints), in `daily.ts` and `weekly.ts`'s per-quest rendering — specified under "Minimum duration" above.
- No other report change: `origin_kind`/`(inferred)` rendering, the `doubts` weekly column, and non-Claude attribution (all from the declared-quests plan's Task 3) are unaffected by multi-quest declarations, since `attributeNonClaudeEvidence` resolves a **single** quest per commit/item timestamp — with several quests active in a session at once, this remains a deliberate simplification: attribution stays "whichever quest was declared most recently as of the commit's timestamp" (`currentDeclaredQuest`'s existing single-quest resolution, unchanged), not "guess which of the several active quests the commit served." This is stated as an open question below, not solved by this spec.

## Evaluation

`w5 eval --declare` (`packages/core/src/w5/eval.ts`) accepts `plan` on a `new` entry — the eval's `DeclareFileEntry.new` interface gains `plan?: string[]`, passed straight through to `declareQuest`'s `plan` field (currently hardcoded to `[]` in `applyDeclareFile`, per the existing code at `eval.ts`'s `declareQuest(store, database, { ..., plan: [], ... })` call — this becomes `plan: entry.new?.plan ?? entry.plan ?? []`, reading a plan from either the `new` object or a top-level `plan` field on the entry, since a `--quest <existing>` entry also has a plan to amend and should not be forced through `new`). The file already drafted for 2026-09-02 at `scratch/declare-2026-09-02.json` needs `plan` arrays added per quest before it can be used to demonstrate this spec's success criterion — that update is implementation work, not part of this spec.

`EvalMetrics` (`eval.ts`) gains:

- `stintsDismissed: number` — `SELECT COUNT(*) FROM stints WHERE dismissed_at IS NOT NULL AND opened_at >= ? AND opened_at < ?`, same range-scoping pattern every other eval metric already uses.
- `planStintsHit: number` — count of live traces in range whose stint has a non-null `plan_index` (a new column on `stints`, part of "The plan defines the grain" above — `stints.plan_index TEXT`, added by the same `0012_stint_minimum.sql` migration this spec already introduces, or a second migration `0013_plan_stints.sql` if landed as a separate task; see the plan document for the exact split). Counts _segments_ assigned to a plan stint, i.e. traces, not stints, per the brief's wording ("segments assigned to a plan stint").
- `stintsNew: number` — count of live stints opened in range with `plan_index IS NULL` and not a `continues` link to a dismissed/plan stint — i.e., stints the model opened outside the plan, exactly the brief's "segments that opened a stint outside the plan."
- The existing `ratio` (`stints / traces`) is computed over `dismissed_at IS NULL` stints, as specified under "Minimum duration" above — this is not a new metric, but its denominator population changes, which is the whole point of this spec.

Success for the 2026-09-02 batch, per the brief: human-session ratio under 0.3 with the plans file, and every `stintsNew` stint readable as a standup line in the 20-row random sample `w5 eval` already prints (`EvalSampleStint`, unchanged shape — `what`/`why` already come from the stint's earliest trace, which is exactly what a standup-line readability check needs).

## Open questions

- **Non-Claude attribution with several active quests.** `attributeNonClaudeEvidence` (declared-quests spec, Task 3) resolves a commit or Monday item to the single most-recently-declared quest active at that timestamp. With multiple quests active at once, this is a known simplification (stated above under Reports) and not resolved here — a future spec could attribute by branch name, commit message convention, or an explicit `--serves`/`--advances` hint written by the executor at commit time, none of which are in scope now.
- **Cross-session plan continuity.** A plan stint (`P2.1`) that never receives a first trace in the session that declared it (the plan changes before the executor gets to it) simply never becomes a row — this spec does not carry an unfulfilled plan item forward into a later session's `activeDeclaredQuests` fold. Whether that should happen is left for the operator to decide after seeing how often it comes up in eval runs.
