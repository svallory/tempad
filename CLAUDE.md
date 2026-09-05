# TemPad

Reconstructs work history (hour by hour) from git, Monday.com and Claude Code session transcripts into SQLite, then generates timesheet reports.

## Layout

- `packages/core` — TypeScript library + `tempad` bin: schema, collectors, reports. Bun runtime, `bun:sqlite`.
- `apps/` — runnable programs. A Go TUI (charmbracelet) is planned.
- `libs/` — private bundle-time packages. Never published.
- `docs/specs/` — design specs. Read the relevant spec before changing a subsystem.

Runtime data never lives in the repo. `TEMPAD_HOME` (default `~/.tempad`) holds `.env`, `tempad.toml`, `tempad.db`, `repos/`, `reports/`.

## Commands

```sh
bun install
bun run lint          # biome check
bun run fmt           # biome + dprint write
bun run typecheck
bun test
moon run :test        # same through moon
```

## Conventions

- Package manager: bun. Never npm.
- Biome for JS/TS/JSON. dprint for Markdown/TOML/YAML. Go uses gofmt.
- Full words in identifiers (`repository`, not `repo`, in code; `repos/` as a directory name is fine).
- Environment variables that are required have no defaults; missing ones throw at startup.
- Tests in `bun test`, colocated as `*.test.ts`. Fixtures under `packages/core/test/fixtures`.
- Commits: `type(scope): summary`.

## CLI

- `tempad sync [monday|github|claude] [--full]` — `--full` clears that source's `sync_state` row before syncing, so the collector ignores the last-sync cursor and rescans everything back to `SINCE` (or, for Claude, re-reads every session file regardless of mtime). Use it to backfill columns added by a migration (e.g. `title_source`) on rows a normal incremental sync wouldn't touch.
- `tempad report <daily|project|hourly|weekly> --from <date> --to <date> [--org X] [--project Y] [--out path] [--as-of <iso>] [--party <slug>] [--client <slug>]`
- Intent layer: `tempad hero init`, `tempad party add|leave|list`, `tempad client add`, `tempad goal add|reword|replace|end|edit|list`, `tempad quest add|reword|replace|end|edit|confirm|merge|pause|resume|done|abandon|branch|return|list`, `tempad activity list`, `tempad trace list`, `tempad answer`, `tempad rebuild [--until <iso>]`. See "Intent layer" below.
- w5 hook: `tempad w5 enqueue --session <id> [--forced]`, `tempad w5 context --session <id>`, `tempad w5 run [--detached]`, `tempad w5 hook install|uninstall [--scope user|project]`, `tempad w5 dedupe [--dry-run]`, `tempad quiet <2h|30m>`, `tempad review`. See "w5 hook" below.

## Intent layer

Hero, parties, clients, goals, quests, activities, traces and questions are event-sourced: `packages/core/src/intent/`.

- **Events are append-only.** One `events` table (`packages/core/src/db/migrations/0003_events.sql`) is the source of truth; SQLite triggers reject `UPDATE`/`DELETE` on it. A wrong fact is corrected by a later event, never by editing history.
- **Projections are rebuildable.** Current-state tables (`heroes`, `parties`, `memberships`, `clients`, `goals`, `quests`, `activities`, `traces`, `trace_links`, `questions`) are plain SQLite tables derived from events by pure reducers in `src/intent/projections/*.ts`. `tempad rebuild [--until <iso>]` truncates and replays them; this is always safe to run. Rebuilding `--until <date>` leaves the live projections showing state as of that date — the command prints `projections now reflect state as of <date>; run tempad rebuild to restore` as a reminder to re-run `tempad rebuild` with no `--until` afterward.
- **Edit intent rule.** The CLI refuses a bare edit (`goal edit` / `quest edit`) on a goal or quest that has attachments (a quest on a goal, an activity on a quest) — the caller must instead use `reword` (same id, new revision) or `replace` (new id, old one ended with `reason: "replaced"`), both of which are allowed even with attachments since they express an explicit wording- or meaning-change intent. The refusal message names the real subcommands, e.g. `goal <id> has attachments; use tempad goal reword <id> "<title>" or tempad goal replace <id> "<title>" --reason ...`. See `src/intent/edit-intent.ts`.
- **Time travel.** `stateAsOf(database, until)` (`src/intent/time-travel.ts`) rebuilds projections into a fresh in-memory database from events up to a date; `goal list --as-of <iso>` and `quest list --as-of <iso>` use it to answer "what were my goals in August".

## w5 hook

Claude Code hooks (`Stop`, `PreCompact`, `SessionEnd`, `UserPromptSubmit`) enqueue classification jobs without ever blocking a session: `packages/core/hooks/w5-stop.sh` and `w5-prompt.sh` shell out to `tempad w5 enqueue`/`tempad w5 context` and always exit 0, logging failures to `TEMPAD_HOME/logs/w5.log` instead of surfacing them. `tempad w5 hook install|uninstall` (`src/w5/hooks.ts`) merges these into `~/.claude/settings.json` (or `.claude/settings.json` with `--scope project`) alongside any other hooks, marking its own entries so uninstall only removes those.

A detached `tempad w5 run` drains queued jobs: for each it re-syncs the one session file, builds a window of messages since the last run (`src/w5/window.ts`), classifies it, and applies the result as intent events (`src/w5/apply.ts`) — reusing or opening activities, proposing unconfirmed quests, branching on a detected switch. `src/w5/questions.ts` runs the hand-back rules: a question watches for `watchTurns` turns before it's asked, `why` questions on an activity that already has a quest expire straight to `tempad review` instead of asking, and an ask budget plus `tempad quiet <2h|30m>` keep it from asking too often.

**Classifier backend.** `[w5].backend` in `tempad.toml` is `"claude-cli"` (default) or `"api"`. `"claude-cli"` (`src/w5/classifier-cli.ts`, `ClaudeCliClassifier`) shells out to the local `claude -p` CLI in print mode with `--safe-mode --no-session-persistence --output-format json --tools ""`, prompt on stdin, cwd forced to `TEMPAD_HOME` (never the repo — no project `CLAUDE.md` or hooks leak in), so classification rides the operator's Claude subscription and never needs `ANTHROPIC_API_KEY`. `[w5].claude_command` overrides the binary name/path (default `"claude"`). `[w5].timeout_seconds` (default `180`) bounds a single classify request for both backends — the CLI backend kills the child process and the API backend aborts the fetch after this many seconds; `tempad w5 backfill` retries a window once on any classify failure (on top of the classifier's own JSON retry) before counting it failed. `"api"` (`src/w5/classifier.ts`, `AnthropicClassifier`) keeps the original behavior: POSTs to the Anthropic Messages API and requires `ANTHROPIC_API_KEY`. Both backends share the JSON-extraction/validate/retry-once loop in `src/w5/classifier-shared.ts`. `ANTHROPIC_API_KEY` is only ever required when the backend is `"api"`; `loadConfig` never requires it, so hooks run fine without it (they just log and no-op) and the default `claude-cli` backend never touches it.

**Backfill resilience.** `tempad w5 backfill` (`src/w5/backfill.ts`) classifies each session's windows independently: a window that throws (after one retry) is logged as `backfill: failed <session> window <n>: <message>`, counted in `failed`, and does not stop the rest of that session or later sessions. The "already covered" check queries an explicit `w5_windows` table (`session_id, started_at, ended_at`), populated by a `window.classified` event appended right after a chunk is successfully applied (`src/intent/projections/window.ts`) -- not by looking at the traces a chunk produced, since a chunk the classifier splits into 2+ segments yields 2+ traces, none of which individually spans the chunk's exact bounds. A session partially processed by a crashed run only has its actually-classified windows skipped; the rest are (re)classified on the next run, so a crash never causes silent gaps or duplicate windows. Windows skipped this way are counted in `windowsSkipped`. The command exits 0 as long as at least one window was classified, and 1 only when every attempted window failed; the summary line is `classified=<sessions> windows=<succeeded> failed=<failed> skipped=<sessions already covered> windows_skipped=<windows already covered>`.

**Retractions.** Events are append-only, so a wrong or duplicate fact is corrected by a later `retracted` event, never by editing history. A `retracted` event's `subject` is the id of the row it retracts (a trace, activity, or quest id) and its `payload` carries `{ retracts: <event id>, reason }`; the `activities` and `quests` projections (`src/intent/projections/activity.ts`, `quest.ts`) each try an `UPDATE ... SET retracted_at = ? WHERE id = ?` for the tables they own, so exactly one table's row is ever touched per retraction. Reports (`src/report/intent-queries.ts`) and `tempad review`/`w5 review` filter `retracted_at IS NULL` throughout, so a retracted trace/activity/quest disappears from minutes, evidence, and review output without its history being erased.

**`tempad w5 dedupe [--dry-run]`** (`src/w5/dedupe.ts`) is the fix for the backfill duplication incident: it groups live traces by `(session_id, started_at, ended_at)`, keeps the earliest (lowest event id) trace in each duplicate group, and retracts the rest with reason `duplicate backfill window`. It then retracts activities left with no live trace and unconfirmed quests left with no live activity, both with reason `orphaned by dedupe`, cascading through whatever the trace retraction orphaned (e.g. a whole second activity/quest opened by a re-run of the same window). `--dry-run` computes and prints the same counts without writing. Safe to run repeatedly -- a clean database dedupes to `traces=0 activities=0 quests=0`.

## Gotchas

- Monday.com's API `people` column filter by numeric id returns nothing. Filter client-side by name or id from the column's JSON value.
- Claude session `.jsonl` files mix timestamped message lines with untimestamped metadata lines (`custom-title`, `agent-name`, `bridge-session`). Join them on `sessionId`.
- Git history rewrites: collectors re-scan an overlap window and delete rows whose sha is no longer reachable from any ref in the mirror.
