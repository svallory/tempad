import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db/database";
import { declareQuest } from "../../src/intent/declarations";
import { ensureTables } from "../../src/intent/projections";
import { registerAllProjections } from "../../src/intent/projections/register";
import { EventStore } from "../../src/intent/store";
import { buildWindow, findSessionFile } from "../../src/w5/window";

registerAllProjections();

const memoryInput = { maxMessages: 50, memoryHours: 8, memoryStints: 10, overlapMessages: 3 };

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

/** An earlier session in the same project, whose stint was closed by session end. */
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
      `INSERT INTO stints (id, quest_id, outcome, opened_at, closed_at, close_reason, revision)
       VALUES ('A0', 'Q1', 'fixing walk order', '2026-09-04T10:00:00.000Z', '2026-09-04T11:00:00.000Z', 'session_end', 1)`,
    )
    .run();
  database
    .query(
      `INSERT INTO traces (id, stint_id, tool, place, source, started_at, ended_at, who, what, why, where_text, how, confidence, classified_by, session_id, recorded_at)
       VALUES ('T00', 'A0', 'claude-code', 'personal/marko-ui', 'session', '2026-09-04T10:00:00.000Z', '2026-09-04T11:00:00.000Z', 'hero', 'fixing walk order', 'ship it', 'personal/marko-ui', 'claude-code', 0.9, 'assistant', 's0', '2026-09-04T11:00:00.000Z')`,
    )
    .run();
}

function seedOpenStint(database: ReturnType<typeof openDatabase>) {
  database
    .query(
      "INSERT INTO quests (id, owner_kind, owner_id, title, outcome, confirmed, revision, state, created_at) VALUES ('Q1', 'hero', 'H1', 'Ship marko-ui', '86 components', 1, 1, 'started', '2026-09-01T00:00:00.000Z')",
    )
    .run();
  database
    .query(
      "INSERT INTO stints (id, quest_id, outcome, opened_at, revision) VALUES ('A1', 'Q1', 'fixing walk order', '2026-09-04T14:00:00.000Z', 1)",
    )
    .run();
  database
    .query(
      `INSERT INTO traces (id, stint_id, tool, place, source, started_at, ended_at, who, what, why, where_text, how, confidence, classified_by, session_id, recorded_at)
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
    seedOpenStint(database);

    const windowSinceCut = buildWindow(database, {
      sessionId: "s1",
      sinceTs: "2026-09-04T14:30:00.000Z",
      ...memoryInput,
    });
    expect(windowSinceCut.messages.map((m) => m.text)).toEqual([
      "fix the walk order bug",
      "wait, what does Astryx do?",
    ]);
    // Declared mode has no quest lists at all; they come back only for the
    // inference fallback.
    expect(windowSinceCut.openQuests).toBeUndefined();
    expect(windowSinceCut.recentSideQuests).toBeUndefined();

    const inferredWindow = buildWindow(database, {
      sessionId: "s1",
      sinceTs: "2026-09-04T14:30:00.000Z",
      mode: "inferred",
      ...memoryInput,
    });
    expect(inferredWindow.openQuests).toEqual([
      {
        id: "Q1",
        title: "Ship marko-ui",
        outcome: "86 components",
        lastStintAt: "2026-09-04T14:00:00.000Z",
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

  test("sessionOpenActivities carries this session's still-open stint with its last trace end", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database);
    seedOpenStint(database);

    const window = buildWindow(database, {
      sessionId: "s1",
      sinceTs: "2026-09-04T14:30:00.000Z",
      ...memoryInput,
    });

    // The row carries the alias; the real id lives only in stintAliases.
    expect(window.stintAliases).toEqual({ A1: "A1" });
    expect(window.sessionOpenStints).toEqual([
      {
        stintId: "A1",
        what: "fixing walk order",
        why: "ship",
        questId: "Q1",
        questTitle: "Ship marko-ui",
        openedAt: "2026-09-04T14:00:00.000Z",
        lastTraceEndedAt: "2026-09-04T14:30:00.000Z",
      },
    ]);
  });

  test("buildWindow never offers a dismissed stint as a candidate", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database);
    seedOpenStint(database);
    database
      .query(
        "INSERT INTO stints (id, quest_id, outcome, opened_at, revision, dismissed_at) VALUES ('A-dismissed', 'Q1', 'a quick check', '2026-09-04T14:05:00.000Z', 1, '2026-09-04T14:08:00.000Z')",
      )
      .run();
    database
      .query(
        `INSERT INTO traces (id, stint_id, tool, place, source, started_at, ended_at, who, what, why, where_text, how, confidence, classified_by, session_id, recorded_at)
         VALUES ('T2', 'A-dismissed', 'claude-code', 'personal/marko-ui', 'session', '2026-09-04T14:05:00.000Z', '2026-09-04T14:08:00.000Z', 'hero', 'a quick check', 'ship', 'personal/marko-ui', 'claude-code', 0.9, 'assistant', 's1', '2026-09-04T14:08:00.000Z')`,
      )
      .run();

    const window = buildWindow(database, {
      sessionId: "s1",
      sinceTs: "2026-09-04T14:30:00.000Z",
      ...memoryInput,
    });

    expect(window.sessionOpenStints.map((s) => s.stintId)).toEqual(["A1"]);
    expect(Object.values(window.stintAliases)).not.toContain("A-dismissed");
  });

  test("recentActivities carries a closed stint from an earlier session in the same project", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database);
    seedOpenStint(database);
    seedEarlierSession(database);

    const window = buildWindow(database, {
      sessionId: "s1",
      sinceTs: "2026-09-04T14:30:00.000Z",
      ...memoryInput,
    });

    expect(window.stintAliases.A2).toBe("A0");
    expect(window.recentStints).toEqual([
      {
        stintId: "A2",
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

  test("recentActivities drops stints older than memoryHours and obeys memoryActivities", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database);
    seedOpenStint(database);
    seedEarlierSession(database);

    const stale = buildWindow(database, {
      sessionId: "s1",
      sinceTs: "2026-09-04T14:30:00.000Z",
      ...memoryInput,
      memoryHours: 1,
    });
    expect(stale.recentStints).toEqual([]);

    const capped = buildWindow(database, {
      sessionId: "s1",
      sinceTs: "2026-09-04T14:30:00.000Z",
      ...memoryInput,
      memoryStints: 0,
    });
    expect(capped.recentStints).toEqual([]);
  });

  test("recentSideQuests carries branched quests with their trigger (inference fallback only)", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database);
    seedOpenStint(database);
    database
      .query(
        `INSERT INTO quests (id, owner_kind, owner_id, title, outcome, confirmed, revision, state, created_at, deviates_from_stint_id, branched_at, trigger)
         VALUES ('Q2', 'hero', 'H1', 'Compare Astryx', 'see what they claim', 0, 1, 'started', '2026-09-04T12:00:00.000Z', 'A1', '2026-09-04T12:00:00.000Z', 'what does Astryx do for agents?')`,
      )
      .run();

    const window = buildWindow(database, {
      sessionId: "s1",
      sinceTs: "2026-09-04T14:30:00.000Z",
      mode: "inferred",
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
    seedOpenStint(database);

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
    seedOpenStint(database);

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

describe("candidate time bounds", () => {
  /**
   * A stint from a *later* session in the same project. Backfill walks
   * history, so when the window under classification is an earlier one this
   * stint has not happened yet from that window's point of view.
   */
  function seedFutureStint(database: ReturnType<typeof openDatabase>) {
    database
      .query(
        `INSERT INTO claude_sessions
          (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch,
           started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
         VALUES ('s2', '/c', 'p', '/c/p/s2.jsonl', '/w/marko-ui', 'personal', 'marko-ui', 'later', 'main',
                 '2026-09-06T10:00:00.000Z', '2026-09-06T11:00:00.000Z', 1, 0, '[]', 'host', '2026-09-06T11:00:00.000Z')`,
      )
      .run();
    database
      .query(
        `INSERT INTO stints (id, quest_id, outcome, opened_at, closed_at, close_reason, revision)
         VALUES ('A9', 'Q1', 'work from two days later', '2026-09-06T10:00:00.000Z', '2026-09-06T11:00:00.000Z', 'session_end', 1)`,
      )
      .run();
    database
      .query(
        `INSERT INTO traces (id, stint_id, tool, place, source, started_at, ended_at, who, what, why, where_text, how, confidence, classified_by, session_id, recorded_at)
         VALUES ('T9', 'A9', 'claude-code', 'personal/marko-ui', 'session', '2026-09-06T10:00:00.000Z', '2026-09-06T11:00:00.000Z', 'hero', 'later work', 'ship', 'personal/marko-ui', 'claude-code', 0.9, 'assistant', 's2', '2026-09-06T11:00:00.000Z')`,
      )
      .run();
  }

  test("a stint opened after the window is not offered as a candidate", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database);
    seedOpenStint(database);
    seedEarlierSession(database);
    seedFutureStint(database);

    const window = buildWindow(database, {
      sessionId: "s1",
      sinceTs: "2026-09-04T14:30:00.000Z",
      ...memoryInput,
      memoryHours: 240,
      windowEnd: "2026-09-04T15:20:00.000Z",
    });

    // Rows carry aliases now, so the real ids are read back through the map.
    const offered = window.recentStints.map((stint) => window.stintAliases[stint.stintId]);
    expect(offered).not.toContain("A9");
    // The genuinely earlier stint is still offered, so the bound is not just
    // emptying the slice.
    expect(offered).toContain("A0");
  });

  test("without a windowEnd bound the future stint would be offered", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database);
    seedOpenStint(database);
    seedFutureStint(database);

    // `windowEnd` defaults to now, which is after the seeded 2026 timestamps only
    // if the clock says so; pass an explicit bound past the future stint to
    // show the filter is what excludes it above, not some other clause.
    const window = buildWindow(database, {
      sessionId: "s1",
      sinceTs: "2026-09-04T14:30:00.000Z",
      ...memoryInput,
      memoryHours: 240,
      windowEnd: "2026-09-07T00:00:00.000Z",
    });

    expect(window.recentStints.map((stint) => window.stintAliases[stint.stintId])).toContain("A9");
  });

  test("an open stint of this session opened after the window is not offered", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database);
    seedOpenStint(database);

    const window = buildWindow(database, {
      sessionId: "s1",
      sinceTs: null,
      ...memoryInput,
      // A1 opened at 14:00; this window ended before that.
      windowEnd: "2026-09-04T13:55:00.000Z",
    });

    expect(window.sessionOpenStints).toEqual([]);
  });

  test("a closed stint older than memory_hours is still excluded", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database);
    seedOpenStint(database);
    seedEarlierSession(database);

    const window = buildWindow(database, {
      sessionId: "s1",
      sinceTs: "2026-09-04T14:30:00.000Z",
      ...memoryInput,
      // A0 closed at 11:00, more than an hour before the 14:30 reference.
      memoryHours: 1,
      windowEnd: "2026-09-04T15:20:00.000Z",
    });

    expect(window.recentStints.map((stint) => window.stintAliases[stint.stintId])).not.toContain(
      "A0",
    );
  });
});

describe("declared quests in the window", () => {
  function seedHeroAndQuest(database: ReturnType<typeof openDatabase>) {
    const store = new EventStore(database);
    database
      .query(
        "INSERT INTO heroes (id, name, created_at) VALUES ('H1', 'Saulo', '2026-09-01T00:00:00.000Z')",
      )
      .run();
    database
      .query(
        `INSERT INTO quests (id, owner_kind, owner_id, title, outcome, confirmed, revision, state, created_at)
         VALUES ('Q1', 'hero', 'H1', 'Ship marko-ui', '86 components', 1, 1, 'started', '2026-09-01T00:00:00.000Z')`,
      )
      .run();
    return store;
  }

  test("declaredQuest is populated from a quest.declared event at the window's reference time", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database);
    const store = seedHeroAndQuest(database);

    declareQuest(store, database, {
      sessionId: "s1",
      questId: "Q1",
      plan: ["walk order", "docs"],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-04T14:05:00.000Z",
      heroId: "H1",
    });

    const window = buildWindow(database, {
      sessionId: "s1",
      sinceTs: "2026-09-04T14:30:00.000Z",
      ...memoryInput,
      windowEnd: "2026-09-04T15:20:00.000Z",
    });

    expect(window.declaredQuest).toEqual({
      title: "Ship marko-ui",
      outcome: "86 components",
      plan: ["walk order", "docs"],
    });
    expect(window.parentDeclaredQuest).toBeNull();
  });

  test("a declaration made after the window's end is not visible to it", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database);
    const store = seedHeroAndQuest(database);

    declareQuest(store, database, {
      sessionId: "s1",
      questId: "Q1",
      plan: [],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-05T09:00:00.000Z",
      heroId: "H1",
    });

    const window = buildWindow(database, {
      sessionId: "s1",
      sinceTs: "2026-09-04T14:30:00.000Z",
      ...memoryInput,
      windowEnd: "2026-09-04T15:20:00.000Z",
    });

    expect(window.declaredQuest).toBeNull();
  });

  test("a subagent's window carries its own quest and the parent's", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database);
    const store = seedHeroAndQuest(database);
    database
      .query(
        `INSERT INTO quests (id, owner_kind, owner_id, title, outcome, confirmed, revision, state, created_at)
         VALUES ('Q2', 'hero', 'H1', 'Verify the walk order fix', 'prove it holds', 1, 1, 'started', '2026-09-01T00:00:00.000Z')`,
      )
      .run();
    database
      .query(
        `INSERT INTO claude_sessions
          (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch,
           started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
         VALUES ('parent', '/c', 'p', '/c/p/parent.jsonl', '/w/marko-ui', 'personal', 'marko-ui', 'parent', 'main',
                 '2026-09-04T13:00:00.000Z', '2026-09-04T16:00:00.000Z', 1, 0, '[]', 'host', '2026-09-04T16:00:00.000Z')`,
      )
      .run();

    declareQuest(store, database, {
      sessionId: "parent",
      questId: "Q1",
      plan: [],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-04T13:05:00.000Z",
      heroId: "H1",
    });
    declareQuest(store, database, {
      sessionId: "s1",
      parentSessionId: "parent",
      questId: "Q2",
      plan: [],
      scope: "subagent",
      declaredBy: "agent",
      at: "2026-09-04T14:05:00.000Z",
      heroId: "H1",
    });

    const window = buildWindow(database, {
      sessionId: "s1",
      sinceTs: "2026-09-04T14:30:00.000Z",
      ...memoryInput,
      windowEnd: "2026-09-04T15:20:00.000Z",
    });

    expect(window.declaredQuest?.title).toBe("Verify the walk order fix");
    expect(window.parentDeclaredQuest?.title).toBe("Ship marko-ui");
  });

  test("aliases number both slices in list order and never leak a real id", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database);
    seedOpenStint(database);
    seedEarlierSession(database);

    const window = buildWindow(database, {
      sessionId: "s1",
      sinceTs: "2026-09-04T14:30:00.000Z",
      ...memoryInput,
    });

    // Session stints first, then recent: A1 is the open one, A2 the closed one.
    expect(window.sessionOpenStints.map((stint) => stint.stintId)).toEqual(["A1"]);
    expect(window.recentStints.map((stint) => stint.stintId)).toEqual(["A2"]);
    expect(window.stintAliases).toEqual({ A1: "A1", A2: "A0" });
    expect(Object.keys(window.stintAliases).every((alias) => /^A\d+$/.test(alias))).toBe(true);
  });
});
