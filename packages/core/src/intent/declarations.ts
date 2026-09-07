import type { Database } from "bun:sqlite";
import { newUlid } from "./ids";
import { applyIncremental } from "./projections";
import type { EventStore } from "./store";

export type Commitment = "promised" | "personal" | "exploratory";
export type BranchKind = "waiting" | "blocker" | "curiosity" | "unknown";

export interface NewQuestInput {
  title: string;
  outcome: string;
  commitment: Commitment;
  project?: string;
  origin?: string;
  trigger?: string;
  kind?: BranchKind;
}

export interface DeclareQuestInput {
  sessionId: string;
  parentSessionId?: string;
  questId?: string;
  newQuest?: NewQuestInput;
  plan: string[];
  scope: "session" | "subagent";
  declaredBy: "agent" | "hero";
  at: string;
  heroId: string;
  /**
   * Ends the named quest's active declaration for this session. A session
   * accumulates declarations, so retiring one is its own event rather than the
   * side effect of declaring something else.
   */
  done?: boolean;
}

export interface DeclareQuestResult {
  questId: string;
  created: boolean;
}

export function declareQuest(
  store: EventStore,
  database: Database,
  input: DeclareQuestInput,
): DeclareQuestResult {
  let questId = input.questId ?? null;
  let created = false;

  // `--done` always names a quest that already exists: there is nothing to
  // create, and no `new` payload to write.
  if (input.done === true && questId === null) {
    throw new Error("declareQuest: --done requires an existing quest id");
  }

  if (input.done !== true && questId === null && input.newQuest) {
    questId = newUlid();
    applyIncremental(
      database,
      store.append({
        actor: input.declaredBy === "hero" ? "hero" : "hook",
        kind: "quest.created",
        subject: questId,
        at: input.at,
        payload: {
          owner: { kind: "hero", id: input.heroId },
          title: input.newQuest.title,
          outcome: input.newQuest.outcome,
          commitment: input.newQuest.commitment,
          confirmed: true,
          origin_kind: "declared",
        },
      }),
    );
    created = true;
    if (input.newQuest.origin) {
      applyIncremental(
        database,
        store.append({
          actor: input.declaredBy === "hero" ? "hero" : "hook",
          kind: "quest.branched",
          subject: input.newQuest.origin,
          at: input.at,
          payload: {
            deviates_from: questId,
            trigger: input.newQuest.trigger ?? "unknown",
            kind: input.newQuest.kind ?? "unknown",
          },
        }),
      );
    }
  }

  if (questId === null) {
    throw new Error("declareQuest: exactly one of questId or newQuest is required");
  }

  applyIncremental(
    database,
    store.append({
      actor: input.declaredBy === "hero" ? "hero" : "hook",
      kind: "quest.declared",
      subject: questId,
      at: input.at,
      sessionId: input.sessionId,
      payload: {
        session_id: input.sessionId,
        quest_id: questId,
        done: input.done === true ? true : undefined,
        new:
          input.done === true || input.newQuest === undefined
            ? undefined
            : {
                title: input.newQuest.title,
                outcome: input.newQuest.outcome,
                commitment: input.newQuest.commitment,
                project: input.newQuest.project,
                origin: input.newQuest.origin,
                trigger: input.newQuest.trigger,
                kind: input.newQuest.kind,
              },
        plan: input.plan,
        scope: input.scope,
        parent_session_id: input.parentSessionId,
        declared_by: input.declaredBy,
        at: input.at,
      },
    }),
  );

  return { questId, created };
}

export interface DeclaredQuest {
  questId: string;
  title: string;
  outcome: string | null;
  plan: string[];
  scope: "session" | "subagent";
  parentSessionId: string | null;
}

function resolveDeclaration(
  database: Database,
  sessionId: string,
  scope: "session" | "subagent",
  at: string,
  parentSessionId?: string,
): DeclaredQuest | null {
  const rows = database
    .query(
      `SELECT payload FROM events
        WHERE kind = 'quest.declared' AND json_extract(payload, '$.session_id') = ? AND at <= ?
        ORDER BY at DESC, id DESC`,
    )
    .all(sessionId, at) as { payload: string }[];

  for (const row of rows) {
    const payload = JSON.parse(row.payload) as {
      session_id: string;
      quest_id?: string;
      scope: string;
      parent_session_id?: string;
      plan: string[];
    };
    if (payload.scope !== scope) continue;
    if (scope === "session" && payload.session_id !== sessionId) continue;
    if (
      scope === "subagent" &&
      (payload.session_id !== sessionId || payload.parent_session_id !== parentSessionId)
    ) {
      continue;
    }

    const questId = payload.quest_id;
    if (!questId) continue;
    const quest = database
      .query("SELECT title, outcome FROM quests WHERE id = ? AND retracted_at IS NULL")
      .get(questId) as { title: string; outcome: string | null } | null;
    if (!quest) continue;
    return {
      questId,
      title: quest.title,
      outcome: quest.outcome,
      plan: payload.plan,
      scope: payload.scope as "session" | "subagent",
      parentSessionId: payload.parent_session_id ?? null,
    };
  }
  return null;
}

/**
 * A quest a session declared and has not ended, with the alias the verifier
 * names it by. Aliases are assigned fresh over the surviving set on every call,
 * exactly as `buildWindow` assigns stint aliases -- never persisted, never
 * carried across calls.
 */
export interface ActiveDeclaredQuest extends DeclaredQuest {
  alias: string;
}

/**
 * Every quest still active for a session at `at`. A `quest.declared` event marks
 * its quest active from `at` onward; one carrying `done: true` ends it. A session
 * legitimately pursues several quests at once, so "latest wins"
 * (`currentDeclaredQuest`) cannot express what is actually declared -- declaring
 * a second quest would silently retire the first.
 */
export function activeDeclaredQuests(
  database: Database,
  input: { sessionId: string; at: string },
): ActiveDeclaredQuest[] {
  const rows = database
    .query(
      `SELECT payload, at FROM events
        WHERE kind = 'quest.declared' AND json_extract(payload, '$.session_id') = ?
          AND json_extract(payload, '$.scope') = 'session' AND at <= ?
        ORDER BY at ASC, id ASC`,
    )
    .all(input.sessionId, input.at) as { payload: string; at: string }[];

  // Insertion order is declaration order, so a quest re-declared later to amend
  // its plan keeps its position and its alias does not jump around.
  const active = new Map<string, { plan: string[]; at: string }>();
  for (const row of rows) {
    const payload = JSON.parse(row.payload) as {
      quest_id?: string;
      plan?: string[];
      done?: boolean;
    };
    const questId = payload.quest_id;
    if (!questId) continue;
    if (payload.done === true) {
      active.delete(questId);
      continue;
    }
    const existing = active.get(questId);
    if (existing) {
      existing.plan = payload.plan ?? [];
      existing.at = row.at;
      continue;
    }
    active.set(questId, { plan: payload.plan ?? [], at: row.at });
  }

  const result: ActiveDeclaredQuest[] = [];
  let aliasNumber = 0;
  for (const [questId, entry] of active) {
    const quest = database
      .query("SELECT title, outcome FROM quests WHERE id = ? AND retracted_at IS NULL")
      .get(questId) as { title: string; outcome: string | null } | null;
    if (!quest) continue;
    aliasNumber += 1;
    result.push({
      questId,
      title: quest.title,
      outcome: quest.outcome,
      plan: entry.plan,
      scope: "session",
      parentSessionId: null,
      alias: `Q${aliasNumber}`,
    });
  }
  return result;
}

export function currentDeclaredQuest(
  database: Database,
  input: { sessionId: string; at: string },
): DeclaredQuest | null {
  return resolveDeclaration(database, input.sessionId, "session", input.at);
}

export function currentDeclaredQuestForSubagent(
  database: Database,
  input: { sessionId: string; parentSessionId: string; at: string },
): DeclaredQuest | null {
  return resolveDeclaration(database, input.sessionId, "subagent", input.at, input.parentSessionId);
}

export function hasAnyDeclaration(database: Database, sessionId: string): boolean {
  const row = database
    .query(
      `SELECT 1 FROM events
        WHERE kind = 'quest.declared' AND json_extract(payload, '$.session_id') = ?
        LIMIT 1`,
    )
    .get(sessionId);
  return row !== null;
}
