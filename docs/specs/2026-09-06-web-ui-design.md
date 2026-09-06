# Web UI design

Status: not started. Date: 2026-09-06. Builds on `2026-09-05-intent-model-and-w5-hook-design.md` (event store, projections, api.ts) and `2026-09-06-activity-continuity-design.md` (activity lifecycle, classifier memory). Docs only; no feature code in this change.

## Purpose

A live view of the Hero's day and week, replacing "stare at `tempad report` output in a terminal" with a page that updates itself, plus a way to turn a range of work into a shareable client report without leaning over someone's shoulder at a terminal. Two audiences, two trust levels: the Hero sees everything, including side quests, unconfirmed quests, and open w5 questions; a client sees only a finished, curated snapshot with no evidence of how the sausage got made.

Out of scope (per `notes/briefs/web-spec.md`): goals/drift UI, the TUI, Deel export, editing activities directly (activities are edited through intent events, not through this UI's forms — the UI only ever appends events the same way the CLI does).

## Views (hero-only, all under `/`)

- **Today** (`/`): live timeline of today's activities grouped by quest, the current open activity (if any) highlighted, side quests with their nexus trigger, and open w5 questions rendered as an inline answer form (`tempad answer` equivalent). This is the page meant to stay open in a tab.
- **Week** (`/week`): the same table `tempad report weekly` renders, with `party`/`client` filter controls that re-request the fragment server-side (no client-side filtering of already-fetched data).
- **Quests** (`/quests`): proposed (unconfirmed) quests with confirm / reword / merge / dismiss actions; confirmed quests below with progress (activity count, minutes, last evidence).
- **Reports** (`/reports`): build a client report — pick a client, a date range, preview the rendered HTML, then publish it to get a `/r/<token>` link.

Side quests, unconfirmed quests, and open questions appear only on Today/Quests (hero-only). Client reports (`/r/<token>`) never render them — see Data below.

## Architecture

### Request flow

`apps/web` is an Elysia app. Marko 6 components render full pages and partials; Elysia route handlers call `packages/core` query/API functions directly against the shared `bun:sqlite` database opened once at startup (`openDatabase(join(config.home, "tempad.db"))`, same as the CLI). No app-level SQL beyond what a Marko template needs to iterate rows already shaped by a core query — a query core doesn't yet have is added to core, not inlined in a route handler (per the brief's stack decision).

A hero-route request:

1. Elysia handler loads `config` (`loadConfig()`) and `intentConfig` (`loadIntentConfig`) once at boot, keeps them in app state.
2. Handler calls the relevant `packages/core` query (e.g. `queryActivities`, `querySideQuests`, `queryOpenQuestions` from `report/intent-queries.ts`, or a new query — see Data) with a `DateRange`/`ReportOptions`-shaped input.
3. Handler passes the rows to a Marko template (`.marko` file) which renders HTML server-side.
4. First load renders the full page (layout + content); subsequent SSE-triggered refreshes request the same route with a header/query flag (`?fragment=today-timeline`) that makes the handler render only the inner Marko partial, swapped into the DOM by a small (\<50 line) vanilla JS helper — no client framework, no virtual DOM.

### Live updates (SSE)

One endpoint, `GET /events`. On connect the server starts a poll loop: every `poll_seconds` (config, default 2) it runs `SELECT id, kind FROM events WHERE id > ? ORDER BY id ASC` against the last id it sent for that connection (starts at `SELECT MAX(id) FROM events` at connect time, so a client never replays history). For each new row it emits one SSE message:

```
event: intent
data: {"lastEventId": 4821, "kinds": ["trace.recorded", "activity.opened"]}
```

`kinds` is the distinct set of event kinds seen since the last message, deduplicated, so a burst of w5 apply events (which append several rows per classified window) becomes one message. The client-side script maps `kinds` to the page fragment(s) that need refreshing (a static table in the page: `trace.recorded`/`activity.*` → Today's timeline fragment, `question.*` → Today's questions fragment, `quest.*` → Quests fragments) and re-fetches only those fragment routes. No websocket (no bidirectional need — writes go through normal form POSTs), no client-side state store (the DOM fragment the server rendered is the state).

The endpoint is per-tab: each browser tab holds its own SSE connection and its own "last id sent" cursor; there is no shared server-side subscriber registry beyond the open HTTP connections Elysia already tracks. Reconnects (tab wakes from sleep, network blip) restart the poll from `MAX(id)` at reconnect time — the Today page's fragment refetch happens once on `visibilitychange`/reconnect regardless of what the SSE stream reports, so a missed message during a disconnect self-heals within one refresh instead of needing gap-filling logic in the stream itself.

### Writes

Every mutation (answer a question, confirm/reword/merge/dismiss a quest) is a normal HTML form `POST` to an Elysia route, which calls the matching `packages/core` function and redirects back (or, for a fragment-only interaction, returns the updated fragment HTML directly instead of a redirect). The app never opens `EventStore`/`applyIncremental` calls with hand-rolled payloads outside of what `packages/core` already exposes as a named function — see Data for which of these already exist versus need adding to core.

## Data

### Queries the app reads (already exist in `packages/core`)

- `queryActivities(database, range)`, `querySideQuests(database, range)`, `queryQuests(database, range)`, `queryOpenQuestions(database, range)`, `queryActivityTraceIntervals(database, range)` — all in `packages/core/src/report/intent-queries.ts`. `DateRange` (`report/queries.ts`) already carries `org`/`project`/`client`; the Week and Reports views pass `client` straight through for the client-scoped case.
- `resolveIntentDatabase(database, asOf)` — not used by the live views (they always want current state), but available if a later "as of" view is added; noted here so nobody re-derives it.
- `reports.get("weekly").render(...)` (`report/weekly.ts` via `report/index.ts`) for the Week view's table shape — the web Week view either calls `render` directly and embeds its Markdown-rendered output, or (preferred, since embedding pre-rendered Markdown-as-HTML in a Marko page is awkward to style) a new query function factored out of `weekly.ts` that returns the same rows `weekly.ts` computes, so the Marko template controls the HTML. **Open question**: which of these two paths — decided during implementation, not blocking the spec.

### Queries and API calls the app needs that do not exist yet (added to `packages/core`, not inlined)

- **Today's open activity + timeline query.** Nothing in `intent-queries.ts` answers "what is open right now" directly — `queryActivities` takes a `DateRange` and returns closed and open activities alike for that range, which is enough for Today (`range = { from: today, to: today, timeZone }`), but "the currently open activity" needs a `WHERE closed_at IS NULL` filter that today's callers don't need. Add `queryOpenActivity(database, options: { org?: string })` to `intent-queries.ts`: same shape as one `ActivityRow`, or `null`, picking the most recently opened row with `closed_at IS NULL AND retracted_at IS NULL`.
- **Open questions as rows, not a count.** `queryOpenQuestions` returns `number` (a count, used by the daily/project reports as a nudge). Today's page needs the actual question rows to render an answer form per question. Add `queryAskedQuestions(database, options: { org?: string })` returning `{ id, traceId, sessionId, text, isSwitch, activityObjective, questTitle }[]` for questions in state `asked` (see `questions` table columns noted in `db/schema.sql`'s comment block: `turns_at_ask`, `is_switch`; `state` and `text`/`trace_id` come from the `question.asked` event catalog in the intent-model spec). Ordered oldest-first, matching `tempad review`'s ordering rule.
- **Unconfirmed and confirmed quests as page data.** `queryQuests` in `intent-queries.ts` returns quests with evidence _in a date range_ — not the right shape for "list every unconfirmed quest regardless of when it last had evidence," which is what the Quests page's top section needs. Add `queryQuestsByState(database, options: { confirmed?: boolean; org?: string })` reading directly from the `quests` projection table (`retracted_at IS NULL`, optional `confirmed = ?`), returning `{ id, title, objective, confirmed, state, ownerKind, ownerId, activityCount, minutesTotal, lastEvidenceAt }` — `activityCount`/`minutesTotal`/`lastEvidenceAt` computed with a join to `activities`/`traces` unbounded by date, unlike the range-scoped helpers in `intent-queries.ts`.
- **Quest write actions.** `packages/core/src/intent/api.ts` has `openActivity`, `assignActivity`, `recordTrace`, `relinkTrace`, `askQuestion`, `answerQuestion`, `expireQuestion` — no `confirmQuest`/`mergeQuest`/`rewordQuest`/`dismissQuest`. Today those event kinds (`quest.confirmed`, `quest.merged`, `quest.reworded`, `quest.ended` with a dismiss-shaped reason) are appended inline in `packages/core/src/intent/cli.ts`'s `runQuestCommand` (`store.append({...})` directly), not through an `api.ts` function — `cli.ts` is the only current caller. Add four functions to `api.ts` mirroring `answerQuestion`'s shape (`(store, database, id, ...) => void`, using `applyIncremental`/`store.append` exactly as `cli.ts` does today) so the web app calls `packages/core` functions instead of either duplicating `cli.ts`'s inline event-append code or importing `cli.ts` itself (a CLI entrypoint module, not an API surface). `cli.ts`'s `runQuestCommand` is refactored to call these same functions, so there is exactly one place each event kind is appended from.
- **Answering a question.** `answerQuestion` already exists in `api.ts` and is reused as-is by Today's answer form handler.

### New table: `shared_reports`

```sql
CREATE TABLE shared_reports (
  token         TEXT PRIMARY KEY,        -- 32 random bytes, base64url
  client        TEXT NOT NULL,           -- client slug, from tempad.toml [[clients]]
  from_date     TEXT NOT NULL,           -- ISO date, report range start
  to_date       TEXT NOT NULL,           -- ISO date, report range end
  title         TEXT NOT NULL,
  html          TEXT NOT NULL,           -- fully rendered report, self-contained
  password_hash TEXT,                    -- Bun.password hash (argon2id), NULL = no password
  created_at    TEXT NOT NULL,
  revoked_at    TEXT                     -- NULL = live
);
CREATE INDEX shared_reports_client ON shared_reports(client, created_at);
```

`token`, `from_date`/`to_date` (avoiding the `from`/`to` SQL keyword ambiguity other query code sidesteps by using `range.from`/`range.to` as TypeScript field names only — the column names here are what's on disk), `password_hash`, `revoked_at` are exactly the brief's field list; `from`/`to` were renamed to `from_date`/`to_date` as SQL column names since `from` is unquoted-reserved-adjacent in some SQLite contexts and every other table in `schema.sql` avoids reserved words in column names.

A row is a snapshot: `html` is the fully rendered client-facing report body at publish time, generated the same way `report/*.ts`'s existing report generators build Markdown-then-render output, but rendered to HTML via Marko templates instead of the Markdown-to-file path the CLI reports use. Re-publishing the same client/range makes a **new** token and a new row; nothing here is ever event-sourced or rebuilt — it is a mirror of a rendering, exactly like the files under `TEMPAD_HOME/reports/` are mirrors of `tempad report`'s Markdown output. This table is added to `packages/core/src/db/schema.sql` (mirrored, per that file's existing convention) via a new migration `packages/core/src/db/migrations/0008_shared_reports.sql` containing the `CREATE TABLE`/`CREATE INDEX` above verbatim — not an `ALTER TABLE` case, so it does not need the tolerant-ALTER path other recent migrations relied on.

### Client report content rule

A client report is built from the same `intent-queries.ts` functions as the Hero views, called with `range.client` set and with side-quest/unconfirmed-quest rows filtered out before rendering: `querySideQuests` results are never passed to the client template at all, and `queryQuests`/`queryActivities` results are filtered to `questConfirmed === true` (or, for activities with no quest, included as-is — an activity's own row carries no "confirmed" concept, only its quest does) before being handed to the client-report Marko template. This filtering happens in the Reports view's publish handler, in `apps/web`, not in a new core query — the existing range-scoped core queries already return everything a report needs; the app's job is to pick which rows a client-facing template receives.

## Security

- **Binding.** The Elysia server binds `127.0.0.1:4242` by default (`[web]` config below). `tempad web` with no flags is safe to run on a laptop with nothing else listening on that port.
- **Exposure.** `tempad web --host 0.0.0.0` binds the given host (or `0.0.0.0` explicitly) instead. The moment the host is anything other than `127.0.0.1`/`localhost`, every hero route (everything except `/r/<token>` and its assets) requires a session: `TEMPAD_WEB_PASSWORD` must be set in `TEMPAD_HOME/.env` (loaded the same way `Config`'s other required-when-applicable vars are — this one is conditionally required, checked at startup only when `--host` is non-loopback, and the process throws and exits rather than silently starting unauthenticated, matching the project-wide rule that required env vars have no defaults). A login route hashes the submitted password with `Bun.password.verify` against a hash of `TEMPAD_WEB_PASSWORD` computed at boot, and on success sets a signed, `httpOnly`, `sameSite=lax` session cookie; the cookie's presence (and validity) gates every hero route via an Elysia `onBeforeHandle` guard. No user table, no per-user accounts — one password for the one Hero.
- **`/r/<token>` routes are public by design** even when the server is otherwise password-gated: they are meant to be sent to a client who has no TemPad login. A token is 32 random bytes (`crypto.getRandomValues`, base64url-encoded — 256 bits, not guessable by request-rate brute force), so unauthenticated-by-design is an acceptable trade for a link nobody can enumerate. An optional per-report password (`password_hash`) adds a second gate in front of that specific link: a request to `/r/<token>` with a non-null `password_hash` and no valid session for that token shows a password form; `Bun.password.verify` checks it; a short-lived signed cookie scoped to that token remembers a correct password across page loads within the visit. `revoked_at IS NOT NULL` returns 410 Gone regardless of password.
- **Tunnelling** (cloudflared, tailscale, ngrok) is out of scope for this app — the spec documents it as the way to reach `/today` etc. from a phone (`cloudflared tunnel --url http://127.0.0.1:4242`, or a Tailscale node reaching `127.0.0.1` isn't possible without `--host`, so a Tailscale-only setup still needs `--host <tailscale-ip>` plus `TEMPAD_WEB_PASSWORD`). Not built, tested, or scripted here.

## Config changes

`tempad.toml` gains a `[web]` section, read by a new `loadWebConfig(tomlPath)` in `packages/core` (mirroring `loadIntentConfig`'s shape: `Bun.TOML.parse`, a `defaultWebConfig()`, no throw on a missing file or missing section):

```toml
[web]
port = 4242
host = "127.0.0.1"
poll_seconds = 2
```

```ts
export interface WebConfig {
  port: number;
  host: string;
  pollSeconds: number;
}
```

`TEMPAD_WEB_PASSWORD` is an environment variable (`TEMPAD_HOME/.env`), not a TOML key, per the existing convention that secrets live in `.env` and non-secret settings live in `tempad.toml`; it has no default and is only required when the resolved `host` (CLI flag if given, else config, else `127.0.0.1`) is not a loopback address.

## Open questions

- **Marko + Elysia pairing.** The marko-ui docs (`https://marko-ui.saulo.tech/docs/installation`) say plainly: "`@marko/run` is what this documentation site uses and what the installation guide assumes, but nothing in the components depends on it" — and the installation walkthrough (`bun create marko my-app`) only shows the `@marko/run` path end to end. Nothing in the marko-ui or Marko docs fetched for this spec documents pairing Marko's renderer with an Elysia route handler directly. Two options, neither verified against working code as part of this docs-only task:
  1. Use `@marko/run`'s own dev/build server instead of Elysia, dropping "Elysia" from the stack — contradicts the brief's stated stack, so not recommended without operator sign-off.
  2. Use Marko's lower-level `template.render(input)` API (documented generally for Marko 6 as returning a string or stream from a compiled `.marko` template, independent of any specific server) inside an Elysia handler: `import template from "./today.marko"; app.get("/", () => new Response(template.render(data)))`. This keeps Elysia as the actual HTTP server and Marko purely as a template renderer, matching the brief's stack literally, but was not confirmed against the live marko-ui/Marko docs in this pass — `web-scaffold` (task 1) must spend part of its budget confirming `template.render`'s exact export shape (default export vs. named, sync string vs. stream) against the installed `@marko/core`/`marko` package before writing the first route.
- **marko-ui package names.** The docs show a shadcn-style CLI (`bunx marko-ui@latest add <url>` for the "copy" distribution, `bunx marko-ui init --distribution import` for the "import" distribution pulling from an installed package) rather than one npm package name to add to `package.json` directly. For the "import" distribution the styles come from `@marko-ui/shadcn` (seen in the required CSS import block: `@import "@marko-ui/shadcn/styles/globals.css";`), but the docs fetched for this spec did not surface the runtime component package's exact name (only the CLI's own package, `marko-ui`, and the styles package, `@marko-ui/shadcn`) — `web-scaffold` confirms the exact package name(s) `bunx marko-ui init` writes to `package.json` and quotes them in that task's commit, rather than this spec guessing.
- **Whether Week's table comes from a new query or from calling `weekly.ts`'s `render` and re-parsing.** Flagged inline above; low-risk either way, left to task 3.
- **Session cookie signing key.** Not specified where the signing secret for the hero session cookie comes from — `TEMPAD_WEB_PASSWORD` itself, or a separate generated secret persisted under `TEMPAD_HOME`. Left to `web-live`'s implementer; either is fine since the threat model here is "not a public-facing multi-tenant app," not high-assurance auth.
