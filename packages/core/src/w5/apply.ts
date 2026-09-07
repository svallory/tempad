import type { Database } from "bun:sqlite";
import { askQuestion, assignActivity, recordTrace } from "../intent/api";
import { currentDeclaredQuest, currentDeclaredQuestForSubagent } from "../intent/declarations";
import type { Actor } from "../intent/events";
import { newUlid } from "../intent/ids";
import { applyIncremental } from "../intent/projections";
import type { EventStore } from "../intent/store";
import type { ClassifierResult, ClassifierSegment, ClassifierWindow } from "./classifier";
import { openActivityContinuing } from "./lifecycle";

export interface AppliedSummary {
  traces: number;
  activitiesOpened: number;
  questsProposed: number;
  branches: number;
  questionsWatching: number;
  /**
   * Declared mode: segments the verifier doubted (`belongs: false`). Inference
   * mode: the old quest-conflict count. A run is one mode or the other, so the
   * two meanings never coexist in the same summary.
   */
  doubts: number;
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
  /**
   * `"declared"` runs the verifier: quest identity comes from the session's own
   * declaration and no quest is ever created, proposed, reassigned or branched
   * here. `"inferred"` runs the pre-verifier logic unchanged, which backfill
   * falls back to for a session that never declares anything.
   */
  mode?: "declared" | "inferred";
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
  if (/\bwaiting\b|\bwhile.*(runs?|running)\b|\bin the meantime\b/.test(lower)) return "waiting";
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
  const matchedQuest = segment.matchedQuest ?? null;
  const proposedQuest = segment.proposedQuest ?? null;
  if (matchedQuest !== null) return { questId: matchedQuest, questCreated: false };
  if (proposedQuest === null) return { questId: null, questCreated: false };
  return {
    questId: createQuest(store, database, {
      heroId,
      title: proposedQuest.title,
      objective: proposedQuest.objective,
      commitment: proposedQuest.commitment,
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
  const matchedQuest = segment.matchedQuest ?? null;
  const proposedQuest = segment.proposedQuest ?? null;
  const questConflict = matchedQuest !== null && matchedQuest !== (existingQuestId ?? null);

  if (existingQuestId === null && matchedQuest === null && proposedQuest !== null) {
    const questId = createQuest(store, database, {
      heroId,
      title: proposedQuest.title,
      objective: proposedQuest.objective,
      commitment: proposedQuest.commitment,
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

/**
 * Declared mode's activity resolution. The three-way selector rule is unchanged,
 * but every branch ends with the session's declared quest: there is no per-segment
 * quest decision left to make, so nothing here creates, proposes, reassigns or
 * branches a quest.
 *
 * Selectors arrive as aliases (`"A1"`). An alias the window never offered resolves
 * to nothing and opens a new activity, exactly as a fabricated id did before.
 */
function resolveActivityForSegmentDeclared(
  store: EventStore,
  database: Database,
  segment: ClassifierSegment,
  openedAt: string,
  declaredQuestId: string | null,
  aliases: Record<string, string>,
): ResolvedActivity {
  let unknownActivityId = false;
  const resolveAlias = (alias: string | null): string | null => {
    if (alias === null) return null;
    return aliases[alias] ?? null;
  };

  const matchedId = resolveAlias(segment.matchedActivity);
  if (segment.matchedActivity !== null) {
    if (matchedId === null) {
      unknownActivityId = true;
    } else {
      const matched = readActivity(database, matchedId);
      if (matched?.isOpen) {
        // A matched activity keeps its own row; the declared quest is attached only
        // when it has none, since reassignment is exactly what the verifier must
        // never do.
        if (matched.questId === null && declaredQuestId !== null) {
          assignActivity(store, database, matchedId, declaredQuestId, "hook");
        }
        return {
          activityId: matchedId,
          questId: matched.questId ?? declaredQuestId,
          activityOpened: false,
          questCreated: false,
          questConflict: false,
          unknownActivityId: false,
          questProposedOnMatched: false,
        };
      }
      unknownActivityId = true;
    }
  }

  let continues: string | null = null;
  if (segment.continuesActivity !== null) {
    const continuesId = resolveAlias(segment.continuesActivity);
    if (continuesId === null) {
      unknownActivityId = true;
    } else {
      const referenced = readActivity(database, continuesId);
      if (referenced === null) {
        unknownActivityId = true;
      } else if (referenced.isOpen) {
        if (referenced.questId === null && declaredQuestId !== null) {
          assignActivity(store, database, continuesId, declaredQuestId, "hook");
        }
        return {
          activityId: continuesId,
          questId: referenced.questId ?? declaredQuestId,
          activityOpened: false,
          questCreated: false,
          questConflict: false,
          unknownActivityId: false,
          questProposedOnMatched: false,
        };
      } else {
        continues = continuesId;
      }
    }
  }

  const activityId = openActivityContinuing(store, database, {
    quest: declaredQuestId ?? undefined,
    objective: segment.what,
    at: openedAt,
    actor: "hook",
    continues: continues ?? undefined,
  });

  return {
    activityId,
    questId: declaredQuestId,
    activityOpened: true,
    questCreated: false,
    questConflict: false,
    unknownActivityId,
    questProposedOnMatched: false,
  };
}

/**
 * The `parent_session_id` on the session's latest declaration at `at`, or null
 * when that declaration is session-scoped. `currentDeclaredQuest` only resolves
 * session-scope declarations, so a subagent's parent has to be read from the
 * event payload that carries it.
 */
function latestDeclaredParentSessionId(
  database: Database,
  sessionId: string,
  at: string,
): string | null {
  const row = database
    .query(
      `SELECT payload FROM events
        WHERE kind = 'quest.declared' AND json_extract(payload, '$.session_id') = ? AND at <= ?
        ORDER BY at DESC, id DESC LIMIT 1`,
    )
    .get(sessionId, at) as { payload: string } | null;
  if (row === null) return null;
  const payload = JSON.parse(row.payload) as { scope?: string; parent_session_id?: string };
  if (payload.scope !== "subagent") return null;
  return payload.parent_session_id ?? null;
}

export function applyResult(
  store: EventStore,
  database: Database,
  window: ClassifierWindow,
  result: ClassifierResult,
  options: ApplyOptions,
): AppliedSummary {
  const heroId = requireHeroId(database);
  const declaredMode = (options.mode ?? "declared") === "declared";
  const summary: AppliedSummary = {
    traces: 0,
    activitiesOpened: 0,
    questsProposed: 0,
    branches: 0,
    questionsWatching: 0,
    doubts: 0,
    overlapDropped: 0,
    unknownActivityIds: 0,
    questProposedOnMatched: 0,
  };

  // Resolved once per window, not per segment: a re-declaration between two
  // chunks is picked up by the next chunk's own `buildWindow` call.
  let declaredQuestId: string | null = null;
  // A subagent's doubt is addressed to whoever can answer it: the parent session.
  let questionSessionId = window.sessionId;
  if (declaredMode) {
    const at = window.messages.at(-1)?.ts ?? options.now;
    // The window already resolved the parent for the prompt; `parentDeclaredQuest`
    // being set is exactly "this session is a subagent with a known parent".
    const parentSessionId =
      window.parentDeclaredQuest !== null
        ? latestDeclaredParentSessionId(database, window.sessionId, at)
        : null;
    if (parentSessionId !== null) {
      declaredQuestId =
        currentDeclaredQuestForSubagent(database, {
          sessionId: window.sessionId,
          parentSessionId,
          at,
        })?.questId ?? null;
      questionSessionId = parentSessionId;
    } else {
      declaredQuestId =
        currentDeclaredQuest(database, { sessionId: window.sessionId, at })?.questId ?? null;
    }
  }

  // A declared session with nothing declared *yet* records its work with no quest
  // and asks to declare once for the whole window -- an undeclared window is one
  // gap, not N.
  const needsDeclaration = declaredMode && declaredQuestId === null;
  let declareAsked = false;

  const overlapStart = window.overlapMessages[0]?.ts ?? null;
  const overlapEnd = window.overlapMessages.at(-1)?.ts ?? null;

  const mostRecentOpen = window.sessionOpenActivities.at(-1);
  let previous: { activityId: string; questId: string | null } | null = mostRecentOpen
    ? { activityId: mostRecentOpen.activityId, questId: mostRecentOpen.questId }
    : null;

  // The session may legitimately hold several activities open at once (a lead
  // coordinating two quests, a session running parallel subagents), so a
  // switch never closes anything -- it only marks the nexus event for
  // side-quest branching. A switch's quest counts as a branch only when it is
  // not already open in this session: returning to a quest already in flight
  // is not a nexus event, just attention moving back to something ongoing.
  const openSessionQuestIds = new Set(
    window.sessionOpenActivities
      .map((activity) => activity.questId)
      .filter((questId): questId is string => questId !== null),
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
    } = declaredMode
      ? resolveActivityForSegmentDeclared(
          store,
          database,
          segment,
          segment.startedAt,
          declaredQuestId,
          window.activityAliases ?? {},
        )
      : resolveActivityForSegment(store, database, heroId, segment, segment.startedAt);

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
      summary.doubts += 1;
      options.log(
        `w5 quest conflict: activity ${activityId} keeps quest ${questId ?? "none"}, classifier said ${segment.matchedQuest ?? "none"}`,
      );
    }

    if (
      !declaredMode &&
      segment.isSwitch &&
      questId !== null &&
      previous !== null &&
      questId !== previous.questId &&
      !openSessionQuestIds.has(questId)
    ) {
      branchQuest(store, database, {
        questId,
        fromActivityId: previous.activityId,
        trigger: segment.trigger ?? "unknown",
        at: segment.startedAt,
      });
      summary.branches += 1;
    }

    if (questId !== null) openSessionQuestIds.add(questId);
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

    if (declaredMode) {
      // A doubt is recorded even when asking is disabled (backfill), so the run
      // summary and `tempad review` still show it; only the hand-back is gated.
      if (segment.belongs === false) {
        summary.doubts += 1;
        if (options.askingEnabled) {
          askQuestion(store, database, {
            trace: traceId,
            sessionId: questionSessionId,
            kind: "belongs",
            // Internal only: the sentence the human sees is rendered fresh in
            // `w5/hooks.ts` from kind + guess + the declared title.
            text: "belongs",
            guess: segment.guess,
            isSwitch: segment.isSwitch,
            actor: options.actor,
          });
          summary.questionsWatching += 1;
        }
      }

      if (needsDeclaration && !declareAsked && options.askingEnabled) {
        askQuestion(store, database, {
          trace: traceId,
          sessionId: questionSessionId,
          kind: "declare",
          text: "declare",
          isSwitch: false,
          actor: options.actor,
        });
        summary.questionsWatching += 1;
        declareAsked = true;
      }
      continue;
    }

    if (segment.questions !== undefined && segment.questions.length > 0 && options.askingEnabled) {
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
