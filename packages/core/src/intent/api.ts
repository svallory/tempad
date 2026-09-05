import type { Database } from "bun:sqlite";
import type { Actor } from "./events";
import { newUlid } from "./ids";
import { applyIncremental } from "./projections";
import type { EventStore } from "./store";

export interface OpenActivityInput {
  quest?: string;
  objective: string;
  at?: string;
  actor: Actor;
}

export function openActivity(
  store: EventStore,
  database: Database,
  input: OpenActivityInput,
): string {
  const id = newUlid();
  applyIncremental(
    database,
    store.append({
      actor: input.actor,
      kind: "activity.opened",
      subject: id,
      payload: { quest: input.quest, objective: input.objective },
      at: input.at,
    }),
  );
  return id;
}

export function assignActivity(
  store: EventStore,
  database: Database,
  activityId: string,
  questId: string,
  actor: Actor,
): void {
  applyIncremental(
    database,
    store.append({
      actor,
      kind: "activity.assigned",
      subject: activityId,
      payload: { quest: questId },
    }),
  );
}

export interface TraceInput {
  activity: string;
  tool: string;
  place: string;
  source: string;
  sourceRef?: string;
  startedAt: string;
  endedAt: string;
  who: string;
  what: string;
  why: string;
  where: string;
  how: string;
  confidence: number;
  classifiedBy: string;
  actor: Actor;
  sessionId?: string;
}

export function recordTrace(store: EventStore, database: Database, input: TraceInput): string {
  const id = newUlid();
  applyIncremental(
    database,
    store.append({
      actor: input.actor,
      kind: "trace.recorded",
      subject: id,
      sessionId: input.sessionId,
      payload: {
        activity: input.activity,
        tool: input.tool,
        place: input.place,
        source: input.source,
        source_ref: input.sourceRef,
        started_at: input.startedAt,
        ended_at: input.endedAt,
        who: input.who,
        what: input.what,
        why: input.why,
        where: input.where,
        how: input.how,
        confidence: input.confidence,
        classified_by: input.classifiedBy,
      },
    }),
  );
  return id;
}

export function relinkTrace(
  store: EventStore,
  database: Database,
  traceId: string,
  activityId: string,
  reason: string,
  actor: Actor,
): void {
  applyIncremental(
    database,
    store.append({
      actor,
      kind: "trace.relinked",
      subject: traceId,
      payload: { activity: activityId, reason },
    }),
  );
}

export interface AskQuestionInput {
  trace: string;
  sessionId?: string;
  kind: string;
  text: string;
  isSwitch?: boolean;
  actor: Actor;
}

export function askQuestion(
  store: EventStore,
  database: Database,
  input: AskQuestionInput,
): string {
  const id = newUlid();
  applyIncremental(
    database,
    store.append({
      actor: input.actor,
      kind: "question.asked",
      subject: id,
      sessionId: input.sessionId,
      payload: {
        trace: input.trace,
        kind: input.kind,
        text: input.text,
        is_switch: input.isSwitch ?? false,
      },
    }),
  );
  return id;
}

export function answerQuestion(
  store: EventStore,
  database: Database,
  questionId: string,
  quest: string,
  why: string | undefined,
  actor: Actor,
): void {
  applyIncremental(
    database,
    store.append({
      actor,
      kind: "question.answered",
      subject: questionId,
      payload: { quest, why, answeredBy: actor },
    }),
  );
}

export function expireQuestion(
  store: EventStore,
  database: Database,
  questionId: string,
  actor: Actor,
): void {
  applyIncremental(
    database,
    store.append({ actor, kind: "question.expired", subject: questionId, payload: {} }),
  );
}
