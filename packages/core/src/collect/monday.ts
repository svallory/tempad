import type { Database } from "bun:sqlite";
import type { Config } from "../config/env.ts";
import { getSyncState } from "../db/sync-state.ts";
import type { Collector, SyncOptions, SyncSummary } from "./types.ts";

const MONDAY_ENDPOINT = "https://api.monday.com/v2";
const API_VERSION = "2026-07";
const RETRY_LIMIT = 3;
const DEFAULT_RETRY_SECONDS = 10;
const BOARDS_PAGE_LIMIT = 100;
const ITEMS_PAGE_LIMIT = 500;

interface GraphQlError {
  message: string;
  extensions?: { retry_in_seconds?: number };
}

interface GraphQlResponse<T> {
  data?: T;
  errors?: GraphQlError[];
}

interface BoardColumn {
  id: string;
  title: string;
  type: string;
}

interface Board {
  id: string;
  name: string;
  columns: BoardColumn[];
}

interface ColumnValue {
  id: string;
  type: string;
  text: string | null;
  value: string | null;
}

interface MondayItem {
  id: string;
  name: string;
  group: { title: string } | null;
  created_at: string;
  updated_at: string;
  column_values: ColumnValue[];
}

interface ItemsPage {
  cursor: string | null;
  items: MondayItem[];
}

interface Assignee {
  id: string;
  name: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isComplexityError(error: GraphQlError): boolean {
  return error.message.includes("Complexity");
}

async function mondayRequest<T>(
  fetchFn: typeof fetch,
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  for (let attempt = 0; attempt <= RETRY_LIMIT; attempt++) {
    const response = await fetchFn(MONDAY_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: token,
        "API-Version": API_VERSION,
      },
      body: JSON.stringify({ query, variables }),
    });

    const rateLimited = response.status === 429;
    const body = (await response.json()) as GraphQlResponse<T>;
    const complexityError = body.errors?.find(isComplexityError);

    if ((rateLimited || complexityError) && attempt < RETRY_LIMIT) {
      const retryInSeconds = complexityError?.extensions?.retry_in_seconds ?? DEFAULT_RETRY_SECONDS;
      await sleep(retryInSeconds * 1000);
      continue;
    }

    if (body.errors && body.errors.length > 0) {
      throw new Error(body.errors.map((error) => error.message).join("; "));
    }

    if (body.data === undefined) {
      throw new Error("Monday API returned no data");
    }

    return body.data;
  }

  throw new Error("Monday API request failed after retries");
}

async function fetchAllBoards(fetchFn: typeof fetch, token: string): Promise<Board[]> {
  const boards: Board[] = [];
  for (let page = 1; ; page++) {
    const data = await mondayRequest<{ boards: Board[] }>(
      fetchFn,
      token,
      `query ($page: Int!, $limit: Int!) {
        boards(limit: $limit, page: $page, state: active) {
          id
          name
          columns { id title type }
        }
      }`,
      { page, limit: BOARDS_PAGE_LIMIT },
    );

    if (data.boards.length === 0) break;
    boards.push(...data.boards);
  }
  return boards;
}

async function fetchItemsPage(
  fetchFn: typeof fetch,
  token: string,
  boardId: string,
  cursor: string | null,
  queryParams: Record<string, unknown> | undefined,
): Promise<ItemsPage> {
  if (cursor !== null) {
    const data = await mondayRequest<{
      next_items_page: ItemsPage;
    }>(
      fetchFn,
      token,
      `query ($cursor: String!, $limit: Int!) {
        next_items_page(cursor: $cursor, limit: $limit) {
          cursor
          items {
            id
            name
            group { title }
            created_at
            updated_at
            column_values { id type text value }
          }
        }
      }`,
      { cursor, limit: ITEMS_PAGE_LIMIT },
    );
    return data.next_items_page;
  }

  const data = await mondayRequest<{
    boards: { items_page: ItemsPage }[];
  }>(
    fetchFn,
    token,
    `query ($boardId: [ID!], $limit: Int!, $params: ItemsQuery) {
      boards(ids: $boardId) {
        items_page(limit: $limit, query_params: $params) {
          cursor
          items {
            id
            name
            group { title }
            created_at
            updated_at
            column_values { id type text value }
          }
        }
      }
    }`,
    { boardId: [boardId], limit: ITEMS_PAGE_LIMIT, params: queryParams },
  );
  return data.boards[0]?.items_page ?? { cursor: null, items: [] };
}

async function fetchBoardItems(
  fetchFn: typeof fetch,
  token: string,
  board: Board,
  lastSyncAt: string | undefined,
  warnings: string[],
): Promise<MondayItem[]> {
  const queryParams =
    lastSyncAt !== undefined
      ? {
          rules: [
            {
              column_id: "__last_updated__",
              compare_value: [lastSyncAt],
              operator: "greater_than",
            },
          ],
        }
      : undefined;

  const items: MondayItem[] = [];
  let cursor: string | null = null;
  let useFilter = queryParams !== undefined;

  try {
    do {
      const page: ItemsPage = await fetchItemsPage(
        fetchFn,
        token,
        board.id,
        cursor,
        cursor === null && useFilter ? queryParams : undefined,
      );
      items.push(...page.items);
      cursor = page.cursor;
    } while (cursor !== null);
  } catch (error) {
    if (!useFilter) throw error;
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(
      `board ${board.id} (${board.name}): last-updated rule rejected (${message}), falling back to unfiltered pull`,
    );
    useFilter = false;
    items.length = 0;
    cursor = null;
    do {
      const page: ItemsPage = await fetchItemsPage(fetchFn, token, board.id, cursor, undefined);
      items.push(...page.items);
      cursor = page.cursor;
    } while (cursor !== null);
  }

  return items;
}

async function fetchMyName(fetchFn: typeof fetch, token: string): Promise<string> {
  const data = await mondayRequest<{ me: { name: string } }>(
    fetchFn,
    token,
    `query { me { name } }`,
    {},
  );
  return data.me.name;
}

function findColumnByType(item: MondayItem, type: string): ColumnValue | undefined {
  return item.column_values.find((column) => column.type === type);
}

function parseJsonValue(value: string | null): Record<string, unknown> | undefined {
  if (value === null) return undefined;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function extractAssignees(item: MondayItem): Assignee[] {
  const peopleColumn = findColumnByType(item, "people") ?? findColumnByType(item, "person");
  if (!peopleColumn) return [];
  const parsed = parseJsonValue(peopleColumn.value);
  const personsAndTeams = parsed?.personsAndTeams;
  if (!Array.isArray(personsAndTeams)) return [];

  const persons = personsAndTeams.filter(
    (entry): entry is { id: number; kind: string } => entry?.kind === "person",
  );
  const names = (peopleColumn.text ?? "").split(",").map((name) => name.trim());

  return persons.map((entry, index) => ({
    id: String(entry.id),
    name: names[index] ?? "",
  }));
}

function isAssignedToUser(item: MondayItem, mondayUser: string, userName: string): boolean {
  const peopleColumn = findColumnByType(item, "people") ?? findColumnByType(item, "person");
  if (!peopleColumn) return false;

  const parsed = parseJsonValue(peopleColumn.value);
  const personsAndTeams = parsed?.personsAndTeams;
  if (Array.isArray(personsAndTeams)) {
    const matchesId = personsAndTeams.some((entry) => String(entry?.id) === mondayUser);
    if (matchesId) return true;
  }

  return (peopleColumn.text ?? "").includes(userName);
}

function extractStatus(item: MondayItem): string | undefined {
  const statusColumn = findColumnByType(item, "status");
  return statusColumn?.text ?? undefined;
}

function extractTimeline(item: MondayItem): { start: string | undefined; end: string | undefined } {
  const timelineColumn = findColumnByType(item, "timeline");
  const parsed = parseJsonValue(timelineColumn?.value ?? null);
  return {
    start: typeof parsed?.from === "string" ? parsed.from : undefined,
    end: typeof parsed?.to === "string" ? parsed.to : undefined,
  };
}

function extractTimeTrackedSeconds(item: MondayItem): number | undefined {
  const timeTrackingColumn = findColumnByType(item, "time_tracking");
  const parsed = parseJsonValue(timeTrackingColumn?.value ?? null);
  return typeof parsed?.duration === "number" ? parsed.duration : undefined;
}

function upsertItem(database: Database, board: Board, item: MondayItem): "inserted" | "updated" {
  const existing = database
    .query("SELECT id FROM monday_items WHERE id = ?")
    .get(Number(item.id)) as { id: number } | null;

  const status = extractStatus(item) ?? null;
  const timeline = extractTimeline(item);
  const timeTrackedSeconds = extractTimeTrackedSeconds(item) ?? null;
  const assignees = extractAssignees(item);

  database
    .query(
      `INSERT INTO monday_items
        (id, board_id, board_name, group_name, name, status, assignees, timeline_start, timeline_end, time_tracked_seconds, created_at, updated_at, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         board_id = excluded.board_id,
         board_name = excluded.board_name,
         group_name = excluded.group_name,
         name = excluded.name,
         status = excluded.status,
         assignees = excluded.assignees,
         timeline_start = excluded.timeline_start,
         timeline_end = excluded.timeline_end,
         time_tracked_seconds = excluded.time_tracked_seconds,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at,
         raw = excluded.raw`,
    )
    .run(
      Number(item.id),
      Number(board.id),
      board.name,
      item.group?.title ?? null,
      item.name,
      status,
      JSON.stringify(assignees),
      timeline.start ?? null,
      timeline.end ?? null,
      timeTrackedSeconds,
      item.created_at,
      item.updated_at,
      JSON.stringify(item.column_values),
    );

  return existing ? "updated" : "inserted";
}

export const mondayCollector: Collector = {
  name: "monday",
  async sync(database: Database, config: Config, options: SyncOptions): Promise<SyncSummary> {
    const fetchFn = options.fetch ?? fetch;
    const warnings: string[] = [];
    let inserted = 0;
    let updated = 0;

    const syncState = getSyncState(database, "monday");
    const userName = await fetchMyName(fetchFn, config.mondayApiToken);
    const boards = await fetchAllBoards(fetchFn, config.mondayApiToken);

    for (const board of boards) {
      const items = await fetchBoardItems(
        fetchFn,
        config.mondayApiToken,
        board,
        syncState?.lastSyncAt,
        warnings,
      );

      const assignedItems = items.filter((item) =>
        isAssignedToUser(item, config.mondayUser, userName),
      );

      for (const item of assignedItems) {
        const result = upsertItem(database, board, item);
        if (result === "inserted") inserted++;
        else updated++;
      }
    }

    return {
      source: "monday",
      inserted,
      updated,
      deleted: 0,
      warnings,
    };
  },
};
