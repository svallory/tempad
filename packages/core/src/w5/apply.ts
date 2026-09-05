import type { Database } from "bun:sqlite";
import { askQuestion, openActivity, recordTrace } from "../intent/api";
import type { Actor } from "../intent/events";
import { newUlid } from "../intent/ids";
import { applyIncremental } from "../intent/projections";
import type { EventStore } from "../intent/store";
import type { ClassifierResult, ClassifierSegment, ClassifierWindow } from "./classifier";

export interface AppliedSummary {
  traces: number;
  activitiesOpened: number;
  questsProposed: number;
  branches: number;
  questionsWatching: number;
}

export interface ApplyOptions {
  actor: Actor;
  askingEnabled: boolean;
  now: string;
}

function requireHeroId(database: Database): string {
  const row = database.query("SELECT id FROM heroes LIMIT 1").get() as { id: string } | null;
  if (!row) throw new Error("run `tempad hero init` first");
  return row.id;
}

function classifyTrigger(trigger: string | null): string {
  if (trigger === null) return "unknown";
  const lower = trigger.toLowerCase();
  if (/\bblocked\b|\bfailing\b|\berror\b/.test(lower)) return "blocker";
  if (/\bwhy\b|\bwonder\b|\bwhat does\b/.test(lower)) return "curiosity";
  return "unknown";
}

function createQuest(
  store: EventStore,
  database: Database,
  input: {
    heroId: string;
    title: string;
    objective: string;
    commitment: string;
    confirmed: boolean;
  },
): string {
  const id = newUlid();
  applyIncremental(
    database,
    store.append({
      actor: "hook",
      kind: "quest.created",
      subject: id,
      payload: {
        owner: { kind: "hero", id: input.heroId },
        title: input.title,
        objective: input.objective,
        commitment: input.commitment,
        confirmed: input.confirmed,
      },
    }),
  );
  return id;
}

function branchQuest(
  store: EventStore,
  database: Database,
  input: { questId: string; fromActivityId: string; trigger: string; at: string },
): void {
  applyIncremental(
    database,
    store.append({
      actor: "hook",
      kind: "quest.branched",
      subject: input.questId,
      at: input.at,
      payload: {
        from_activity: input.fromActivityId,
        trigger: input.trigger,
        kind: classifyTrigger(input.trigger),
      },
    }),
  );
}

function resolveActivityForSegment(
  store: EventStore,
  database: Database,
  heroId: string,
  segment: ClassifierSegment,
  now: string,
): { activityId: string; questId: string | null; activityOpened: boolean; questCreated: boolean } {
  if (segment.matchedActivity !== null) {
    const activity = database
      .query("SELECT quest_id as questId FROM activities WHERE id = ?")
      .get(segment.matchedActivity) as { questId: string | null } | null;
    if (activity && (activity.questId ?? null) === (segment.matchedQuest ?? null)) {
      return {
        activityId: segment.matchedActivity,
        questId: activity.questId,
        activityOpened: false,
        questCreated: false,
      };
    }
  }

  let questId = segment.matchedQuest;
  let questCreated = false;
  if (questId === null && segment.proposedQuest !== null) {
    questId = createQuest(store, database, {
      heroId,
      title: segment.proposedQuest.title,
      objective: segment.proposedQuest.objective,
      commitment: segment.proposedQuest.commitment,
      confirmed: false,
    });
    questCreated = true;
  }

  const activityId = openActivity(store, database, {
    quest: questId ?? undefined,
    objective: segment.what,
    at: now,
    actor: "hook",
  });

  return { activityId, questId, activityOpened: true, questCreated };
}

export function applyResult(
  store: EventStore,
  database: Database,
  window: ClassifierWindow,
  result: ClassifierResult,
  options: ApplyOptions,
): AppliedSummary {
  const heroId = requireHeroId(database);
  const summary: AppliedSummary = {
    traces: 0,
    activitiesOpened: 0,
    questsProposed: 0,
    branches: 0,
    questionsWatching: 0,
  };

  for (const segment of result.segments) {
    const { activityId, questId, activityOpened, questCreated } = resolveActivityForSegment(
      store,
      database,
      heroId,
      segment,
      options.now,
    );

    if (activityOpened) summary.activitiesOpened += 1;
    if (questCreated) summary.questsProposed += 1;

    if (
      segment.isSwitch &&
      questId !== null &&
      window.previousTrace !== null &&
      questId !== window.previousTrace.questId
    ) {
      branchQuest(store, database, {
        questId,
        fromActivityId: window.previousTrace.activityId,
        trigger: segment.trigger ?? "unknown",
        at: segment.startedAt,
      });
      summary.branches += 1;
    }

    const traceId = recordTrace(store, database, {
      activity: activityId,
      tool: "claude-code",
      place: `${window.org}/${window.project}`,
      source: "w5",
      startedAt: segment.startedAt,
      endedAt: segment.endedAt,
      who: "hero",
      what: segment.what,
      why: segment.why,
      where: `${window.org}/${window.project}`,
      how: "claude-code",
      confidence: segment.confidence,
      classifiedBy: "assistant",
      actor: options.actor,
      sessionId: window.sessionId,
    });
    summary.traces += 1;

    if (segment.questions.length > 0 && options.askingEnabled) {
      for (const kind of segment.questions) {
        askQuestion(store, database, {
          trace: traceId,
          sessionId: window.sessionId,
          kind,
          text: kind,
          isSwitch: segment.isSwitch,
          actor: options.actor,
        });
        summary.questionsWatching += 1;
      }
    }
  }

  return summary;
}
