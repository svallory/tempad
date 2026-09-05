import { describe, expect, test } from "bun:test";
import type { Config } from "../../src/config/env";
import { openDatabase } from "../../src/db/database";
import type { W5Config } from "../../src/intent/config";
import { applyIncremental, ensureTables } from "../../src/intent/projections";
import { registerAllProjections } from "../../src/intent/projections/register";
import { EventStore } from "../../src/intent/store";
import { backfill } from "../../src/w5/backfill";
import type { Classifier, ClassifierResult, ClassifierWindow } from "../../src/w5/classifier";

registerAllProjections();

const config: W5Config = {
  model: "m",
  throttleMinutes: 10,
  watchTurns: 3,
  askMinActivityMinutes: 20,
  askBudgetMinutes: 30,
  askExpireTurns: 2,
  backfillDays: 15,
};

function makeConfig(): Config {
  return {
    mondayApiToken: "t",
    mondayUser: "u",
    ghUser: "u",
    ghOrgs: [],
    ghIncludePersonal: false,
    ghToken: undefined,
    gitAuthorEmails: [],
    claudeDirs: [],
    hostSlug: "host",
    tz: "UTC",
    since: "2020-01-01",
    home: "/tmp",
  };
}

class FakeClassifier implements Classifier {
  public calls = 0;
  async classify(window: ClassifierWindow): Promise<ClassifierResult> {
    this.calls += 1;
    const first = window.messages[0]?.ts ?? "2026-09-04T15:00:00.000Z";
    const last = window.messages.at(-1)?.ts ?? first;
    return {
      segments: [
        {
          startedAt: first,
          endedAt: last,
          what: "work",
          why: "ship",
          matchedQuest: null,
          proposedQuest: null,
          matchedActivity: null,
          isSwitch: false,
          trigger: null,
          confidence: 0.9,
          questions: [],
        },
      ],
    };
  }
}

function seedHero(database: ReturnType<typeof openDatabase>) {
  ensureTables(database);
  const store = new EventStore(database);
  applyIncremental(
    database,
    store.append({
      actor: "hero",
      kind: "hero.created",
      subject: "H1",
      payload: { name: "Saulo" },
    }),
  );
}

function seedSession(
  database: ReturnType<typeof openDatabase>,
  input: { id: string; endedAt: string },
) {
  database
    .query(
      `INSERT INTO claude_sessions
        (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch,
         started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
       VALUES (?, '/c', 'p', ?, '/w/p', 'personal', 'p', 't', 'main', ?, ?, 1, 0, '[]', 'host', ?)`,
    )
    .run(input.id, `/c/p/${input.id}.jsonl`, input.endedAt, input.endedAt, input.endedAt);
  database
    .query(
      "INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview) VALUES (?, ?, ?, 'user', 0, 'work')",
    )
    .run(`${input.id}-m1`, input.id, input.endedAt);
}

describe("backfill", () => {
  test("classifies both sessions, a second run classifies none, asking disabled leaves no questions", async () => {
    const database = openDatabase(":memory:");
    seedHero(database);
    seedSession(database, { id: "s1", endedAt: "2026-09-04T15:20:00.000Z" });
    seedSession(database, { id: "s2", endedAt: "2026-09-04T16:00:00.000Z" });

    const classifier = new FakeClassifier();
    const logs: string[] = [];

    const firstResult = await backfill(database, makeConfig(), config, classifier, {
      days: 15,
      now: "2026-09-04T17:00:00.000Z",
      log: (line) => logs.push(line),
    });

    expect(firstResult.sessionsClassified).toBe(2);
    expect(classifier.calls).toBe(2);

    const questionCount = database.query("SELECT COUNT(*) as count FROM questions").get() as {
      count: number;
    };
    expect(questionCount.count).toBe(0);

    const secondResult = await backfill(database, makeConfig(), config, classifier, {
      days: 15,
      now: "2026-09-04T17:00:00.000Z",
      log: (line) => logs.push(line),
    });

    expect(secondResult.sessionsClassified).toBe(0);
  });
});
