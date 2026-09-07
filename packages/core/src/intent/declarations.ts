import type { Database } from "bun:sqlite";
import { newUlid } from "./ids";
import { applyIncremental } from "./projections";
import type { EventStore } from "./store";

export type Commitment = "promised" | "personal" | "exploratory";
export type BranchKind = "waiting" | "blocker" | "curiosity" | "unknown";

export interface NewQuestInput {
  title: string;
  objective: string;
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

  if (questId === null && input.newQuest) {
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
          objective: input.newQuest.objective,
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
            from_activity: questId,
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
        new: input.newQuest
          ? {
              title: input.newQuest.title,
              objective: input.newQuest.objective,
              commitment: input.newQuest.commitment,
              project: input.newQuest.project,
              origin: input.newQuest.origin,
              trigger: input.newQuest.trigger,
              kind: input.newQuest.kind,
            }
          : undefined,
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
  objective: string | null;
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
      .query("SELECT title, objective FROM quests WHERE id = ? AND retracted_at IS NULL")
      .get(questId) as { title: string; objective: string | null } | null;
    if (!quest) continue;
    return {
      questId,
      title: quest.title,
      objective: quest.objective,
      plan: payload.plan,
      scope: payload.scope as "session" | "subagent",
      parentSessionId: payload.parent_session_id ?? null,
    };
  }
  return null;
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
