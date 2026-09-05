import type { Database } from "bun:sqlite";
import type { W5Config } from "../intent/config";
import { applyIncremental } from "../intent/projections";
import type { EventStore } from "../intent/store";

export interface QuestionRow {
  id: string;
  traceId: string;
  sessionId: string | null;
  kind: string;
  state: string;
  turnsWatched: number;
  turnsAtAsk: number | null;
  isSwitch: boolean;
}

interface RawQuestionRow {
  id: string;
  trace_id: string;
  session_id: string | null;
  kind: string;
  state: string;
  turns_watched: number;
  turns_at_ask: number | null;
  is_switch: number;
}

function toQuestionRow(row: RawQuestionRow): QuestionRow {
  return {
    id: row.id,
    traceId: row.trace_id,
    sessionId: row.session_id,
    kind: row.kind,
    state: row.state,
    turnsWatched: row.turns_watched,
    turnsAtAsk: row.turns_at_ask,
    isSwitch: row.is_switch === 1,
  };
}

export interface AdvanceQuestionsInput {
  sessionId: string;
  now: string;
  turnsSinceLastRun: number;
  sessionActivityMinutes: number;
  resolvedByContext: string[];
}

export interface AdvanceQuestionsResult {
  asked: QuestionRow[];
  expired: QuestionRow[];
  resolved: QuestionRow[];
}

function isQuiet(database: Database, now: string): boolean {
  const row = database.query("SELECT until FROM w5_quiet ORDER BY rowid DESC LIMIT 1").get() as {
    until: string;
  } | null;
  return row !== null && row.until > now;
}

function hasRecentAsk(
  database: Database,
  sessionId: string,
  now: string,
  budgetMinutes: number,
): boolean {
  const row = database
    .query(
      `SELECT asked_at FROM questions
        WHERE session_id = ? AND asked_at IS NOT NULL
        ORDER BY asked_at DESC LIMIT 1`,
    )
    .get(sessionId) as { asked_at: string } | null;
  if (!row) return false;
  const elapsedMinutes = (Date.parse(now) - Date.parse(row.asked_at)) / 60_000;
  return elapsedMinutes < budgetMinutes;
}

function hasUnansweredAsked(database: Database, sessionId: string): boolean {
  const row = database
    .query("SELECT id FROM questions WHERE session_id = ? AND state = 'asked' LIMIT 1")
    .get(sessionId) as { id: string } | null;
  return row !== null;
}

function watchQuestion(
  store: EventStore,
  database: Database,
  questionId: string,
  turns: number,
  now: string,
): void {
  applyIncremental(
    database,
    store.append({
      actor: "system",
      kind: "question.watched",
      subject: questionId,
      at: now,
      payload: { turns },
    }),
  );
}

function promoteQuestion(
  store: EventStore,
  database: Database,
  questionId: string,
  turnsAtAsk: number,
  now: string,
): void {
  applyIncremental(
    database,
    store.append({
      actor: "system",
      kind: "question.promoted",
      subject: questionId,
      at: now,
      payload: { turnsAtAsk },
    }),
  );
}

function expireQuestion(
  store: EventStore,
  database: Database,
  questionId: string,
  now: string,
): void {
  applyIncremental(
    database,
    store.append({
      actor: "system",
      kind: "question.expired",
      subject: questionId,
      at: now,
      payload: {},
    }),
  );
}

function resolveByContext(
  store: EventStore,
  database: Database,
  questionId: string,
  now: string,
): void {
  applyIncremental(
    database,
    store.append({
      actor: "system",
      kind: "question.answered",
      subject: questionId,
      at: now,
      payload: { answeredBy: "context" },
    }),
  );
}

export function advanceQuestions(
  store: EventStore,
  database: Database,
  config: W5Config,
  input: AdvanceQuestionsInput,
): AdvanceQuestionsResult {
  const asked: QuestionRow[] = [];
  const expired: QuestionRow[] = [];
  const resolved: QuestionRow[] = [];

  const watchingRows = database
    .query(
      `SELECT id, trace_id, session_id, kind, state, turns_watched, turns_at_ask, is_switch
         FROM questions
        WHERE session_id = ? AND state = 'watching'
        ORDER BY rowid ASC`,
    )
    .all(input.sessionId) as RawQuestionRow[];

  const resolvedSet = new Set(input.resolvedByContext);

  for (const raw of watchingRows) {
    const row = toQuestionRow(raw);

    if (resolvedSet.has(row.id)) {
      resolveByContext(store, database, row.id, input.now);
      resolved.push({ ...row, state: "resolved_by_context" });
      continue;
    }

    const newTurnsWatched = row.turnsWatched + input.turnsSinceLastRun;
    watchQuestion(store, database, row.id, newTurnsWatched, input.now);

    const trace = database
      .query(
        `SELECT traces.id as traceId, activities.quest_id as questId
           FROM traces JOIN activities ON activities.id = traces.activity_id
          WHERE traces.id = ?`,
      )
      .get(row.traceId) as { traceId: string; questId: string | null } | null;

    if (row.kind === "why" && trace?.questId !== null && trace?.questId !== undefined) {
      expireQuestion(store, database, row.id, input.now);
      expired.push({ ...row, state: "expired", turnsWatched: newTurnsWatched });
      continue;
    }

    if (newTurnsWatched < config.watchTurns) continue;

    const qualifiesOnSwitch = row.kind === "which_quest" && row.isSwitch;
    const qualifiesOnActivity =
      input.sessionActivityMinutes >= config.askMinActivityMinutes &&
      (trace?.questId === null || trace?.questId === undefined);

    if (!qualifiesOnSwitch && !qualifiesOnActivity) continue;
    if (hasRecentAsk(database, input.sessionId, input.now, config.askBudgetMinutes)) continue;
    if (hasUnansweredAsked(database, input.sessionId)) continue;
    if (isQuiet(database, input.now)) continue;

    promoteQuestion(store, database, row.id, newTurnsWatched, input.now);
    asked.push({
      ...row,
      state: "asked",
      turnsWatched: newTurnsWatched,
      turnsAtAsk: newTurnsWatched,
    });
  }

  const askedRows = database
    .query(
      `SELECT id, trace_id, session_id, kind, state, turns_watched, turns_at_ask, is_switch
         FROM questions
        WHERE session_id = ? AND state = 'asked'`,
    )
    .all(input.sessionId) as RawQuestionRow[];

  for (const raw of askedRows) {
    const row = toQuestionRow(raw);
    if (asked.some((a) => a.id === row.id)) continue;

    const newTurnsWatched = row.turnsWatched + input.turnsSinceLastRun;
    watchQuestion(store, database, row.id, newTurnsWatched, input.now);

    if (newTurnsWatched - (row.turnsAtAsk ?? 0) >= config.askExpireTurns) {
      expireQuestion(store, database, row.id, input.now);
      expired.push({ ...row, state: "expired", turnsWatched: newTurnsWatched });
    }
  }

  return { asked, expired, resolved };
}
