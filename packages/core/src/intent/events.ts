export type Actor = "hero" | "assistant" | "hook" | "backfill" | "system";

export const EVENT_KINDS = [
  "hero.created",
  "party.created",
  "party.reworded",
  "membership.joined",
  "membership.left",
  "client.created",
  "project.created",
  "project.updated",
  "place.opened",
  "place.closed",
  "goal.created",
  "goal.reworded",
  "goal.ended",
  "quest.created",
  "quest.reworded",
  "quest.ended",
  "quest.confirmed",
  "quest.merged",
  "quest.lifecycle",
  "quest.branched",
  "quest.returned",
  "activity.opened",
  "activity.reworded",
  "activity.closed",
  "activity.assigned",
  "trace.recorded",
  "trace.relinked",
  "question.asked",
  "question.watched",
  "question.promoted",
  "question.answered",
  "question.expired",
  "retracted",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export interface EventInput {
  at?: string;
  actor: Actor;
  sessionId?: string;
  kind: EventKind;
  subject: string;
  payload: Record<string, unknown>;
}

export interface EventRecord {
  id: number;
  at: string;
  recordedAt: string;
  actor: Actor;
  sessionId: string | null;
  kind: EventKind;
  subject: string;
  payload: Record<string, unknown>;
}
