import type { Database } from "bun:sqlite";
import { askQuestion, recordTrace } from "../intent/api";
import type { Actor } from "../intent/events";
import { newUlid } from "../intent/ids";
import { applyIncremental } from "../intent/projections";
import type { EventStore } from "../intent/store";
import type { ClassifierResult, ClassifierSegment, ClassifierWindow } from "./classifier";
import { closeActivityOnSwitch, openActivityContinuing } from "./lifecycle";

export interface AppliedSummary {
  traces: number;
  activitiesOpened: number;
  questsProposed: number;
  branches: number;
  questionsWatching: number;
  questConflicts: number;
  overlapDropped: number;
}

export interface ApplyOptions {
  actor: Actor;
  askingEnabled: boolean;
  now: string;
  log: (line: string) => void;
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

interface ResolvedActivity {
  activityId: string;
  questId: string | null;
  activityOpened: boolean;
  questCreated: boolean;
  questConflict: boolean;
}

function resolveQuest(
  store: EventStore,
  database: Database,
  heroId: string,
  segment: ClassifierSegment,
): { questId: string | null; questCreated: boolean } {
  if (segment.matchedQuest !== null) return { questId: segment.matchedQuest, questCreated: false };
  if (segment.proposedQuest === null) return { questId: null, questCreated: false };
  return {
    questId: createQuest(store, database, {
      heroId,
      title: segment.proposedQuest.title,
      objective: segment.proposedQuest.objective,
      commitment: segment.proposedQuest.commitment,
      confirmed: false,
    }),
    questCreated: true,
  };
}

function resolveActivityForSegment(
  store: EventStore,
  database: Database,
  heroId: string,
  segment: ClassifierSegment,
  now: string,
): ResolvedActivity {
  if (segment.matchedActivity !== null) {
    const activity = database
      .query("SELECT quest_id as questId FROM activities WHERE id = ?")
      .get(segment.matchedActivity) as { questId: string | null } | null;
    if (activity) {
      // A quest disagreement never reassigns the activity's quest and never opens a
      // second activity over the same stretch of attention: it is reported instead.
      const questConflict = (activity.questId ?? null) !== (segment.matchedQuest ?? null);
      return {
        activityId: segment.matchedActivity,
        questId: activity.questId,
        activityOpened: false,
        questCreated: false,
        questConflict,
      };
    }
  }

  const continues = segment.continuesActivity;
  let { questId, questCreated } = resolveQuest(store, database, heroId, segment);

  if (continues !== null && questId === null) {
    // Returning to a closed activity keeps its quest unless the classifier named another.
    const closed = database
      .query("SELECT quest_id as questId FROM activities WHERE id = ?")
      .get(continues) as { questId: string | null } | null;
    questId = closed?.questId ?? null;
  }

  const activityId = openActivityContinuing(store, database, {
    quest: questId ?? undefined,
    objective: segment.what,
    at: now,
    actor: "hook",
    continues: continues ?? undefined,
  });

  return { activityId, questId, activityOpened: true, questCreated, questConflict: false };
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
    questConflicts: 0,
    overlapDropped: 0,
  };

  const overlapStart = window.overlapMessages[0]?.ts ?? null;
  const overlapEnd = window.overlapMessages.at(-1)?.ts ?? null;

  const mostRecentOpen = window.sessionOpenActivities.at(-1);
  let previous: { activityId: string; questId: string | null } | null = mostRecentOpen
    ? { activityId: mostRecentOpen.activityId, questId: mostRecentOpen.questId }
    : null;

  for (const segment of result.segments) {
    // Belt and braces: the prompt says the overlap tail is context only, but a
    // model that classifies it anyway must not double-record those minutes.
    if (
      overlapStart !== null &&
      overlapEnd !== null &&
      segment.startedAt >= overlapStart &&
      segment.endedAt <= overlapEnd
    ) {
      summary.overlapDropped += 1;
      continue;
    }

    const { activityId, questId, activityOpened, questCreated, questConflict } =
      resolveActivityForSegment(store, database, heroId, segment, options.now);

    if (activityOpened) summary.activitiesOpened += 1;
    if (questCreated) summary.questsProposed += 1;
    if (questConflict) {
      summary.questConflicts += 1;
      options.log(
        `w5 quest conflict: activity ${activityId} keeps quest ${questId ?? "none"}, classifier said ${segment.matchedQuest ?? "none"}`,
      );
    }

    if (segment.isSwitch && previous !== null && previous.activityId !== activityId) {
      closeActivityOnSwitch(store, database, {
        activityId: previous.activityId,
        closedAt: segment.startedAt,
      });
    }

    if (segment.isSwitch && questId !== null && previous !== null && questId !== previous.questId) {
      branchQuest(store, database, {
        questId,
        fromActivityId: previous.activityId,
        trigger: segment.trigger ?? "unknown",
        at: segment.startedAt,
      });
      summary.branches += 1;
    }

    previous = { activityId, questId };

    const traceId = recordTrace(store, database, {
      activity: activityId,
      tool: "claude-code",
      place: `${window.org}/${window.project}`,
      source: "session",
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
