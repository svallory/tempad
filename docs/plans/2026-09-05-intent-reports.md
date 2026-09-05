# Intent Reports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the reports speak the domain language: quests, activities and side quests per day and per project, a `weekly` report, party and client filters, and `--as-of` time travel.

**Architecture:** Reports keep reading projections and mirrors through `src/report/queries.ts`; new queries read `activities`, `traces`, `quests`, `questions`. `--as-of` swaps the database handle for `stateAsOf(database, date)` before rendering. Party and client filters resolve through `parties`/`clients` and the existing `org` column (party slug) plus the `client` field on path rules.

**Tech Stack:** Bun 1.3, `bun:sqlite`, TypeScript strict, golden-file tests.

**Spec:** `docs/specs/2026-09-05-intent-model-and-w5-hook-design.md`, section "Reports". Plans 1 and 2 merged first.

## Global Constraints

- Same as plans 1 and 2. Commits `type(report): summary`, one per task. Golden fixtures under `packages/core/test/fixtures/report-golden/` stay byte-exact and excluded from dprint (already configured).
- Reports never invent rows; day placement by evidence timestamp in `config.timezone`.

## File structure

```
packages/core/src/report/
  intent-queries.ts   activities, traces, side quests, questions per range
  weekly.ts           new report kind
  daily.ts, hourly.ts, project.ts   extended
  index.ts            register weekly
packages/core/src/cli.ts            --as-of, --party, --client
packages/core/test/report-intent.test.ts, report-weekly.test.ts, report-as-of.test.ts
```

---

### Task 1: Intent queries and daily/hourly additions

**Files:**

- Create: `packages/core/src/report/intent-queries.ts`
- Modify: `packages/core/src/report/daily.ts`, `packages/core/src/report/hourly.ts`, `packages/core/test/fixtures/report-golden/seed.ts` (seed one quest, one side quest with a nexus event, two activities, three traces, one expired question), golden `daily.md` and `hourly.md`
- Test: `packages/core/test/report-intent.test.ts`

**Interfaces:**

- `queryActivities(database, range): ActivityRow[]` (`id, questId, questTitle, questConfirmed, objective, openedAt, closedAt, outcome, minutes` where minutes = sum of trace intervals clipped to the range); `querySideQuests(database, range): SideQuestRow[]` (`id, title, fromActivityObjective, branchedAt, trigger, kind, returnedAt, minutes`); `queryOpenQuestions(database, range): number`.
- Daily: under each project block, after sessions, a `Quests` list (`- <quest title> [unconfirmed]: <objective 1>; <objective 2> (Xh Ym)`) and a `Side quests` list (`- <title>, branched HH:MM from "<objective>", trigger: "<trigger>", back HH:MM | not returned (Xh Ym)`), then `- N traces awaiting review` when applicable. Hourly cells append `↳ <side quest title>` in the hour a branch happened.

- [ ] Steps 1-5 as in plan 1's task shape: failing golden test, implement, gates, commit `feat(report): quests and side quests in daily and hourly reports`.

---

### Task 2: Project report with quests; `weekly` kind

**Files:**

- Create: `packages/core/src/report/weekly.ts`
- Modify: `packages/core/src/report/project.ts`, `packages/core/src/report/index.ts`, golden `project.md`, new golden `weekly.md`
- Test: `packages/core/test/report-weekly.test.ts`

**Interfaces:**

- Project report: when a project has quests in range, the table rows are quests (title, first/last evidence, elapsed upper bound, commits, sessions, activities, side-quest minutes) before Monday items and branches; a footer line `side quests: N, Xh Ym (P% of project time)`.
- Weekly: one table per weekday (Mon–Fri, plus weekend days only when they have evidence), rows per project with columns `activities`, `quests touched`, `shipped` (quests reaching `done` that day), `abandoned`, `side quests`, `side-quest minutes`, `unconfirmed quests`. A final `Totals` row per table and a `Week` table summing the days. `tempad report weekly --from <monday> --to <friday>`.

- [ ] Steps 1-5; commit `feat(report): quests in project report and weekly report`.

---

### Task 3: `--as-of`, `--party`, `--client`

**Files:**

- Modify: `packages/core/src/cli.ts` (`runReportCommand` gains the three flags), `packages/core/src/report/queries.ts` (range gains `party?`, `client?`; `client` resolves through path rules' `client` field stored on `claude_sessions.path_meta` and on `gh_repos.meta` when present), `README.md`, `CLAUDE.md`
- Test: `packages/core/test/report-as-of.test.ts`

**Interfaces:**

- `--as-of <iso>` renders from `stateAsOf(database, iso)` (plan 1 Task 7) for intent tables while mirrors are read as they are; the report title gains ` (as of <date>)`.
- `--party <slug>` is an alias for `--org`; `--client <slug>` keeps only rows whose place metadata has `client = <slug>`.

- [ ] Steps 1-5; commit `feat(report): as-of, party and client filters`.

---

## Self-review

- Spec coverage: report additions (quest and activity lines, side-quest minutes and triggers, unconfirmed time, `--as-of`, `weekly`) → Tasks 1-3.
- Placeholders: tests are described by their golden files and the named queries; the executor writes them against the Interfaces blocks.
- Type consistency: `ActivityRow`, `SideQuestRow` defined in Task 1 and used in Task 2; `stateAsOf` from plan 1.
