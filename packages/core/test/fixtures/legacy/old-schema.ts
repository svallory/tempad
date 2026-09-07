/**
 * The pre-rename schema, as it actually shipped on `main@fd211b5`.
 *
 * Captured verbatim rather than hand-minimised: a fixture that only carries
 * the columns migration 0011 touches cannot catch a bug that needs the fuller
 * column set (an index or trigger from a later migration naming an old
 * column, a NOT NULL that a rename interacts with). `schema.sql` on main owns
 * the migration-created tables; the projection tables below were created
 * lazily by each projection's own `createSql`, so they are reproduced here as
 * those files defined them.
 */

/** Projection tables, from main's `src/intent/projections/{goal,quest,activity}.ts`. */
export const OLD_PROJECTION_SQL = `
CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL,
  statement TEXT,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT,
  replaced_by TEXT
);
CREATE TABLE IF NOT EXISTS quests (
  id TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  goal_id TEXT,
  title TEXT NOT NULL,
  objective TEXT,
  done_condition TEXT,
  due TEXT,
  budget_minutes INTEGER,
  commitment TEXT,
  origin_kind TEXT NOT NULL DEFAULT 'inferred',
  confirmed INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'started',
  state_reason TEXT,
  merged_into TEXT,
  origin_activity_id TEXT,
  branched_at TEXT,
  trigger TEXT,
  branch_kind TEXT,
  returned_at TEXT,
  created_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT,
  replaced_by TEXT,
  retracted_at TEXT
);
CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY,
  quest_id TEXT,
  objective TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  outcome TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  retracted_at TEXT,
  continues TEXT,
  close_reason TEXT
);
CREATE TABLE IF NOT EXISTS traces (
  id TEXT PRIMARY KEY,
  activity_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  place TEXT NOT NULL,
  source TEXT NOT NULL,
  source_ref TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  who TEXT NOT NULL,
  what TEXT NOT NULL,
  why TEXT NOT NULL,
  where_text TEXT NOT NULL,
  how TEXT NOT NULL,
  confidence REAL NOT NULL,
  classified_by TEXT NOT NULL,
  session_id TEXT,
  recorded_at TEXT NOT NULL,
  retracted_at TEXT
);
CREATE TABLE IF NOT EXISTS trace_links (
  trace_id TEXT NOT NULL,
  activity_id TEXT NOT NULL,
  linked_at TEXT NOT NULL,
  superseded_at TEXT,
  reason TEXT
);
CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  session_id TEXT,
  text TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'watching',
  asked_at TEXT,
  answered_at TEXT,
  answer TEXT,
  answered_by TEXT,
  turns_watched INTEGER NOT NULL DEFAULT 0,
  turns_at_ask INTEGER,
  is_switch INTEGER NOT NULL DEFAULT 0,
  guess TEXT
);
`;

/** One old-vocabulary event, as `main` would have appended it. */
export interface OldEvent {
  at: string;
  actor: string;
  sessionId: string | null;
  kind: string;
  subject: string;
  payload: Record<string, unknown>;
}

/**
 * A small but representative slice of real history: a saga, a quest that
 * serves it, two stints, traces on each, and a side quest branched from the
 * first stint. Every kind and payload field here is spelled the way `main`
 * wrote it.
 */
export const OLD_EVENTS: OldEvent[] = [
  {
    at: "2026-09-01T09:00:00.000Z",
    actor: "hero",
    sessionId: null,
    kind: "hero.created",
    subject: "H1",
    payload: { name: "Tester" },
  },
  {
    at: "2026-09-01T09:01:00.000Z",
    actor: "hero",
    sessionId: null,
    kind: "goal.created",
    subject: "G1",
    payload: { owner: { kind: "hero", id: "H1" }, title: "keep the lights on" },
  },
  {
    at: "2026-09-01T09:02:00.000Z",
    actor: "hero",
    sessionId: null,
    kind: "quest.created",
    subject: "Q1",
    payload: {
      owner: { kind: "hero", id: "H1" },
      goal: "G1",
      title: "fix the sync",
      objective: "sync finishes under a minute",
      confirmed: true,
      origin_kind: "declared",
    },
  },
  {
    at: "2026-09-01T10:00:00.000Z",
    actor: "hook",
    sessionId: "s1",
    kind: "activity.opened",
    subject: "A1",
    payload: { quest: "Q1", objective: "read the collector" },
  },
  {
    at: "2026-09-01T10:30:00.000Z",
    actor: "hook",
    sessionId: "s1",
    kind: "trace.recorded",
    subject: "T1",
    payload: {
      activity: "A1",
      tool: "edit",
      place: "/w/p",
      source: "session",
      started_at: "2026-09-01T10:00:00.000Z",
      ended_at: "2026-09-01T10:30:00.000Z",
      who: "H1",
      what: "read collector",
      why: "orientation",
      where: "/w/p",
      how: "assistant edit",
      confidence: 0.9,
      classified_by: "model",
    },
  },
  {
    at: "2026-09-01T10:35:00.000Z",
    actor: "hook",
    sessionId: "s1",
    kind: "quest.created",
    subject: "Q2",
    payload: {
      owner: { kind: "hero", id: "H1" },
      title: "investigate flaky dedup",
      objective: "understand duplicate commits",
      confirmed: false,
    },
  },
  {
    at: "2026-09-01T10:36:00.000Z",
    actor: "hook",
    sessionId: "s1",
    kind: "quest.branched",
    subject: "Q2",
    payload: { from_activity: "A1", trigger: "noticed duplicates", kind: "curiosity" },
  },
  {
    at: "2026-09-01T10:40:00.000Z",
    actor: "hook",
    sessionId: "s1",
    kind: "activity.opened",
    subject: "A2",
    payload: { quest: "Q2", objective: "compare commit subjects" },
  },
  {
    at: "2026-09-01T11:00:00.000Z",
    actor: "hook",
    sessionId: "s1",
    kind: "trace.recorded",
    subject: "T2",
    payload: {
      activity: "A2",
      tool: "edit",
      place: "/w/p",
      source: "session",
      started_at: "2026-09-01T10:40:00.000Z",
      ended_at: "2026-09-01T11:00:00.000Z",
      who: "H1",
      what: "compared subjects",
      why: "dedup",
      where: "/w/p",
      how: "assistant edit",
      confidence: 0.8,
      classified_by: "model",
    },
  },
  {
    at: "2026-09-01T11:05:00.000Z",
    actor: "hook",
    sessionId: "s1",
    kind: "activity.closed",
    subject: "A2",
    payload: { reason: "idle" },
  },
  {
    at: "2026-09-01T11:10:00.000Z",
    actor: "hero",
    sessionId: null,
    kind: "goal.reworded",
    subject: "G1",
    payload: { title: "keep the lights on, cheaply" },
  },
];
