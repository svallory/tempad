import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/database.ts";
import { queryMondayItems } from "../src/report/queries.ts";
import { TIME_ZONE } from "./fixtures/report-golden/seed.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tempad-report-queries-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function insertItem(
  database: ReturnType<typeof openDatabase>,
  overrides: {
    id: number;
    boardName?: string;
    timelineStart?: string | null;
    timelineEnd?: string | null;
    updatedAt: string;
  },
): void {
  database.exec(
    `INSERT INTO monday_items (id, board_id, board_name, group_name, name, status, assignees, timeline_start, timeline_end, time_tracked_seconds, created_at, updated_at, raw)
     VALUES (?, 1, ?, NULL, 'item', NULL, '[]', ?, ?, NULL, ?, ?, '{}')`,
    [
      overrides.id,
      overrides.boardName ?? "Board",
      overrides.timelineStart ?? null,
      overrides.timelineEnd ?? null,
      overrides.updatedAt,
      overrides.updatedAt,
    ],
  );
}

describe("queryMondayItems", () => {
  test("a timeline that ends exactly on the range start is included (range end is exclusive)", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    insertItem(database, {
      id: 1,
      timelineStart: "2026-08-30",
      timelineEnd: "2026-09-01",
      updatedAt: "2026-08-30T00:00:00.000Z",
    });

    const rows = queryMondayItems(database, {
      from: "2026-09-01",
      to: "2026-09-01",
      timeZone: TIME_ZONE,
    });

    expect(rows).toHaveLength(1);
    database.close();
  });

  test("a timeline that starts exactly on the day after the range end is excluded", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    insertItem(database, {
      id: 2,
      timelineStart: "2026-09-02",
      timelineEnd: "2026-09-05",
      updatedAt: "2026-08-30T00:00:00.000Z",
    });

    const rows = queryMondayItems(database, {
      from: "2026-09-01",
      to: "2026-09-01",
      timeZone: TIME_ZONE,
    });

    expect(rows).toHaveLength(0);
    database.close();
  });

  test("updated_at at the local-day boundary is bucketed by local day, not UTC", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    // 2026-09-01T02:30:00Z is 2026-08-31 local (America/Sao_Paulo, UTC-3)
    insertItem(database, { id: 3, updatedAt: "2026-09-01T02:30:00.000Z" });

    const inRange = queryMondayItems(database, {
      from: "2026-08-31",
      to: "2026-08-31",
      timeZone: TIME_ZONE,
    });
    expect(inRange).toHaveLength(1);

    const outOfRange = queryMondayItems(database, {
      from: "2026-09-01",
      to: "2026-09-01",
      timeZone: TIME_ZONE,
    });
    expect(outOfRange).toHaveLength(0);

    database.close();
  });

  test("the project filter matches the slugified board name, not raw SQL text", () => {
    const database = openDatabase(join(dir, "tempad.db"));
    insertItem(database, {
      id: 4,
      boardName: "Beta Project",
      updatedAt: "2026-09-01T12:00:00.000Z",
    });
    insertItem(database, {
      id: 5,
      boardName: "Other Board",
      updatedAt: "2026-09-01T12:00:00.000Z",
    });

    const rows = queryMondayItems(database, {
      from: "2026-09-01",
      to: "2026-09-01",
      timeZone: TIME_ZONE,
      project: "beta-project",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(4);
    database.close();
  });
});
