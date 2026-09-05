import type { Database } from "bun:sqlite";
import { parseArgs } from "node:util";
import type { Config } from "../config/env";
import { answerQuestion, assignActivity } from "./api";
import type { IntentConfig } from "./config";
import { assertEditIntent } from "./edit-intent";
import { newUlid } from "./ids";
import { applyIncremental, ensureTables, rebuildAll } from "./projections";
import { resolveQuest } from "./projections/quest";
import { registerAllProjections } from "./projections/register";
import { EventStore } from "./store";
import { stateAsOf } from "./time-travel";

registerAllProjections();

export interface IntentContext {
  database: Database;
  config: Config;
  intentConfig: IntentConfig;
  stdout: (line: string) => void;
}

function requireHero(database: Database): string {
  const row = database.query("SELECT id FROM heroes LIMIT 1").get() as { id: string } | null;
  if (!row) throw new Error("run `tempad hero init` first");
  return row.id;
}

function findPartyBySlug(database: Database, slug: string): { id: string } | null {
  return database.query("SELECT id FROM parties WHERE slug = ?").get(slug) as { id: string } | null;
}

function resolveOwner(database: Database, owner: string): { kind: "hero" | "party"; id: string } {
  if (owner === "hero") {
    return { kind: "hero", id: requireHero(database) };
  }
  if (owner.startsWith("party:")) {
    const slug = owner.slice("party:".length);
    const party = findPartyBySlug(database, slug);
    if (!party) throw new Error(`unknown party: ${slug}`);
    return { kind: "party", id: party.id };
  }
  throw new Error(`invalid --owner: ${owner}`);
}

function runHeroCommand(args: string[], context: IntentContext): number {
  const [subcommand, ...rest] = args;
  if (subcommand === "init") {
    const name = rest[0];
    if (!name) {
      console.error('usage: tempad hero init "<name>"');
      return 2;
    }
    const existing = context.database.query("SELECT id FROM heroes LIMIT 1").get();
    if (existing) {
      console.error("hero already exists");
      return 1;
    }
    const store = new EventStore(context.database);
    const event = store.append({
      actor: "hero",
      kind: "hero.created",
      subject: newUlid(),
      payload: { name },
    });
    applyIncremental(context.database, event);
    return 0;
  }
  console.error('usage: tempad hero init "<name>"');
  return 2;
}

function runPartyCommand(args: string[], context: IntentContext): number {
  const [subcommand, ...rest] = args;
  const store = new EventStore(context.database);

  if (subcommand === "add") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { joined: { type: "string" } },
      strict: true,
      allowPositionals: true,
    });
    const [slug, name] = positionals;
    if (!slug || !name) {
      console.error('usage: tempad party add <slug> "<name>" [--joined YYYY-MM-DD]');
      return 2;
    }
    if (findPartyBySlug(context.database, slug)) {
      console.error(`party already exists: ${slug}`);
      return 1;
    }
    const heroId = requireHero(context.database);
    const partyId = newUlid();
    applyIncremental(
      context.database,
      store.append({
        actor: "hero",
        kind: "party.created",
        subject: partyId,
        payload: { slug, name },
      }),
    );
    const joined = values.joined ? `${values.joined}T00:00:00.000Z` : undefined;
    applyIncremental(
      context.database,
      store.append({
        actor: "hero",
        kind: "membership.joined",
        subject: newUlid(),
        payload: { hero: heroId, party: partyId, joined },
        at: joined,
      }),
    );
    return 0;
  }

  if (subcommand === "leave") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { reason: { type: "string" } },
      strict: true,
      allowPositionals: true,
    });
    const slug = positionals[0];
    if (!slug) {
      console.error('usage: tempad party leave <slug> --reason "..."');
      return 2;
    }
    const party = findPartyBySlug(context.database, slug);
    if (!party) {
      console.error(`unknown party: ${slug}`);
      return 1;
    }
    const heroId = requireHero(context.database);
    const membership = context.database
      .query("SELECT id FROM memberships WHERE hero_id = ? AND party_id = ? AND left_at IS NULL")
      .get(heroId, party.id) as { id: string } | null;
    if (!membership) {
      console.error(`hero is not a member of ${slug}`);
      return 1;
    }
    applyIncremental(
      context.database,
      store.append({
        actor: "hero",
        kind: "membership.left",
        subject: membership.id,
        payload: { reason: values.reason },
      }),
    );
    return 0;
  }

  if (subcommand === "list") {
    const rows = context.database.query("SELECT slug, name FROM parties ORDER BY name").all() as {
      slug: string;
      name: string;
    }[];
    for (const row of rows) context.stdout(`${row.slug}  ${row.name}`);
    return 0;
  }

  console.error("usage: tempad party add|leave|list ...");
  return 2;
}

function runClientCommand(args: string[], context: IntentContext): number {
  const [subcommand, ...rest] = args;
  if (subcommand === "add") {
    const [slug, name] = rest;
    if (!slug || !name) {
      console.error('usage: tempad client add <slug> "<name>"');
      return 2;
    }
    const existing = context.database.query("SELECT id FROM clients WHERE slug = ?").get(slug);
    if (existing) {
      console.error(`client already exists: ${slug}`);
      return 1;
    }
    const store = new EventStore(context.database);
    applyIncremental(
      context.database,
      store.append({
        actor: "hero",
        kind: "client.created",
        subject: newUlid(),
        payload: { slug, name },
      }),
    );
    return 0;
  }
  console.error('usage: tempad client add <slug> "<name>"');
  return 2;
}

function parseOwnerFlag(
  database: Database,
  values: Record<string, unknown>,
): { kind: "hero" | "party"; id: string } {
  const owner = values.owner;
  if (typeof owner !== "string") throw new Error("--owner is required (hero or party:<slug>)");
  return resolveOwner(database, owner);
}

function runGoalCommand(args: string[], context: IntentContext): number {
  const [subcommand, ...rest] = args;
  const store = new EventStore(context.database);

  if (subcommand === "add") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { owner: { type: "string" }, statement: { type: "string" } },
      strict: true,
      allowPositionals: true,
    });
    const title = positionals[0];
    if (!title) {
      console.error(
        'usage: tempad goal add --owner hero|party:<slug> "<title>" [--statement "..."]',
      );
      return 2;
    }
    const owner = parseOwnerFlag(context.database, values);
    applyIncremental(
      context.database,
      store.append({
        actor: "hero",
        kind: "goal.created",
        subject: newUlid(),
        payload: { owner, title, statement: values.statement },
      }),
    );
    return 0;
  }

  if (subcommand === "reword") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { statement: { type: "string" } },
      strict: true,
      allowPositionals: true,
    });
    const [id, title] = positionals;
    if (!id || !title) {
      console.error('usage: tempad goal reword <id> "<title>" [--statement]');
      return 2;
    }
    applyIncremental(
      context.database,
      store.append({
        actor: "hero",
        kind: "goal.reworded",
        subject: id,
        payload: { title, statement: values.statement },
      }),
    );
    return 0;
  }

  if (subcommand === "replace") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { statement: { type: "string" }, reason: { type: "string" } },
      strict: true,
      allowPositionals: true,
    });
    const [id, title] = positionals;
    if (!id || !title || !values.reason) {
      console.error('usage: tempad goal replace <id> "<title>" [--statement] --reason "..."');
      return 2;
    }
    const old = context.database
      .query("SELECT owner_kind, owner_id FROM goals WHERE id = ?")
      .get(id) as { owner_kind: "hero" | "party"; owner_id: string } | null;
    if (!old) {
      console.error(`unknown goal: ${id}`);
      return 1;
    }
    const newId = newUlid();
    applyIncremental(
      context.database,
      store.append({
        actor: "hero",
        kind: "goal.created",
        subject: newId,
        payload: {
          owner: { kind: old.owner_kind, id: old.owner_id },
          title,
          statement: values.statement,
        },
      }),
    );
    applyIncremental(
      context.database,
      store.append({
        actor: "hero",
        kind: "goal.ended",
        subject: id,
        payload: { reason: "replaced", replaced_by: newId, note: values.reason },
      }),
    );
    return 0;
  }

  if (subcommand === "end") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { reason: { type: "string" } },
      strict: true,
      allowPositionals: true,
    });
    const id = positionals[0];
    if (!id || !values.reason) {
      console.error("usage: tempad goal end <id> --reason achieved|abandoned");
      return 2;
    }
    applyIncremental(
      context.database,
      store.append({
        actor: "hero",
        kind: "goal.ended",
        subject: id,
        payload: { reason: values.reason },
      }),
    );
    return 0;
  }

  if (subcommand === "edit") {
    const [id, title] = rest;
    if (!id || !title) {
      console.error('usage: tempad goal edit <id> "<title>"');
      return 2;
    }
    assertEditIntent(context.database, "goal", id, undefined);
    applyIncremental(
      context.database,
      store.append({ actor: "hero", kind: "goal.reworded", subject: id, payload: { title } }),
    );
    return 0;
  }

  if (subcommand === "list") {
    const { values } = parseArgs({
      args: rest,
      options: { all: { type: "boolean", default: false }, "as-of": { type: "string" } },
      strict: true,
    });
    const source = values["as-of"]
      ? stateAsOf(context.database, values["as-of"])
      : context.database;
    const where = values.all ? "" : "WHERE ended_at IS NULL";
    const rows = source
      .query(`SELECT id, title, owner_kind, end_reason FROM goals ${where} ORDER BY created_at`)
      .all() as {
      id: string;
      title: string;
      owner_kind: string;
      end_reason: string | null;
    }[];
    for (const row of rows) {
      const suffix = row.end_reason ? ` [ended ${row.end_reason}]` : "";
      context.stdout(`${row.id}  ${row.title}  (${row.owner_kind})${suffix}`);
    }
    return 0;
  }

  console.error("usage: tempad goal add|reword|replace|end|edit|list ...");
  return 2;
}

function parseBudget(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const match = /^(\d+)(h|m)$/.exec(raw);
  if (!match?.[1] || !match[2]) throw new Error(`invalid --budget: ${raw} (expected Nh or Nm)`);
  const amount = Number.parseInt(match[1], 10);
  return match[2] === "h" ? amount * 60 : amount;
}

function findQuest(
  database: Database,
  id: string,
): { owner_kind: string; owner_id: string } | null {
  return database.query("SELECT owner_kind, owner_id FROM quests WHERE id = ?").get(id) as {
    owner_kind: string;
    owner_id: string;
  } | null;
}

function runQuestCommand(args: string[], context: IntentContext): number {
  const [subcommand, ...rest] = args;
  const store = new EventStore(context.database);

  if (subcommand === "add") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        owner: { type: "string" },
        goal: { type: "string" },
        objective: { type: "string" },
        done: { type: "string" },
        due: { type: "string" },
        budget: { type: "string" },
        commitment: { type: "string" },
      },
      strict: true,
      allowPositionals: true,
    });
    const title = positionals[0];
    if (!title) {
      console.error(
        'usage: tempad quest add --owner hero|party:<slug> [--goal <id>] "<title>" ...',
      );
      return 2;
    }
    const owner = parseOwnerFlag(context.database, values);
    applyIncremental(
      context.database,
      store.append({
        actor: "hero",
        kind: "quest.created",
        subject: newUlid(),
        payload: {
          owner,
          goal: values.goal,
          title,
          objective: values.objective,
          done_condition: values.done,
          due: values.due,
          budget_minutes: parseBudget(values.budget),
          commitment: values.commitment,
          confirmed: true,
        },
      }),
    );
    return 0;
  }

  if (subcommand === "reword") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { objective: { type: "string" } },
      strict: true,
      allowPositionals: true,
    });
    const [id, title] = positionals;
    if (!id || !title) {
      console.error('usage: tempad quest reword <id> "<title>" [--objective]');
      return 2;
    }
    applyIncremental(
      context.database,
      store.append({
        actor: "hero",
        kind: "quest.reworded",
        subject: id,
        payload: { title, objective: values.objective },
      }),
    );
    return 0;
  }

  if (subcommand === "replace") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { objective: { type: "string" }, reason: { type: "string" } },
      strict: true,
      allowPositionals: true,
    });
    const [id, title] = positionals;
    if (!id || !title || !values.reason) {
      console.error('usage: tempad quest replace <id> "<title>" [--objective] --reason "..."');
      return 2;
    }
    const old = findQuest(context.database, id);
    if (!old) {
      console.error(`unknown quest: ${id}`);
      return 1;
    }
    const newId = newUlid();
    applyIncremental(
      context.database,
      store.append({
        actor: "hero",
        kind: "quest.created",
        subject: newId,
        payload: {
          owner: { kind: old.owner_kind, id: old.owner_id },
          title,
          objective: values.objective,
          confirmed: true,
        },
      }),
    );
    applyIncremental(
      context.database,
      store.append({
        actor: "hero",
        kind: "quest.ended",
        subject: id,
        payload: { reason: "replaced", replaced_by: newId, note: values.reason },
      }),
    );
    return 0;
  }

  if (subcommand === "end") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { reason: { type: "string" } },
      strict: true,
      allowPositionals: true,
    });
    const id = positionals[0];
    if (!id || !values.reason) {
      console.error("usage: tempad quest end <id> --reason ...");
      return 2;
    }
    applyIncremental(
      context.database,
      store.append({
        actor: "hero",
        kind: "quest.ended",
        subject: id,
        payload: { reason: values.reason },
      }),
    );
    return 0;
  }

  if (subcommand === "edit") {
    const [id, title] = rest;
    if (!id || !title) {
      console.error('usage: tempad quest edit <id> "<title>"');
      return 2;
    }
    assertEditIntent(context.database, "quest", id, undefined);
    applyIncremental(
      context.database,
      store.append({ actor: "hero", kind: "quest.reworded", subject: id, payload: { title } }),
    );
    return 0;
  }

  if (subcommand === "confirm") {
    const id = rest[0];
    if (!id) {
      console.error("usage: tempad quest confirm <id>");
      return 2;
    }
    applyIncremental(
      context.database,
      store.append({
        actor: "hero",
        kind: "quest.confirmed",
        subject: resolveQuest(context.database, id),
        payload: {},
      }),
    );
    return 0;
  }

  if (subcommand === "merge") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { into: { type: "string" } },
      strict: true,
      allowPositionals: true,
    });
    const id = positionals[0];
    if (!id || !values.into) {
      console.error("usage: tempad quest merge <id> --into <id>");
      return 2;
    }
    applyIncremental(
      context.database,
      store.append({
        actor: "hero",
        kind: "quest.merged",
        subject: id,
        payload: { into: values.into },
      }),
    );
    return 0;
  }

  if (["pause", "resume", "done", "abandon"].includes(subcommand ?? "")) {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { reason: { type: "string" } },
      strict: true,
      allowPositionals: true,
    });
    const id = positionals[0];
    if (!id) {
      console.error(`usage: tempad quest ${subcommand} <id> [--reason]`);
      return 2;
    }
    const stateBySubcommand: Record<string, string> = {
      pause: "paused",
      resume: "resumed",
      done: "done",
      abandon: "abandoned",
    };
    applyIncremental(
      context.database,
      store.append({
        actor: "hero",
        kind: "quest.lifecycle",
        subject: resolveQuest(context.database, id),
        payload: { state: stateBySubcommand[subcommand as string], reason: values.reason },
      }),
    );
    return 0;
  }

  if (subcommand === "branch") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        "from-activity": { type: "string" },
        trigger: { type: "string" },
        kind: { type: "string", default: "unknown" },
      },
      strict: true,
      allowPositionals: true,
    });
    const id = positionals[0];
    if (!id || !values["from-activity"] || !values.trigger) {
      console.error(
        'usage: tempad quest branch <id> --from-activity <activity-id> --trigger "..." [--kind ...]',
      );
      return 2;
    }
    applyIncremental(
      context.database,
      store.append({
        actor: "hero",
        kind: "quest.branched",
        subject: resolveQuest(context.database, id),
        payload: {
          from_activity: values["from-activity"],
          trigger: values.trigger,
          kind: values.kind,
        },
      }),
    );
    return 0;
  }

  if (subcommand === "return") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { to: { type: "string" } },
      strict: true,
      allowPositionals: true,
    });
    const id = positionals[0];
    if (!id || !values.to) {
      console.error("usage: tempad quest return <id> --to <quest-id>");
      return 2;
    }
    applyIncremental(
      context.database,
      store.append({
        actor: "hero",
        kind: "quest.returned",
        subject: resolveQuest(context.database, id),
        payload: { to_quest: resolveQuest(context.database, values.to) },
      }),
    );
    return 0;
  }

  if (subcommand === "list") {
    const { values } = parseArgs({
      args: rest,
      options: {
        all: { type: "boolean", default: false },
        unconfirmed: { type: "boolean", default: false },
        side: { type: "boolean", default: false },
        "as-of": { type: "string" },
      },
      strict: true,
    });
    const source = values["as-of"]
      ? stateAsOf(context.database, values["as-of"])
      : context.database;
    const clauses: string[] = [];
    if (!values.all) {
      clauses.push("ended_at IS NULL");
      clauses.push("merged_into IS NULL");
    }
    if (values.unconfirmed) clauses.push("confirmed = 0");
    if (values.side) clauses.push("origin_activity_id IS NOT NULL");
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = source
      .query(`SELECT id, title, state, confirmed FROM quests ${where} ORDER BY created_at`)
      .all() as { id: string; title: string; state: string; confirmed: number }[];
    for (const row of rows) {
      const unconfirmed = row.confirmed === 0 ? " [unconfirmed]" : "";
      context.stdout(`${row.id}  ${row.title}  (${row.state})${unconfirmed}`);
    }
    return 0;
  }

  console.error(
    "usage: tempad quest add|reword|replace|end|edit|confirm|merge|pause|resume|done|abandon|branch|return|list ...",
  );
  return 2;
}

function runActivityCommand(args: string[], context: IntentContext): number {
  const [subcommand, ...rest] = args;
  if (subcommand === "list") {
    const { values } = parseArgs({
      args: rest,
      options: { open: { type: "boolean", default: false }, quest: { type: "string" } },
      strict: true,
    });
    const clauses: string[] = [];
    const parameters: string[] = [];
    if (values.open) clauses.push("closed_at IS NULL");
    if (values.quest) {
      clauses.push("quest_id = ?");
      parameters.push(values.quest);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = context.database
      .query(
        `SELECT id, objective, quest_id, closed_at FROM activities ${where} ORDER BY opened_at`,
      )
      .all(...parameters) as {
      id: string;
      objective: string;
      quest_id: string | null;
      closed_at: string | null;
    }[];
    for (const row of rows) {
      const status = row.closed_at ? "closed" : "open";
      context.stdout(
        `${row.id}  ${row.objective}  (${status})${row.quest_id ? ` quest=${row.quest_id}` : ""}`,
      );
    }
    return 0;
  }
  console.error("usage: tempad activity list [--open] [--quest <id>]");
  return 2;
}

function runTraceCommand(args: string[], context: IntentContext): number {
  const [subcommand, ...rest] = args;
  if (subcommand === "list") {
    const { values } = parseArgs({
      args: rest,
      options: { since: { type: "string" }, activity: { type: "string" } },
      strict: true,
    });
    const clauses: string[] = [];
    const parameters: string[] = [];
    if (values.since) {
      clauses.push("started_at >= ?");
      parameters.push(values.since);
    }
    if (values.activity) {
      clauses.push("activity_id = ?");
      parameters.push(values.activity);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = context.database
      .query(
        `SELECT id, activity_id, what, why, confidence FROM traces ${where} ORDER BY started_at`,
      )
      .all(...parameters) as {
      id: string;
      activity_id: string;
      what: string;
      why: string;
      confidence: number;
    }[];
    for (const row of rows) {
      context.stdout(
        `${row.id}  ${row.what}  why=${row.why}  confidence=${row.confidence}  activity=${row.activity_id}`,
      );
    }
    return 0;
  }
  console.error("usage: tempad trace list [--since <iso>] [--activity <id>]");
  return 2;
}

function runAnswerCommand(args: string[], context: IntentContext): number {
  const { values, positionals } = parseArgs({
    args,
    options: { quest: { type: "string" }, why: { type: "string" } },
    strict: true,
    allowPositionals: true,
  });
  const questionId = positionals[0];
  if (!questionId || !values.quest) {
    console.error('usage: tempad answer <question-id> --quest <id|new:"title"> [--why "..."]');
    return 2;
  }
  const question = context.database
    .query("SELECT trace_id FROM questions WHERE id = ?")
    .get(questionId) as { trace_id: string } | null;
  if (!question) {
    console.error(`unknown question: ${questionId}`);
    return 1;
  }
  const trace = context.database
    .query("SELECT activity_id FROM traces WHERE id = ?")
    .get(question.trace_id) as { activity_id: string } | null;
  if (!trace) {
    console.error(`unknown trace: ${question.trace_id}`);
    return 1;
  }

  const store = new EventStore(context.database);
  answerQuestion(store, context.database, questionId, values.quest, values.why, "hero");

  let questId = values.quest;
  if (values.quest.startsWith("new:")) {
    const title = values.quest.slice("new:".length);
    const heroId = requireHero(context.database);
    questId = newUlid();
    applyIncremental(
      context.database,
      store.append({
        actor: "hero",
        kind: "quest.created",
        subject: questId,
        payload: { owner: { kind: "hero", id: heroId }, title, confirmed: false },
      }),
    );
  } else {
    questId = resolveQuest(context.database, questId);
  }
  assignActivity(store, context.database, trace.activity_id, questId, "hero");
  return 0;
}

function runRebuildCommand(args: string[], context: IntentContext): number {
  const { values } = parseArgs({ args, options: { until: { type: "string" } }, strict: true });
  rebuildAll(context.database, { until: values.until });
  return 0;
}

export async function runIntentCommand(args: string[], context: IntentContext): Promise<number> {
  const [command, ...rest] = args;
  try {
    ensureTables(context.database);
    switch (command) {
      case "hero":
        return runHeroCommand(rest, context);
      case "party":
        return runPartyCommand(rest, context);
      case "client":
        return runClientCommand(rest, context);
      case "goal":
        return runGoalCommand(rest, context);
      case "quest":
        return runQuestCommand(rest, context);
      case "activity":
        return runActivityCommand(rest, context);
      case "trace":
        return runTraceCommand(rest, context);
      case "answer":
        return runAnswerCommand(rest, context);
      case "rebuild":
        return runRebuildCommand(rest, context);
      default:
        console.error("unknown intent command");
        return 2;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export { resolveOwner };
