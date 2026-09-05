import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db/database";
import { ensureTables } from "../../src/intent/projections";
import { registerAllProjections } from "../../src/intent/projections/register";
import { buildWindow, findSessionFile } from "../../src/w5/window";

registerAllProjections();

function seedSession(database: ReturnType<typeof openDatabase>) {
  database
    .query(
      `INSERT INTO claude_sessions
        (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch,
         started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
       VALUES ('s1', '/c', 'p', '/c/p/s1.jsonl', '/w/marko-ui', 'personal', 'marko-ui', 'marko-ui', 'main',
               '2026-09-04T14:00:00.000Z', '2026-09-04T15:20:00.000Z', 3, 0, '[]', 'host', '2026-09-04T15:20:00.000Z')`,
    )
    .run();

  const insertMessage = database.query(
    `INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview)
     VALUES (?, 's1', ?, ?, 0, ?)`,
  );
  insertMessage.run("m1", "2026-09-04T14:00:00.000Z", "user", "old message before cut");
  insertMessage.run("m2", "2026-09-04T15:00:00.000Z", "user", "fix the walk order bug");
  insertMessage.run("m3", "2026-09-04T15:20:00.000Z", "user", "wait, what does Astryx do?");
}

describe("window builder", () => {
  test("findSessionFile returns the file path", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database);
    expect(findSessionFile(database, "s1")).toBe("/c/p/s1.jsonl");
    expect(findSessionFile(database, "missing")).toBeNull();
  });

  test("buildWindow shapes messages, open quests, sinceTs cut and maxMessages cap", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database);

    database
      .query(
        "INSERT INTO quests (id, owner_kind, owner_id, title, objective, confirmed, revision, state, created_at) VALUES ('Q1', 'hero', 'H1', 'Ship marko-ui', '86 components', 1, 1, 'started', '2026-09-01T00:00:00.000Z')",
      )
      .run();
    database
      .query(
        "INSERT INTO activities (id, quest_id, objective, opened_at, revision) VALUES ('A1', 'Q1', 'fixing walk order', '2026-09-04T14:00:00.000Z', 1)",
      )
      .run();
    database
      .query(
        `INSERT INTO traces (id, activity_id, tool, place, source, started_at, ended_at, who, what, why, where_text, how, confidence, classified_by, session_id, recorded_at)
         VALUES ('T1', 'A1', 'claude-code', 'marko-ui', 'w5', '2026-09-04T14:00:00.000Z', '2026-09-04T14:30:00.000Z', 'hero', 'fixing walk order', 'ship', 'personal/marko-ui', 'claude-code', 0.9, 'assistant', 's1', '2026-09-04T14:30:00.000Z')`,
      )
      .run();

    const windowSinceCut = buildWindow(database, {
      sessionId: "s1",
      sinceTs: "2026-09-04T14:30:00.000Z",
      maxMessages: 50,
    });
    expect(windowSinceCut.messages.map((m) => m.text)).toEqual([
      "fix the walk order bug",
      "wait, what does Astryx do?",
    ]);
    expect(windowSinceCut.openQuests).toEqual([
      {
        id: "Q1",
        title: "Ship marko-ui",
        objective: "86 components",
        lastActivityAt: "2026-09-04T14:00:00.000Z",
      },
    ]);
    expect(windowSinceCut.previousTrace).toEqual({
      activityId: "A1",
      what: "fixing walk order",
      questId: "Q1",
    });

    const windowCapped = buildWindow(database, { sessionId: "s1", sinceTs: null, maxMessages: 2 });
    expect(windowCapped.messages.map((m) => m.text)).toEqual([
      "fix the walk order bug",
      "wait, what does Astryx do?",
    ]);
  });
});
