# Activity continuity

Status: not started. Date: 2026-09-06. Extends `docs/specs/2026-09-05-intent-model-and-w5-hook-design.md` ("Domain language", "Event catalog", "The w5 hook", "Backfill") — read that first; this spec does not repeat its event catalog or hook wiring, only what changes.

## Goal

Make an activity mean what the domain language already says it means: one objective pursued in a session over a span, which may interleave with other activities of the same session. Today it means one classifier window, because the classifier has no memory of anything before the last trace of the current session. Fix the classifier's inputs (a recent-context slice instead of one trace) and the activity lifecycle (activities close by idle or session end, and returning to an objective after it closed opens a new activity that says so) so `matchedActivity` and `continues` actually get set. Reporting benefits are a side effect, not the goal.

Out of scope: goals-and-drift advice, the TUI, a persistent memory store separate from events, changing `quest.branched`/side-quest semantics.

## Problem (verified against the real database)

- The classifier prompt carries only one `previousTrace` (the last trace of the _session_) and the open quests. It never sees prior activities — same session, earlier window, or other sessions on the same project — so it essentially never has a candidate to match against. Result: 2166 activities for 2217 traces. An activity today means one classifier window, not one stretch of attention.
- `apply.ts`'s `resolveActivityForSegment` (`packages/core/src/w5/apply.ts:88`) reuses `matchedActivity` only when the activity's stored `quest_id` equals the segment's `matchedQuest` exactly (including both-null); any mismatch silently opens a new activity instead of keeping the activity and flagging the disagreement.
- Nothing in `runner.ts`, `backfill.ts`, or `apply.ts` ever appends `activity.closed`. "Open" carries no meaning — every activity from the beginning of time is still open.
- `backfill.ts`'s `chunkByWindow` cuts sessions into fixed `throttleMinutes * 3`-minute chunks with no overlap (`packages/core/src/w5/backfill.ts:66`), so a stretch of attention that straddles a chunk boundary is split into two activities with no way to tell they were one thing, and the classifier never sees the tail end of the previous chunk to judge continuity.

## Domain rule

An activity is one objective pursued in a session over a span; it may interleave with other activities of the same session. It ends only by the idle rule or by session end — not by switching to another activity. Returning to the same objective after it closed opens a **new** activity that records `continues: <closed activity id>` and normally keeps the same quest. There is no pause state: a pause is the gap between traces and is derivable from `closed_at` and the next activity's `opened_at`. Reports may chain `continues` links ("returned to X after 2h").

## Memory: a slice of recent data, no separate store

The event store is the memory; there is no new store, no cache invalidation problem, no separate write path to keep in sync. At classify time `buildWindow` (`packages/core/src/w5/window.ts`) assembles a **recent-context slice** from the existing projections (`activities`, `quests`, `traces`, `w5_runs`) instead of the single `previousTrace` row it reads today:

1. **Open activities of this session**: id, `what` (objective), `why` (from its latest trace), quest id and title, `opened_at`, and the `ended_at` of its last trace.
2. **Recent activities in the same project across sessions**: open or closed within the last `[w5].memory_hours` (default 8) hours, capped at `[w5].memory_activities` (default 10), newest first, same fields plus `closed_at` and the close `reason`. This is what lets "back to the walk-order bug after lunch" match an activity closed by an earlier session's `SessionEnd`.
3. **Open quests**, as today, plus the last 3 side quests (quests with `origin_activity_id` set) touched in the project, with their `trigger` sentence — so a side quest from two hours ago can be matched or returned to instead of re-proposed.
4. **Overlap tail**: the last `[w5].overlap_messages` (default 3) messages before the window's start, included in the prompt under a heading that says they are context only and must not themselves be classified into segments. `apply` drops any segment `applyResult` receives whose `startedAt`/`endedAt` falls entirely inside the overlap range (belt-and-braces against a model that classifies the overlap anyway).
5. **Session note**: the classifier additionally returns a top-level `sessionNote` (string, at most 300 characters, one or two sentences on where the session is heading and anything the user said they would come back to). It is stored on `w5_runs.session_note` and fed back on the next run of the same session under a "Your note from the previous run" heading. It is not an event and is not rebuilt by `tempad rebuild` — it is scratch space for the classifier, not part of the intent record — and it is cleared (`session_note = NULL`) when `SessionEnd` closes the session. Backfill uses it too: `backfill.ts` already processes one session's windows in chronological order, so the note written by window _n_ is available to window _n+1_ the same way a live run's note carries across hook invocations.

None of this needs a new table beyond the `session_note` column (task 1) and the `continues` column (task 1); the slice is assembled by queries in `window.ts` (task 2) against tables that already exist.

## Prompt and output changes

- The candidate list handed to the model is explicit, not implicit in prose: for each segment the model must set exactly one of `matchedActivity` (an open activity id present in the slice), `continuesActivity` (a _closed_ activity id present in the slice, when the objective is the same after a gap), or `newActivityReason` (a one-sentence reason none of the candidates fit). The system prompt states that reusing an existing activity is the default and that opening a new one requires a reason — this is the single biggest lever on the 2166/2217 ratio, since today the model has no candidates to reuse in the first place.
- `matchedQuest` / `proposedQuest` are unchanged in shape and meaning. When `matchedActivity` is set and `matchedQuest` differs from that activity's stored quest, `apply` keeps the activity and its existing quest, records the trace on it as usual, and counts a `questConflict` in the run's summary (a log line, not an event — the activity's quest is not silently reassigned, and no new activity is opened over a quest disagreement).
- `isSwitch`, `trigger`, `questions`, `confidence` are unchanged.

This changes `ClassifierSegment` (`packages/core/src/w5/classifier.ts`): `matchedActivity: string | null` stays, gains a sibling `continuesActivity: string | null`, and gains `newActivityReason: string | null`. Validation (`validateResult` in the same file) enforces "exactly one of the three is non-null" per segment as a new problem class.

## Activity lifecycle (emitted by w5, event-sourced)

TemPad tracks the attention of the human, not of the agent. One session (a team lead coordinating two quests, a session running parallel subagents) legitimately holds several activities open at once. Therefore:

- An activity is one objective pursued in a session over a span; it may interleave with other activities of the same session.
- An activity closes only by the per-activity idle rule (last trace older than `[w5].activity_idle_minutes` before the window start) or by session end. A switch closes nothing. `isSwitch` only marks the nexus event for side-quest branching (`quest.branched` with `from_activity` = the previous segment's activity) — appended only when the segment's quest is not already open in the session; returning to a quest already in flight is not a nexus event.
- Time accounting sums trace minutes, never activity spans, so overlapping activities cannot double count.
- `activity.closed` payload keeps `reason: "idle" | "session_end" | "switch"` for existing events (the `switch` reason is no longer emitted, but stays in the enum and projection so old events still read correctly). The existing `outcome` field (`done | parked | abandoned | unknown`) stays optional and orthogonal — `reason` is _why the activity stopped being open_, `outcome` is a judgment about how it went, and the two are set independently (an idle-closed activity can later be given `outcome: done` by the hero).
- `quest.branched`'s `kind` enum gains `waiting` (switched because a process or agent was running), alongside `blocker`, `curiosity`, `unknown`.
- **idle**: at the start of every run (hook run or a single backfill window), every open activity of the session whose last trace's `ended_at` is more than `[w5].activity_idle_minutes` (default 45) before the window's start closes with `reason: "idle"`, `closed_at` equal to that last trace's `ended_at`. This runs before classification, so the classifier's "open activities of this session" slice (memory item 1, above) never contains an activity that should already have been closed by idleness.
- **session_end**: the `SessionEnd` hook kind closes every still-open activity of the session after classifying that final window, `closed_at` equal to the last trace's `ended_at`; it also clears `w5_runs.session_note` for that session.
- `activity.opened` payload gains an optional `continues: <activity id>` (the closed activity being returned to); the `activities` projection gains a nullable `continues` column populated from it. This is distinct from `quest.branched`'s `from_activity`: `continues` says "this is the same objective as that closed activity, later," `from_activity` says "this new quest was discovered while doing that activity." An activity can carry both `quest_id` unchanged and a `continues` link at once (returning to the same objective and the same quest after a gap).

### Config changes

Four new keys, all under `[w5]` in `tempad.toml` / `tempad.example.toml`, all documented in `CLAUDE.md`:

| key                     | default | meaning                                                                                                               |
| ----------------------- | ------- | --------------------------------------------------------------------------------------------------------------------- |
| `activity_idle_minutes` | 45      | minutes since an activity's last trace `ended_at` before it closes with `reason: "idle"` at the start of the next run |
| `memory_hours`          | 8       | how far back the cross-session recent-activities slice (memory item 2) looks                                          |
| `memory_activities`     | 10      | cap on how many cross-session activities the slice carries                                                            |
| `overlap_messages`      | 3       | messages before the window start included as non-classified context                                                   |

## Evaluation

`tempad w5 eval --from <date> --to <date> [--db <path>]`:

1. Copies the real database (`--db` when given, else `TEMPAD_HOME/tempad.db`) to `<TEMPAD_HOME>/scratch/eval-<timestamp>.db`. The real database is never opened for writing by this command.
2. Reruns `runBackfill` for `[from, to]` against the copy with a new `force: true` option that ignores `w5_windows` coverage entirely (classifies every window in range regardless of what the source database already recorded) — this is the only way to compare the new classifier/lifecycle behavior against history without retracting anything.
3. Prints: trace count, activity count, activities/traces ratio, median activity duration in minutes (from `opened_at` to `closed_at`, activities never closed excluded), count of `continues` links, count of quest conflicts (summed from the run summaries), and 20 randomly sampled activities (`what`, `why`, quest title, duration, session title) for a hand check.

Success target for the batch: activities/traces ratio under 0.4 on 2026-09-01..2026-09-03 (the ratio today, per the Problem section, is close to 1.0).

## Testing

- Lifecycle (`lifecycle.ts`, task 1): idle-close picks the right activities and leaves recently-active ones open; a switch closes nothing; session-end closes every open activity of the session and clears the note; `continues` is stored and read back on the `activities` projection.
- Classifier memory (task 2): `buildWindow` assembles the four-part slice correctly bounded by `memory_hours`/`memory_activities`/`overlap_messages`; `validateResult` rejects a segment with zero or two of `matchedActivity`/`continuesActivity`/`newActivityReason` set; `apply.ts` matches `matchedActivity` (same session), `continuesActivity` (opens a new activity with `continues` set, same quest by default), records a `questConflict` without reassigning the quest, drops segments inside the overlap tail, branches only when a switch's quest is not already open in the session, and round-trips `sessionNote` through `w5_runs`.
- Eval (task 3): `force` on `runBackfill` reclassifies windows already present in `w5_windows`; the eval command computes the reported metrics correctly against a small fixture database and never writes to the path passed as the real database.

## Open questions

None blocking.
