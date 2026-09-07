# Declared quests

Status: not started. Date: 2026-09-07. Extends `docs/specs/2026-09-05-intent-model-and-w5-hook-design.md` (domain language, event catalog, w5 hook wiring) and `docs/specs/2026-09-06-activity-continuity-design.md` (activity lifecycle, classifier memory slice, `matchedActivity`/`continuesActivity`/`newActivityReason`, `w5 eval`) — read both first; this spec does not repeat their event catalogs, lifecycle rules, or memory-slice mechanics, only what changes.

## Principle

TemPad tracks the attention of the human. Declarations carry quest identity; traces carry time and place. Traces stay exactly as they are — timesheets and hour-by-hour, client-facing reports need when and how long, and a commit or a Monday update has no agent present to declare anything for it.

Eval run 3 (2026-09-01..03) found 186 quest conflicts out of 907 traces: ~40% were activities with no quest that the classifier named one for anyway (not a real conflict, just `matchedQuest` set where the activity had none — see `apply.ts`'s existing `questProposedOnMatched` path, which already handles this case correctly and was miscounted only in the sample analysis, not in code); ~25% were garbled 26-character ids (hallucinated or prefix-duplicated ULIDs the model invented rather than copied from the candidate list); ~35% were a single catch-all quest ("Security audit of CI/CD deployment setup") absorbing any segment whose transcript mentioned "security". All 143 quests in the database are unconfirmed classifier proposals fed back into the classifier's own `openQuests` list on the next run, so a bad proposal compounds.

Conclusion: quest identity must come from the executing agent, which knows its quest when it starts a session or a subagent. The classifier stops deciding what quest a stretch of work belongs to. It becomes a **verifier**: it raises doubts about whether a stretch of work matches the session's declared quest, and never invents or reassigns a quest itself.

Out of scope: a UI for declaring (CLI and the `tempad-quest` skill only), retroactively re-declaring history in bulk (backfill keeps today's inference mode), changing `activity.closed`/lifecycle semantics from the continuity spec, changing how time is summed (still trace minutes).

## Declarations

A **declaration** is a `quest.declared` event appended by the executing agent (or the hero) stating which quest a session, or a subagent within it, is pursuing. `EVENT_KINDS` (`packages/core/src/intent/events.ts:3`) gains `"quest.declared"`, appended after `"quest.returned"` (before the `activity.*` group) to keep event kinds grouped by domain the way the file already does.

Payload:

```ts
interface QuestDeclaredPayload {
  session_id: string;
  quest_id?: string; // existing quest, mutually exclusive with `new`
  new?: {
    title: string;
    objective: string;
    commitment: "promised" | "personal" | "exploratory";
    project?: string;
    origin?: string; // quest id this branches from
    trigger?: string; // required when `origin` is set
    kind?: "waiting" | "blocker" | "curiosity" | "unknown"; // required when `origin` is set
  };
  plan: string[]; // coarse actions the executor anticipates; may be empty
  scope: "session" | "subagent";
  parent_session_id?: string; // required when scope is "subagent"
  declared_by: "agent" | "hero";
  at: string; // ISO; separate from the event's own `at` so a hand-declared backfill entry can predate `recorded_at`
}
```

Exactly one of `quest_id` / `new` is set — enforced by the CLI (below), not by a projection-level check, since events are never rejected once appended.

A quest created via `new` is created with the existing `quest.created` event (unchanged shape) immediately followed by `quest.declared` referencing it, both at the same `at`. It gets `confirmed: true` (the declaring agent is a first-party source, not a classifier guess) and `origin_kind: "declared"`.

### `origin_kind` column

`quests` (`packages/core/src/intent/projections/quest.ts:8`) gains a column `origin_kind TEXT NOT NULL DEFAULT 'inferred'`. `quest.created`'s `INSERT` (same file, the `quest.created` case) sets it from `payload.origin_kind ?? "inferred"` — every existing caller of `quest.created` (`tempad quest add`, `apply.ts`'s `createQuest`) is updated to pass `origin_kind: "declared"` when the caller is the CLI or a declaration, `"inferred"` when the caller is the classifier (`apply.ts`). A migration `0008_declared_quests.sql` does `ALTER TABLE quests ADD COLUMN origin_kind TEXT NOT NULL DEFAULT 'inferred'` (pure `ALTER TABLE ... ADD COLUMN`, so `runMigration`'s tolerant path in `src/db/database.ts` applies unchanged, per the convention `0007_activity_lifecycle.sql` set). Existing rows default to `'inferred'` — every quest in the database today is a classifier proposal, matching the eval finding.

### Current declared quest

A session has an ordered list of declarations (append-only, one `quest.declared` event per declaration). The **current declared quest** of a session at time `t` is the `quest_id` (or the quest created by `new`) of the last `quest.declared` event with `scope: "session"`, `session_id` matching, and `at <= t`. A subagent's current declared quest is the last `scope: "subagent"` declaration for that `parent_session_id`/session pair at or before `t`; if none exists, it has no declared quest of its own (it does **not** inherit the parent's — the skill instructs declaring inside every subagent, and "no declaration in a subagent" is exactly the case the verifier's `declare` question kind handles, see below), but the parent's own declared quest is still used when _questions_ need to roll up (see "Questions and hand-back" below).

`currentDeclaredQuest(database, input: { sessionId: string; at: string }): { questId: string; title: string; objective: string | null; plan: string[] } | null` in a new `packages/core/src/intent/declarations.ts` answers this by querying `events` directly (declarations are not projected into a table — the query is cheap and append-only event scans are the established pattern for time-travel-sensitive reads elsewhere, e.g. `stateAsOf`): `SELECT payload FROM events WHERE kind = 'quest.declared' AND json_extract(payload, '$.session_id') = ? AND at <= ? ORDER BY at DESC, id DESC LIMIT 1`, resolved to the quest's current `title`/`objective` via a join against `quests`. A second function `currentDeclaredQuestForSubagent(database, input: { sessionId: string; parentSessionId: string; at: string })` does the same with `scope = 'subagent'` and `parent_session_id` matching.

## CLI

```
tempad quest declare --session <id> [--parent <id>]
  (--quest <id> | --new "<title>" --objective "<text>" [--commitment promised|personal|exploratory] [--project <slug>]
    [--origin <quest id> --trigger "<sentence>" --kind waiting|blocker|curiosity|unknown])
  [--plan "a; b; c"] [--by agent|hero] [--at <iso>]
```

Implemented in `runQuestCommand` (`packages/core/src/intent/cli.ts:403`) as a new `if (subcommand === "declare")` branch, following the file's existing pattern (`parseArgs` with `strict: true, allowPositionals: false` — this subcommand takes no positional, everything is a flag since `--session` is required and there is no natural positional). Validation, in order: `--session` required; exactly one of `--quest` / `--new` (both or neither is a usage error, matching the style of existing "usage: ..." early returns); `--new` requires `--objective`; `--origin` requires both `--trigger` and `--kind`; `--parent` requires `scope: "subagent"` (its presence sets scope, its absence means `scope: "session"` — no separate `--scope` flag); `--plan` splits on `;` and trims each part, empty string produces `[]`; `--by` defaults to `"agent"`; `--at` defaults to `new Date().toISOString()`.

`--at` exists so the lead can declare by hand for sessions that have already ended — the eval harness (`--declare`, below) and a manual correction both need to append a declaration timestamped in the past.

Two events are appended (inside one `database.transaction`, matching `runQuestCommand`'s existing `applyIncremental` calls which are each already transactional at the SQLite level via `EventStore.append`): `quest.created` (only when `--new`) then `quest.declared`.

## Skill: `tempad-quest`

`packages/core/skills/tempad-quest/SKILL.md`, installed by an addition to the existing `tempad skill install --scope user` command (a new subcommand parallel to `w5 hook install`'s scope handling; the skill file is copied into `~/.claude/skills/tempad-quest/SKILL.md`, matching how Claude Code skills are discovered). Content, in prose (not code, since it is a prompt read by an agent): declare at session start from the user's first prompt, inferring `--new` fields from what was asked; declare again whenever the objective changes mid-session, passing `--origin <current quest id> --trigger "<the sentence that caused the pivot>"` when the new work is a side quest of the one just left, or a plain new declaration (no `--origin`) when the old objective is simply done; inside a subagent, always declare with `--parent <this session's id>` before starting substantive work, even when the subagent's objective is the same as the parent's (an explicit declaration, not inheritance, is what lets the verifier's `declare` question distinguish "forgot" from "same objective on purpose"). The skill also documents that the agent learns its own session id and its current declaration from the `UserPromptSubmit` hook context line (below) — it does not need to track either itself.

## `UserPromptSubmit` hook line

`w5-prompt.sh` already calls `tempad w5 context --session <id>` and injects whatever it prints as `additionalContext` (`packages/core/hooks/w5-prompt.sh`, `packages/core/src/w5/cli.ts:132`'s `runContext`, which currently only prints question hand-back text via `buildAdditionalContext`, `packages/core/src/w5/hooks.ts:111`). `runContext` gains one line, prepended before the existing question lines: it calls `currentDeclaredQuest(context.database, { sessionId: values.session, at: new Date().toISOString() })` and prints

```
tempad: session <id>, declared quest: <title> | none. Declare with the tempad-quest skill if this prompt starts a different objective.
```

using `none` (verbatim) when there is no declaration yet — the executor cannot infer whether it forgot to declare or the session genuinely has nothing declared without an explicit signal each turn. `buildAdditionalContext` (`hooks.ts:111`) gains this line as a new leading parameter (`buildDeclarationLine(declared: { title: string } | null, sessionId: string): string`, a sibling function in the same file since it renders context text the same way question lines do) so its existing question-line test coverage doesn't need to change shape, only gain a case.

## Verifier

The classifier stops proposing or matching quests. `ClassifierWindow` (`packages/core/src/w5/classifier.ts:4`) drops `openQuests` and `recentSideQuests` (both quest-shaped memory the verifier no longer needs to browse) and gains:

```ts
declaredQuest: { alias: "Q"; title: string; objective: string | null; plan: string[] } | null;
parentDeclaredQuest: { alias: "PQ"; title: string; objective: string | null; plan: string[] } | null; // set only when the session has a parent (subagent)
activityAliases: Record<string, string>; // alias -> real activity id, e.g. { A1: "01H...", A2: "01H..." }
```

`sessionOpenActivities` and `recentActivities` keep their existing shape (`activityId`, `what`, `why`, etc. — see the continuity spec) but the id embedded in the prompt text is replaced by a short alias (`A1`, `A2`, …) assigned by `buildWindow` in the order activities are listed; `activityAliases` is the reverse map `apply.ts` uses to resolve a model-returned alias back to a real id. The model never sees or writes a ULID: this closes the ~25% "garbled 26-character id" failure mode directly, since there is no 26-character string for the model to garble.

`buildWindow` (`packages/core/src/w5/window.ts:62`) drops the `openQuests` and `recentSideQuests` queries entirely and adds: a call to `currentDeclaredQuest`/`currentDeclaredQuestForSubagent` (from `intent/declarations.ts`, above) for `declaredQuest`/`parentDeclaredQuest`; an alias assignment pass over `sessionOpenActivities` and `recentActivities` (concatenated, in the order they're already queried, numbered `A1..An`) building `activityAliases` and rewriting each row's `activityId` field to its alias before the window is returned — `apply.ts` maps aliases back via `activityAliases`, so nothing downstream of `buildWindow` ever sees a real id in a segment except through that map.

### `ClassifierSegment` schema (verifier mode)

```ts
interface ClassifierSegment {
  startedAt: string;
  endedAt: string;
  what: string;
  why: string;
  belongs: boolean; // does this segment belong to the declared quest (or parent's, for a subagent segment)
  guess: string | null; // short string naming what it looks like instead; required when belongs is false, else null
  matchedActivity: string | null; // alias, e.g. "A1"
  continuesActivity: string | null; // alias
  newActivityReason: string | null;
  isSwitch: boolean;
  trigger: string | null;
  confidence: number;
}
```

`matchedQuest`, `proposedQuest`, and `questions` are removed — the verifier makes no quest decision and asks no `which_quest`/`why`/`trigger` question; its questions are the two new kinds below. `QuestionKind` (`classifier.ts:43`) becomes `"belongs" | "declare"` — `which_quest`, `why`, `trigger` are dropped from the type and from `QUESTION_KINDS`, since nothing in verifier mode ever needs to distinguish among the old three, and `[w5].mode` (below) means the removed kinds never appear in a fresh window a verifier-mode classifier is asked to fill in. A database with existing `questions` rows of the old kinds keeps them; `tempad review` renders any `state = 'expired'` row by its stored `kind` and `text` regardless of which kind produced it, so old rows still render correctly (`runReview`, `packages/core/src/w5/cli.ts:229`, already does this generically).

`validateSegment` (`classifier.ts:116`) changes: `matchedQuest`/`proposedQuest` validation blocks are deleted; `belongs` gains a required-boolean check; `guess` is validated as "string when `belongs` is false, must be null when `belongs` is true" (a segment claiming to belong to the declared quest has no need to guess what else it might be, and a model that fills it in anyway has its `guess` discarded rather than the window rejected — same "repair, don't reject" philosophy `validateResult` already applies to the activity selector). The three-way `matchedActivity`/`continuesActivity`/`newActivityReason` selector rule (exactly one non-null) is unchanged from the continuity spec, and now validates against `activityAliases`' keys instead of accepting any string — an alias not in the map is treated exactly like today's "unknown activity id" (`unknownActivityId` counter in `apply.ts`), just checked against a small closed set instead of a database lookup, since the whole point of the alias scheme is that `apply.ts` never needs to look up a bare id, and a fabricated alias is caught the same way a fabricated ULID id was ("resolves to nothing" -> open new activity, count it).

## `apply.ts` in declared mode

`applyResult` (`packages/core/src/w5/apply.ts:281`) drops every quest-resolution path: `resolveQuest`, `createQuest`'s call sites inside `apply.ts`, `reuseActivity`'s quest-conflict/quest-proposed-on-matched branches, and `branchQuest`'s call from the `isSwitch` block all go — the verifier never creates, proposes, reassigns, or branches a quest. What replaces them:

- Every activity `apply.ts` opens or reuses in a declared session (`[w5].mode = "declared"`, see Config below) is given the session's current declared quest (or the subagent's own, when the segment's session is a subagent scope) — resolved once per window via `currentDeclaredQuest`, not per segment, since a declaration mid-window is rare enough that re-checking per segment would only matter for a window that itself straddles a re-declaration, which is already handled correctly because `apply.ts` iterates segments in order and a re-declaration between two backfill chunks is naturally picked up by the next chunk's `buildWindow` call. `resolveActivityForSegment`'s three branches (`matchedActivity`/`continuesActivity`/new) all end by calling `assignActivity`/`openActivityContinuing` with `quest: declaredQuestId` unconditionally — there is no per-segment quest decision left to make.
- `segment.belongs === false` appends a `question.asked` of kind `"belongs"` via `askQuestion` (`intent/api.ts:135`, unchanged signature — `kind` is already a bare string there, so no signature change is needed), payload carrying `activity` (the resolved real activity id, not the alias), `windowStart`/`windowEnd` (the segment's own bounds), and `guess` (the segment's `guess` string) — `AskQuestionInput.text` is set to the rendered hand-back sentence itself (below) so `runReview`'s existing generic `text` rendering needs no kind-specific branch. This question is scoped to the session (parent session, for a subagent segment — `AskQuestionInput.sessionId` is set to the parent's id in that case), subject to the same watch/ask thresholds `advanceQuestions` already applies (`packages/core/src/w5/questions.ts` is unchanged; it operates on `kind`/`state`/`turns_watched` generically and has no branch that only fires for the old three kinds).
- No quest is ever created or reassigned by `applyResult` in declared mode. `AppliedSummary.questConflicts` is renamed `doubts` (the field, every reader of it, and the `AppliedSummary` interface itself) — a `doubts` counter increments once per `belongs: false` segment, replacing the old meaning entirely rather than adding a second field, since the two concepts (a classifier's quest opinion disagreeing with an activity's stored quest, vs. a verifier's doubt that a segment belongs to the declared quest) never coexist in the same run: a run is either declared-mode (doubts) or inference-mode (the old quest-proposal machinery, kept for backfill fallback, below). `backfill.ts`'s `BackfillResult.questConflicts` is renamed `doubts` to match, summed the same way. `tempad w5 eval`'s printed metric line renames `quest_conflicts` to `doubts` and adds `doubts_answered` (count of `questions` rows with `kind IN ('belongs','declare')` and `state IN ('resolved_by_context','answered')` in the eval range) and `traces_unattributed` (count of live traces in range whose activity's `quest_id IS NULL` — only possible in a no-declaration session, below).

## Questions and hand-back

Hand-back text for a `belongs` question (the next turn of that session, via the `UserPromptSubmit` context line, same delivery mechanism as today's question hand-back):

```
w5 thinks the last stretch is not part of "<declared title>" (looks like: <guess>). Reply:
  tempad answer <id> --belongs --why "<reason>"
  or
  tempad answer <id> --quest <id>|new:"<title>" --why "<reason>" [--origin current --trigger "<sentence>" --kind waiting|blocker|curiosity|unknown]
Ask the user if you are not sure.
```

`tempad answer` (`runAnswerCommand`, `packages/core/src/intent/cli.ts:846`) gains `--belongs` (boolean, no value) as an alternative to `--quest`: exactly one of `--belongs` / `--quest` is required (today only `--quest` is accepted — this is an additive change to the option set, `--quest` keeps its existing `new:"title"` shorthand and its existing "unknown question"/"unknown trace" error paths unchanged). `--belongs` appends `question.answered` with `payload: { answeredBy: actor, belongs: true, why }` and does nothing else — the trace and its activity's quest are left exactly as they are, since "yes it belongs" confirms the declared quest rather than changing anything. `--quest <id>|new:"title"` on a `belongs` question means "no, retroactively move this trace and its activity to a different (possibly new) quest": it resolves/creates the quest exactly as `runAnswerCommand`'s existing `--quest` path does today, then calls `relinkTrace` (`intent/api.ts:107`, already exists, unchanged) to move the trace, and `assignActivity` if the activity holds only this one trace (an activity with other live traces under the declared quest is left alone; the answer only ever affects the trace the question was about, not retroactively splitting an activity — this is the existing `runAnswerCommand` behavior for its trace/activity resolution, unchanged). `--origin current --trigger "..." --kind ...` on a `--quest new:"title"` answer additionally appends `quest.branched` with `from_activity` set to the current declared quest's most recent activity — this is the answer-time equivalent of a live declaration's `--origin`, used when the answer itself is what reveals a side quest existed. `why` is stored on the `question.answered` payload regardless of which branch, exactly as today.

Expired `belongs`/`declare` questions surface in `tempad review` (`runReview`, `packages/core/src/w5/cli.ts:229`) exactly like today's expired questions — no code path changes there, since it already renders any `state = 'expired'` row generically by `id`/`text`. Nothing is invented on expiry; an expired `belongs` question just means the doubt was never resolved, and the trace keeps whatever quest it was recorded under.

## Sessions with no declaration

A session (or subagent) with **no** `quest.declared` event yet at window time gets a `"declare"`-kind question instead of ordinary classification: `apply.ts`, before resolving any segment's activity, checks whether `currentDeclaredQuest` returned `null` for the window's session/scope; if so, every segment in the window records its trace with `activity` resolved the normal three-way way but `quest_id = null` (an activity can exist and accumulate traces with no quest — this is already representable, since `activities.quest_id` is nullable and `openActivity`/`assignActivity` already treat an absent quest as valid), and exactly one `"declare"`-kind question is asked for the window (not one per segment — a whole undeclared window is one gap, not N), hand-back text:

```
w5 has no declared quest for this session. Reply:
  tempad quest declare --session <id> --quest <id>|--new "<title>" --objective "<text>" [--commitment ...] --by agent
```

(the same `declare` subcommand introduced above, so there is no separate answer path for this question kind — answering it is just running the normal declare command, which the next window picks up via `currentDeclaredQuest`). Traces with `quest_id = null` are counted by `w5 eval`'s new `traces_unattributed` metric.

**Backfill of history** (sessions that already ended, never declared anything and never will) is a different case from a live undeclared session: asking a `declare` question is useless for a session no agent will ever resume. `[w5].inference_fallback` (Config, below) controls this: when `true` (backfill's default), a session with no declaration at all across its entire span falls back to today's inference behavior — the classifier is given back `openQuests`/`recentSideQuests` and asked for `matchedQuest`/`proposedQuest` exactly as before this spec, and every quest it proposes is created with `origin_kind: "inferred"`. This fallback is decided once per session (checked before backfill's chunk loop begins, by querying whether any `quest.declared` event exists for that `session_id` at all — not per chunk, since a session either has declarations somewhere in it or it doesn't; a session declared partway through uses declared mode for its whole span, including the chunks before the first declaration, which fall into the "no declaration yet" `declare`-question path above rather than the inference fallback, since the fallback is specifically for sessions declaring nothing, ever). Inferred quests from the fallback are never attached to activities of a session that does have declarations elsewhere in its history — the per-session decision above is exactly what prevents that mixing.

## Non-Claude traces

Git commits (`gh_commits`, `repo`/`authored_at`) and Monday items/updates (`monday_items`, `org`/`project`/`updated_at`) are collector mirrors today (`packages/core/src/collect/github.ts`, `monday.ts`) — neither calls `recordTrace` or any intent API; they only populate their own raw tables (`packages/core/src/db/schema.sql:7,27,37`). There is no trace, activity, or quest for a commit today. This spec adds attribution at report time, in `report/intent-queries.ts`, not in the collectors — the collectors stay pure mirrors, matching their existing responsibility.

A new function `attributeNonClaudeEvidence(database, range)` in `intent-queries.ts` (called from wherever the weekly/daily report currently only reads `queryActivityTraceIntervals`/`queryActivities`) resolves each `gh_commits` row and each `monday_items` row in range to a quest by: joining the row's `org`/`project` (via `gh_repos.org`/`gh_repos.project` for a commit, direct columns for a Monday item) against `claude_sessions` on `org`/`project` where the session's `[started_at, ended_at]` overlaps the row's timestamp (`authored_at` for a commit, `updated_at` for a Monday item), taking the session with the **latest** `started_at` among overlapping matches when more than one session in that org/project was active at that instant (documented as "latest declaration wins" per the brief's wording, since among overlapping sessions in the same project the most recently started one is presumed the active one — this is a heuristic, not a guarantee, and is stated as such in the function's doc comment); then resolving that session's current declared quest as of the row's timestamp via `currentDeclaredQuest`. A commit or item with no overlapping session, or whose overlapping session has no declaration at that timestamp, is **unattributed** — it renders in reports the way an unquested activity already does (no quest column value), never invented. This function returns `{ id, kind: "commit" | "monday_item", questId: string | null, questTitle: string | null }[]`, consumed by the report layer to annotate evidence lists; it does not write anything back to the database (no event, no new table) — attribution is computed fresh at report time, consistent with reports already being read-only over the intent tables.

## Config

`W5Config` (`packages/core/src/intent/config.ts:5`) gains:

```ts
mode: "declared" | "inferred"; // default "declared"
inferenceFallback: boolean; // default true, backfill only — see "Sessions with no declaration"
```

read from `[w5]` as `mode` (string) and `inference_fallback` (boolean — `loadIntentConfig`'s existing `number()` helper pattern gets a sibling `boolean(key, fallback)` helper, since this is the first boolean `[w5]` key). `mode: "inferred"` is an escape hatch that disables the verifier path entirely and restores today's classifier behavior file-wide (matched/proposed quest, `which_quest`/`why`/`trigger` questions) regardless of any declarations present — useful for comparing declared vs. inferred behavior on the same window set via `w5 eval --declare` (below), and for a deployment that isn't ready to adopt declarations yet. `runOnce` (`runner.ts:86`) and `backfill` (`backfill.ts:105`) both branch on `intentConfig.mode` once, near the top, to decide which `ClassifierWindow` shape to build and which `apply.ts` code path to run — this is the only new branch point in either file; everything else in this spec is inside `window.ts`/`apply.ts`/`classifier.ts`, which already take `W5Config`-derived values as plain function inputs.

## Reports

`queryActivities`/`queryQuests` (`report/intent-queries.ts:249,380`) add `origin_kind` to their selected columns and their row types (`ActivityRow`, already has `questId`/`questTitle`/`questConfirmed` — gains `questOriginKind: string | null`; `QuestSummaryRow` gains `originKind: string`), rendered in the markdown report as a suffix on the quest title (e.g. "Security audit _(inferred)_") only when `originKind !== "declared"` — a declared quest is the expected case and gets no annotation, matching the existing convention where `questConfirmed` is only called out when `false`. The weekly table (wherever side quests are rendered — `querySideQuests`, `report/intent-queries.ts:299`) gains a `doubts` column next to the existing side-quests count, sourced from `COUNT(*) FROM questions WHERE kind = 'belongs' AND session in range`. `tempad review` (`runReview`, `w5/cli.ts:229`) is unchanged in code (it already renders expired questions generically) but now also naturally lists `declare`-kind expired questions, since those are just another `kind` value in the same table.

## Evaluation

`tempad w5 eval` (`packages/core/src/w5/eval.ts`) gains `--declare <file>`: a TOML or JSON file listing `{ session_id: string; at: string; quest?: string; new?: { title: string; objective: string; commitment: string; project?: string } }[]`. `runEval` (`eval.ts:267`), after `copyDatabase` and before `resetRange`, applies every entry in the file as a `quest.declared` (plus `quest.created` when `new` is given) event against the **copy** — so history can be evaluated in declared mode without the source database ever holding hand-authored declarations. `EvalOptions` gains `declareFile?: string`; when absent, the eval runs in whatever `intentConfig.mode` the loaded `tempad.toml` specifies (defaulting to `"declared"`, meaning an eval run with no `--declare` file and no declarations already in history exercises the "no declaration" `declare`-question path for every session, which is a valid and informative eval case — it quantifies how much of history is currently un-declarable).

`EvalMetrics` (`eval.ts:92`) renames `questConflicts` to `doubts`, adds `doubtsAnswered: number` and `tracesUnattributed: number` (queried the same way the report-layer versions are, over the copy, in range), and drops nothing else — `traces`, `activities`, `ratio`, `medianActivityDurationMinutes`, `continuesLinks`, `unknownActivityIds`, `overlapDropped`, `questProposedOnMatched`, `selectorDefaulted`, `selectorAmbiguous` are all still meaningful in declared mode (the last few are properties of the activity selector, unchanged by this spec) and keep their exact current names.

## Open questions

None blocking.
