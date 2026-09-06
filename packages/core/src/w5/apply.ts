import type { Database } from "bun:sqlite";
import { askQuestion, assignActivity, recordTrace } from "../intent/api";
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
  unknownActivityIds: number;
  /**
   * A matched activity that had no quest, for which the classifier proposed one.
   */
  questProposedOnMatched: number;
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
  unknownActivityId: boolean;
  questProposedOnMatched: boolean;
}

interface ActivityState {
  questId: string | null;
  isOpen: boolean;
}

/**
 * Reads an activity the classifier named, ignoring retracted rows. A classifier
 * can return an id that never existed, belongs to another session, or was
 * retracted since the slice was built, so every id it hands back is looked up
 * before it is trusted.
 */
function readActivity(database: Database, activityId: string): ActivityState | null {
  const row = database
    .query(
      "SELECT quest_id as questId, closed_at as closedAt FROM activities WHERE id = ? AND retracted_at IS NULL",
    )
    .get(activityId) as { questId: string | null; closedAt: string | null } | null;
  if (!row) return null;
  return { questId: row.questId, isOpen: row.closedAt === null };
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

/**
 * Reuse of an activity that already exists (matched, or `continues` pointed at a
 * still-open one). Its quest is never reassigned, but the classifier's opinion is
 * read for what it is:
 *
 * - `matchedQuest: null` is *no opinion*, not "no quest". A model that omits the
 *   field means it did not judge the quest, so the activity keeps its own and
 *   nothing is reported -- treating this as a disagreement made almost every
 *   segment a conflict.
 * - a different non-null `matchedQuest` is a real disagreement: counted, logged,
 *   never applied.
 * - `proposedQuest` on a matched activity that has *no* quest is the one case
 *   where something is missing rather than contested, so the quest is created and
 *   attached through the ordinary `activity.assigned` path.
 */
function reuseActivity(
  store: EventStore,
  database: Database,
  heroId: string,
  segment: ClassifierSegment,
  activityId: string,
  existingQuestId: string | null,
): ResolvedActivity {
  const questConflict =
    segment.matchedQuest !== null && segment.matchedQuest !== (existingQuestId ?? null);

  if (existingQuestId === null && segment.matchedQuest === null && segment.proposedQuest !== null) {
    const questId = createQuest(store, database, {
      heroId,
      title: segment.proposedQuest.title,
      objective: segment.proposedQuest.objective,
      commitment: segment.proposedQuest.commitment,
      confirmed: false,
    });
    assignActivity(store, database, activityId, questId, "hook");
    return {
      activityId,
      questId,
      activityOpened: false,
      questCreated: true,
      questConflict: false,
      unknownActivityId: false,
      questProposedOnMatched: true,
    };
  }

  return {
    activityId,
    questId: existingQuestId,
    activityOpened: false,
    questCreated: false,
    questConflict,
    unknownActivityId: false,
    questProposedOnMatched: false,
  };
}

function resolveActivityForSegment(
  store: EventStore,
  database: Database,
  heroId: string,
  segment: ClassifierSegment,
  openedAt: string,
): ResolvedActivity {
  let unknownActivityId = false;

  // `matchedActivity` means "this stretch of attention is still going", so it is
  // only honoured for an activity that is actually still open.
  if (segment.matchedActivity !== null) {
    const matched = readActivity(database, segment.matchedActivity);
    if (matched?.isOpen) {
      return reuseActivity(
        store,
        database,
        heroId,
        segment,
        segment.matchedActivity,
        matched.questId,
      );
    }
    unknownActivityId = true;
  }

  // `continuesActivity` means "the same objective, resumed after a gap", so it is
  // only a link when the activity it names has actually closed. Pointing it at a
  // still-open activity says the attention never stopped: that is a plain reuse,
  // and opening a second row would leave two open activities for one objective.
  let continues: string | null = null;
  if (segment.continuesActivity !== null) {
    const referenced = readActivity(database, segment.continuesActivity);
    if (referenced === null) {
      unknownActivityId = true;
    } else if (referenced.isOpen) {
      return reuseActivity(
        store,
        database,
        heroId,
        segment,
        segment.continuesActivity,
        referenced.questId,
      );
    } else {
      continues = segment.continuesActivity;
    }
  }

  let { questId, questCreated } = resolveQuest(store, database, heroId, segment);

  if (continues !== null && questId === null) {
    // Returning to a closed activity keeps its quest unless the classifier named another.
    questId = readActivity(database, continues)?.questId ?? null;
  }

  const activityId = openActivityContinuing(store, database, {
    quest: questId ?? undefined,
    objective: segment.what,
    at: openedAt,
    actor: "hook",
    continues: continues ?? undefined,
  });

  return {
    activityId,
    questId,
    activityOpened: true,
    questCreated,
    questConflict: false,
    unknownActivityId,
    questProposedOnMatched: false,
  };
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
    unknownActivityIds: 0,
    questProposedOnMatched: 0,
  };

  const overlapStart = window.overlapMessages[0]?.ts ?? null;
  const overlapEnd = window.overlapMessages.at(-1)?.ts ?? null;

  const mostRecentOpen = window.sessionOpenActivities.at(-1);
  let previous: { activityId: string; questId: string | null } | null = mostRecentOpen
    ? { activityId: mostRecentOpen.activityId, questId: mostRecentOpen.questId }
    : null;

  // Attention is singular: a session has at most one activity actually in
  // progress. More than one open here is a classifier artifact, and a switch
  // corrects it by closing every open activity of the session except the one
  // the segment lands on. A later return to a closed one is a new activity
  // with `continues`, never a reopen.
  const openSessionActivityIds = new Set(
    window.sessionOpenActivities.map((activity) => activity.activityId),
  );

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

    // An activity opens when the work started, not when the classifier ran. For a
    // live run the two are minutes apart, but backfill classifies history with
    // `now` set to the run's own clock: stamping `opened_at` with it put every
    // activity days after the traces it owns, which is what made measured
    // durations negative and left `opened_at < windowEnd` unable to hold.
    const {
      activityId,
      questId,
      activityOpened,
      questCreated,
      questConflict,
      unknownActivityId,
      questProposedOnMatched,
    } = resolveActivityForSegment(store, database, heroId, segment, segment.startedAt);

    if (activityOpened) summary.activitiesOpened += 1;
    if (questCreated) summary.questsProposed += 1;
    if (unknownActivityId) {
      summary.unknownActivityIds += 1;
      options.log(
        `w5 unknown activity id: classifier named ${segment.matchedActivity ?? segment.continuesActivity ?? "none"}, which is not an open activity in the window; opened ${activityId} instead`,
      );
    }
    if (questProposedOnMatched) {
      summary.questProposedOnMatched += 1;
      options.log(
        `w5 quest proposed on matched activity: activity ${activityId} had no quest, attached newly proposed ${questId ?? "none"}`,
      );
    }
    if (questConflict) {
      summary.questConflicts += 1;
      options.log(
        `w5 quest conflict: activity ${activityId} keeps quest ${questId ?? "none"}, classifier said ${segment.matchedQuest ?? "none"}`,
      );
    }

    if (segment.isSwitch) {
      for (const openActivityId of openSessionActivityIds) {
        if (openActivityId === activityId) continue;
        closeActivityOnSwitch(store, database, {
          activityId: openActivityId,
          closedAt: segment.startedAt,
        });
        openSessionActivityIds.delete(openActivityId);
      }
    }
    if (activityOpened) openSessionActivityIds.add(activityId);

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
