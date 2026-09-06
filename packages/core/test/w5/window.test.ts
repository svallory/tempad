import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db/database";
import { ensureTables } from "../../src/intent/projections";
import { registerAllProjections } from "../../src/intent/projections/register";
import { buildWindow, findSessionFile } from "../../src/w5/window";

registerAllProjections();

const memoryInput = { maxMessages: 50, memoryHours: 8, memoryActivities: 10, overlapMessages: 3 };

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
  insertMessage.run("m0", "2026-09-04T13:50:00.000Z", "user", "even older message");
  insertMessage.run("m1", "2026-09-04T14:00:00.000Z", "user", "old message before cut");
  insertMessage.run("m2", "2026-09-04T15:00:00.000Z", "user", "fix the walk order bug");
  insertMessage.run("m3", "2026-09-04T15:20:00.000Z", "user", "wait, what does Astryx do?");
}

/** An earlier session in the same project, whose activity was closed by session end. */
function seedEarlierSession(database: ReturnType<typeof openDatabase>) {
  database
    .query(
      `INSERT INTO claude_sessions
        (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch,
         started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
       VALUES ('s0', '/c', 'p', '/c/p/s0.jsonl', '/w/marko-ui', 'personal', 'marko-ui', 'earlier', 'main',
               '2026-09-04T10:00:00.000Z', '2026-09-04T11:00:00.000Z', 1, 0, '[]', 'host', '2026-09-04T11:00:00.000Z')`,
    )
    .run();
  database
    .query(
      `INSERT INTO activities (id, quest_id, objective, opened_at, closed_at, close_reason, revision)
       VALUES ('A0', 'Q1', 'fixing walk order', '2026-09-04T10:00:00.000Z', '2026-09-04T11:00:00.000Z', 'session_end', 1)`,
    )
    .run();
  database
    .query(
      `INSERT INTO traces (id, activity_id, tool, place, source, started_at, ended_at, who, what, why, where_text, how, confidence, classified_by, session_id, recorded_at)
       VALUES ('T00', 'A0', 'claude-code', 'personal/marko-ui', 'session', '2026-09-04T10:00:00.000Z', '2026-09-04T11:00:00.000Z', 'hero', 'fixing walk order', 'ship it', 'personal/marko-ui', 'claude-code', 0.9, 'assistant', 's0', '2026-09-04T11:00:00.000Z')`,
    )
    .run();
}

function seedOpenActivity(database: ReturnType<typeof openDatabase>) {
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
       VALUES ('T1', 'A1', 'claude-code', 'personal/marko-ui', 'session', '2026-09-04T14:00:00.000Z', '2026-09-04T14:30:00.000Z', 'hero', 'fixing walk order', 'ship', 'personal/marko-ui', 'claude-code', 0.9, 'assistant', 's1', '2026-09-04T14:30:00.000Z')`,
    )
    .run();
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
    seedOpenActivity(database);

    const windowSinceCut = buildWindow(database, {
      sessionId: "s1",
      sinceTs: "2026-09-04T14:30:00.000Z",
      ...memoryInput,
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

    const windowCapped = buildWindow(database, {
      sessionId: "s1",
      sinceTs: null,
      ...memoryInput,
      maxMessages: 2,
    });
    expect(windowCapped.messages.map((m) => m.text)).toEqual([
      "fix the walk order bug",
      "wait, what does Astryx do?",
    ]);
  });

  test("sessionOpenActivities carries this session's still-open activity with its last trace end", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database);
    seedOpenActivity(database);

    const window = buildWindow(database, {
      sessionId: "s1",
      sinceTs: "2026-09-04T14:30:00.000Z",
      ...memoryInput,
    });

    expect(window.sessionOpenActivities).toEqual([
      {
        activityId: "A1",
        what: "fixing walk order",
        why: "ship",
        questId: "Q1",
        questTitle: "Ship marko-ui",
        openedAt: "2026-09-04T14:00:00.000Z",
        lastTraceEndedAt: "2026-09-04T14:30:00.000Z",
      },
    ]);
  });

  test("recentActivities carries a closed activity from an earlier session in the same project", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database);
    seedOpenActivity(database);
    seedEarlierSession(database);

    const window = buildWindow(database, {
      sessionId: "s1",
      sinceTs: "2026-09-04T14:30:00.000Z",
      ...memoryInput,
    });

    expect(window.recentActivities).toEqual([
      {
        activityId: "A0",
        what: "fixing walk order",
        why: "ship it",
        questId: "Q1",
        questTitle: "Ship marko-ui",
        openedAt: "2026-09-04T10:00:00.000Z",
        lastTraceEndedAt: "2026-09-04T11:00:00.000Z",
        closedAt: "2026-09-04T11:00:00.000Z",
        closeReason: "session_end",
      },
    ]);
  });

  test("recentActivities drops activities older than memoryHours and obeys memoryActivities", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database);
    seedOpenActivity(database);
    seedEarlierSession(database);

    const stale = buildWindow(database, {
      sessionId: "s1",
      sinceTs: "2026-09-04T14:30:00.000Z",
      ...memoryInput,
      memoryHours: 1,
    });
    expect(stale.recentActivities).toEqual([]);

    const capped = buildWindow(database, {
      sessionId: "s1",
      sinceTs: "2026-09-04T14:30:00.000Z",
      ...memoryInput,
      memoryActivities: 0,
    });
    expect(capped.recentActivities).toEqual([]);
  });

  test("recentSideQuests carries branched quests with their trigger", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database);
    seedOpenActivity(database);
    database
      .query(
        `INSERT INTO quests (id, owner_kind, owner_id, title, objective, confirmed, revision, state, created_at, origin_activity_id, branched_at, trigger)
         VALUES ('Q2', 'hero', 'H1', 'Compare Astryx', 'see what they claim', 0, 1, 'started', '2026-09-04T12:00:00.000Z', 'A1', '2026-09-04T12:00:00.000Z', 'what does Astryx do for agents?')`,
      )
      .run();

    const window = buildWindow(database, {
      sessionId: "s1",
      sinceTs: "2026-09-04T14:30:00.000Z",
      ...memoryInput,
    });

    expect(window.recentSideQuests).toEqual([
      { id: "Q2", title: "Compare Astryx", trigger: "what does Astryx do for agents?" },
    ]);
  });

  test("overlapMessages carries the messages just before the cut, and messages excludes them", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database);
    seedOpenActivity(database);

    const window = buildWindow(database, {
      sessionId: "s1",
      sinceTs: "2026-09-04T14:30:00.000Z",
      ...memoryInput,
      overlapMessages: 1,
    });

    expect(window.overlapMessages.map((m) => m.text)).toEqual(["old message before cut"]);
    expect(window.messages.map((m) => m.text)).not.toContain("old message before cut");
  });

  test("previousSessionNote comes from w5_runs", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database);
    seedOpenActivity(database);

    const before = buildWindow(database, {
      sessionId: "s1",
      sinceTs: "2026-09-04T14:30:00.000Z",
      ...memoryInput,
    });
    expect(before.previousSessionNote).toBeNull();

    database
      .query(
        "INSERT INTO w5_runs (session_id, last_run_at, last_message_ts, session_note) VALUES ('s1', '2026-09-04T14:30:00.000Z', '2026-09-04T14:30:00.000Z', 'heading back to the walk order bug')",
      )
      .run();

    const after = buildWindow(database, {
      sessionId: "s1",
      sinceTs: "2026-09-04T14:30:00.000Z",
      ...memoryInput,
    });
    expect(after.previousSessionNote).toBe("heading back to the walk order bug");
  });
});
