# Intent model and the w5 hook

Status: plan 1 implemented (intent core: event store, projections, rebuild, config, CLI for hero/parties/clients/goals/quests/activities/traces/questions/answer/time-travel). Plan 2 (w5 hook: job queue, classifier, window builder, apply, question state machine, runner/CLI, hook scripts, backfill) implemented, including a `claude-cli` classifier backend (`src/w5/classifier-cli.ts`) that runs classification through the local `claude -p` CLI on the operator's subscription — the default, needing no `ANTHROPIC_API_KEY` — alongside the original `api` backend, selected via `[w5].backend` in `tempad.toml`. Plan 3 (intent reports) not started. Date: 2026-09-05. Builds on `2026-09-04-core-collectors-design.md` (collectors, mirrors, reports), which stays valid.

## Goal

Turn raw evidence (sessions, commits, Monday items) into an honest record of what the Hero did, why, and where attention branched, so behavior can be seen and changed. Reporting is a by-product. This is a self-awareness tool, not a surveillance tool: it never blocks a session, asks rarely, and never rewrites history.

Out of scope: goals-and-drift advice, the TUI, timesheet export. They consume this model later.

## Domain language

Definitions as in the README, with the additions agreed on 2026-09-05:

- **Hero**: you. The root everything hangs from. The most stable entity; parties and goals come and go around it.
- **Party**: a group the Hero belongs to, with a membership span (joined, left). Examples: Mosaic, saulo.engineer.
- **Client**: who a project is for. Not a party. Example: LiUNA is the client of a Mosaic project.
- **Goal**: a direction, not a finish line. Owned by the Hero or by a Party.
- **Quest**: something set out to finish; has a done condition, a deadline and a budget. Owned by the Hero or a Party; serves at most one Goal. A Quest with an origin is a **Side Quest** and carries its **Nexus Event** (from which activity, when, trigger, returned).
- **Activity**: a stretch of attention with one objective. Belongs to at most one Quest.
- **Trace**: one piece of evidence a Tool saw at a Place at a time, attached to at most one Activity.
- **Project**: an undertaking with a name, people, and places. Has one Party (who does it) and optionally one Client (who it is for).
- **Place**: one spot where work leaves a trace; belongs to one Project, reached through one Tool.
- **Tool**: what work goes through: Claude Code, git, GitHub, Monday, browser.

Rule of thumb: Goals give direction, Quests are planned, Activities are what happened, Traces are the proof, Places are where, Tools are how, Projects are whose and what for.

Relations:

```
Hero 1 ─── * Membership * ─── 1 Party
Hero | Party 1 ─── * Goal
Hero | Party 1 ─── * Quest        Quest * ─── 0..1 Goal
Quest 0..1 ◄── origin ── Quest    (Side Quest; origin is the Activity it branched from, kept on the Nexus Event)
Quest 1 ─── * Activity
Activity 1 ─── * Trace
Party 1 ─── * Project             Project * ─── 0..1 Client
Project 1 ─── * Place             Place * ─── 1 Tool
Trace * ─── 1 Place
```

The organization of a Trace is derived from its Place's Project's Party; the organization of intent is derived from the owner of the Quest or Goal. A mismatch (learning Marko for a client project while the quest is a saulo.engineer goal) is allowed and reportable.

## Storage: event-sourced intent, mirrored evidence

Two kinds of data with different rules.

**Mirrors** (existing): `gh_repos`, `gh_commits`, `gh_pull_requests`, `monday_items`, `claude_sessions`, `claude_messages`. Upserted copies of external systems that may rewrite their own history. Unchanged by this spec except for the mapping to Places (below).

**Events** (new): one append-only table is the source of truth for intent and judgment.

```sql
CREATE TABLE events (
  id          INTEGER PRIMARY KEY,
  at          TEXT NOT NULL,                 -- ISO UTC, when the fact became true
  recorded_at TEXT NOT NULL,                 -- ISO UTC, when it was written
  actor       TEXT NOT NULL,                 -- hero | assistant | hook | backfill | system
  session_id  TEXT,                          -- Claude session that produced it, when any
  kind        TEXT NOT NULL,                 -- see catalog
  subject     TEXT NOT NULL,                 -- entity id the event is about (ULID)
  payload     TEXT NOT NULL                  -- JSON, shape per kind
);
CREATE INDEX events_subject ON events(subject, at);
CREATE INDEX events_kind ON events(kind, at);
```

Entity ids are ULIDs generated at creation and never reused. Events are never updated or deleted. A wrong event is corrected by a later event (`*.retracted` with the id it retracts).

Projections (current-state tables) are rebuilt from events by `tempad rebuild` and incrementally updated as events are appended: `heroes`, `parties`, `memberships`, `clients`, `goals`, `quests`, `activities`, `traces`, `trace_links`, `questions`. Reports read projections only. Replaying events up to a date gives the state at that date (`tempad report ... --as-of`), which is how "my goals in August" works.

### Event catalog (v1)

Wording events carry `revision` so identity survives rewording; meaning changes create a new entity.

| kind                                                        | payload                                                                                                                                                                     | notes                                                       |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `hero.created`                                              | name                                                                                                                                                                        | exactly one                                                 |
| `party.created` / `party.reworded`                          | name, description                                                                                                                                                           |                                                             |
| `membership.joined` / `membership.left`                     | hero, party, reason                                                                                                                                                         | spans                                                       |
| `client.created`                                            | name                                                                                                                                                                        |                                                             |
| `project.created` / `project.updated`                       | name, party, client                                                                                                                                                         | projects are config-like; updated allowed                   |
| `place.opened` / `place.closed`                             | project, tool, kind, locator, meta                                                                                                                                          | closed, never deleted                                       |
| `goal.created` / `goal.reworded` / `goal.ended`             | owner, title, statement, reason (`achieved`, `replaced`, `abandoned`), `replaced_by`                                                                                        | ending keeps everything attached                            |
| `quest.created` / `quest.reworded` / `quest.ended`          | owner, goal, title, objective, done_condition, due, budget_minutes, commitment (`promised`, `personal`, `exploratory`), confirmed (bool)                                    | `confirmed=false` when proposed by the hook                 |
| `quest.confirmed` / `quest.merged`                          | into                                                                                                                                                                        | merge keeps both ids; the merged one resolves to the target |
| `quest.lifecycle`                                           | state (`started`, `paused`, `resumed`, `done`, `abandoned`), reason                                                                                                         | current state = latest                                      |
| `quest.branched`                                            | from_activity, at, trigger, kind (`curiosity`, `blocker`, `interruption`, `boredom`, `unknown`)                                                                             | the Nexus Event; makes the quest a Side Quest               |
| `quest.returned`                                            | to_quest, at                                                                                                                                                                | closes the branch                                           |
| `activity.opened` / `activity.reworded` / `activity.closed` | quest, objective, outcome (`done`, `parked`, `abandoned`, `unknown`)                                                                                                        |                                                             |
| `activity.assigned`                                         | quest                                                                                                                                                                       | re-linking an activity to another quest                     |
| `trace.recorded`                                            | activity, tool, place, source (`session`, `commit`, `monday_item`, `pull_request`), source_ref, started_at, ended_at, who, what, why, where, how, confidence, classified_by | immutable; the w5 entry                                     |
| `trace.relinked`                                            | activity, reason                                                                                                                                                            | previous link kept in history                               |
| `question.asked` / `question.answered` / `question.expired` | trace, text, answer, answered_by                                                                                                                                            | hand-back loop                                              |
| `*.retracted`                                               | retracts (event id), reason                                                                                                                                                 | correction                                                  |

### Edit intent

The CLI never accepts a bare edit on a goal or quest that has attachments. It requires `--reword` (new revision, same id) or `--replace` (new id, old one ended with `replaced`, attachments stay on the old one). Rewording an entity without attachments is allowed silently.

## Config changes

`tempad.toml` gains the intent side; collectors keep reading their existing sections until the `[[places]]` migration lands (roadmap).

```toml
[hero]
name = "Saulo Vallory"

[[parties]]
slug = "mosaic"
name = "Mosaic Strategies"
joined = "2025-07-01"

[[parties]]
slug = "saulo-engineer"
name = "saulo.engineer"

[[clients]]
slug = "liuna"
name = "LiUNA"

[[projects]] # existing path rules keep their shape; these fields are new and optional
pattern = "~/work/mosaic/:project/:rest*"
org = "mosaic" # org is read as the party slug
client = "liuna" # optional, per rule

[w5]
model = "claude-haiku-4-5-20251001"
throttle_minutes = 10 # min gap between classifier runs per session
watch_turns = 3 # turns to wait before an unclear item may be asked about
ask_min_activity_minutes = 20
ask_budget_minutes = 30 # at most one ask per session per this window
ask_expire_turns = 2 # unanswered asks go to review after this many turns
backfill_days = 15
```

Every threshold above is configurable; the numbers are the agreed defaults. `org` in existing tables and reports is interpreted as the party slug; no rename in v1.

## The w5 hook

Three Claude Code hooks, installed by `tempad hook install` into `~/.claude/settings.json` (user scope) or a project's `.claude/settings.json`:

- `Stop`: appends a `classify` job for the session unless the last run for that session is younger than `throttle_minutes`. Returns immediately.
- `PreCompact` and `SessionEnd`: append a forced `classify` job (throttle ignored).
- `UserPromptSubmit`: if the session has pending questions in `asked` state, returns them as `additionalContext` (below). Otherwise returns nothing.

Jobs live in a `jobs` projection (`id`, `session_id`, `kind`, `requested_at`, `forced`, `state`). The hook spawns `tempad w5 run --detached` if no runner is alive (lock file under `TEMPAD_HOME`); the runner drains the queue and exits when idle. The hook never waits for the model. Failures never surface to the session; they are logged under `TEMPAD_HOME/logs/`.

### Classifier run

For one session job:

1. Sync the session file first (the Claude collector on that file only), so `claude_messages` is current.
2. Build the window: messages since the last trace for this session (or the last `throttle_minutes` × 3 of messages on the first run), plus the session title, cwd, branch, resolved Place and Project, and the open quests for that Party and for the Hero (title, objective, last activity time), plus the last trace's activity.
3. Ask the model (Haiku by default, `[w5].model`) for a JSON answer: a list of segments, each with `started_at`, `ended_at`, `what` (one line), `why` (one line or `unknown`), `matched_quest` (id or null), `proposed_quest` (title, objective, commitment) when none matches, `matched_activity` (id or null), `is_switch` (bool: objective differs from the previous trace), `trigger` (sentence from the transcript when `is_switch`), `confidence` (0-1), and `questions` (what it could not tell: `which_quest`, `why`, `trigger`).
4. Append events: `activity.opened` or reuse, `quest.created` with `confirmed=false` when proposed, `quest.branched` when `is_switch` and the new objective does not belong to the previous quest, `trace.recorded` per segment, `question.asked` per unresolved question that passes the ask rules below.
5. Record the run on the job.

Model choice per run is configurable; Sonnet may be selected for forced runs (`SessionEnd`) where the window is long.

### Hand-back rules (A with C)

- A question is not asked immediately. It enters `watching` with a turn counter. Each later run re-evaluates it; if the new window resolves it (the same quest continues, the next prompt explains the switch), it is closed as `resolved_by_context`.
- After `watch_turns` turns still unresolved, it becomes `asked` only if it is a suspected side quest (`is_switch` with no matching quest) or the session has `ask_min_activity_minutes` of activity with no known quest. Unknown `why` on a continuing quest is never asked; it expires straight to review.
- Ask budget: one `asked` question per session per `ask_budget_minutes`; never two in a row; `tempad quiet <duration>` suppresses all asks.
- Asked questions are delivered by the `UserPromptSubmit` hook as `additionalContext`:

  > TemPad noticed a switch from "<previous objective>" to "<current objective>". If you can tell from context which quest this serves and why, answer with `tempad answer <id> --quest <id|new:"title"> --why "…"`. If you are not sure, ask the user in one short line, framed as awareness, not justification ("Side quest, or new direction? One word is enough."), then record their answer the same way.

- The assistant answering on its own marks the trace `classified_by: assistant`; a configurable sample of those goes to the review queue.
- Unanswered after `ask_expire_turns` turns: `question.expired`, no re-ask that session, item lands in `tempad review`.

### `tempad review`

Lists expired questions, unconfirmed quests, low-confidence traces and assistant-classified samples, oldest first, and lets the Hero confirm, merge, rename (with edit intent) or link in one command per item. Designed for a weekly pass; nothing in it is urgent.

## Backfill

`tempad w5 backfill --days 15` walks sessions with `ended_at` in the last 15 days, oldest first, and runs the classifier with `actor=backfill`, forced windows of at most `throttle_minutes` × 3 of messages, and asks disabled (everything unclear goes to review). Quests it proposes are unconfirmed. Idempotent: a session already covered by traces up to its `ended_at` is skipped. Cost estimate for 15 days of this Hero: roughly 150 sessions, a few dollars on Haiku, under 20 minutes.

## CLI additions

```
tempad hero init "Saulo Vallory"
tempad party add mosaic "Mosaic Strategies" --joined 2025-07-01
tempad party leave mosaic --reason "..."
tempad client add liuna "LiUNA"
tempad goal add --owner hero|party:<slug> "title" --statement "..."
tempad goal reword <id> "title" | tempad goal replace <id> "title" --reason ...
tempad goal end <id> --reason achieved|abandoned
tempad quest add --owner ... --goal <id> "title" --objective "..." --done "..." --due 2026-09-20 --budget 30h --commitment promised
tempad quest confirm|merge|pause|resume|done|abandon <id> [--reason]
tempad activity list --open
tempad answer <question-id> --quest <id|new:"title"> --why "..."
tempad quiet 2h
tempad review
tempad w5 run [--detached] | tempad w5 backfill --days N | tempad hook install|uninstall
tempad rebuild
tempad report daily|project|hourly ... --as-of <date> --party <slug> --client <slug>
```

## Reports

Existing report kinds gain, when intent data exists: quest and activity lines per project per day, side-quest count and minutes per day with their triggers, time on unconfirmed quests, and a `--as-of` switch. A new `weekly` kind: per weekday, per project, activities and quests touched, shipped versus abandoned, side-quest share. None of this is required for the hook to ship; it is the first consumer.

## Error handling

- Hook scripts exit 0 in every case and write errors to the log; a broken classifier must never break a session.
- Model responses that fail JSON validation are retried once with the validation error appended, then dropped with a log entry and a `question.asked`-free trace marked `confidence: 0`.
- Rebuild is transactional: projections are rebuilt into shadow tables and swapped.
- Config validation lists every problem at once (unknown party slug on a project, missing hero).

## Testing

- Event store: append, replay to a date, retraction, rebuild equals incremental state (property test over random event sequences).
- Edit intent: bare edit refused with attachments; reword keeps id; replace ends old and links new.
- Classifier: the model is behind an interface; tests inject canned JSON and assert the events produced for: continuing quest, proposed quest, side quest with trigger, unclear why (never asked), unclear switch (asked after `watch_turns`), ask budget, quiet period, expiry.
- Hooks: shell-level tests invoking the hook scripts with sample `Stop`/`UserPromptSubmit` payloads and asserting queue state and `additionalContext` output; runner spawn lock.
- Backfill: idempotence over a fixture set of sessions; asks disabled.
- Reports: golden files with intent data, including `--as-of`.

## Decomposition

Three implementation plans, in order:

1. **Intent core**: event store, projections, rebuild, config for hero/parties/clients, CLI for goals, quests, parties, edit intent. No model calls.
2. **w5 hook**: jobs, hooks, runner, classifier behind an interface, hand-back rules, `answer`, `quiet`, `review`.
3. **Backfill and reports**: backfill command, report additions, `weekly` kind, `--as-of`.

## Open questions

None blocking. Two choices made here that are easy to reverse later: ULIDs for entity ids, and `org` kept as the column name for party slug in existing tables.
