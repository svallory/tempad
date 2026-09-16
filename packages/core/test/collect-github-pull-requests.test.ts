import { describe, expect, test } from "bun:test";
import { fetchFirstAuthoredAt } from "../src/collect/github/pull-requests.ts";
import type { CommandRunner } from "../src/collect/github/request.ts";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

const noopRunner: CommandRunner = {
  async run() {
    return { code: 0, stdout: "", stderr: "" };
  },
};

function commit(date: string): { commit: { author: { date: string } | null } } {
  return { commit: { author: { date } } };
}

describe("fetchFirstAuthoredAt", () => {
  test("returns the earliest commit author date across two pages", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = (async (_input: string | URL | Request) => {
      calls++;
      if (calls === 1) {
        const page = Array.from({ length: 100 }, (_, index) =>
          commit(`2026-08-2${index % 9}T10:00:00Z`),
        );
        page[50] = commit("2026-08-01T00:00:00Z");
        return jsonResponse(page);
      }
      return jsonResponse([commit("2026-08-19T09:00:00Z"), commit("2026-08-20T10:00:00Z")]);
    }) as typeof fetch;

    const result = await fetchFirstAuthoredAt("acme/widgets", 42, {
      token: "t",
      fetch: fetchImpl,
      runner: noopRunner,
    });

    expect(result).toBe("2026-08-01T00:00:00Z");
    expect(calls).toBe(2);
  });

  test("stops after 250 commits even if the API would return more", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = (async (_input: string | URL | Request) => {
      calls++;
      const page = Array.from({ length: 100 }, () => commit("2026-08-20T10:00:00Z"));
      return jsonResponse(page);
    }) as typeof fetch;

    const result = await fetchFirstAuthoredAt("acme/widgets", 42, {
      token: "t",
      fetch: fetchImpl,
      runner: noopRunner,
    });

    expect(result).toBe("2026-08-20T10:00:00Z");
    // 100 + 100 + 100 = 300 >= 250 cap, so the loop stops after the third page.
    expect(calls).toBe(3);
  });

  test("a PR with zero commits returns null", async () => {
    const fetchImpl: typeof fetch = (async (_input: string | URL | Request) =>
      jsonResponse([])) as typeof fetch;

    const result = await fetchFirstAuthoredAt("acme/widgets", 42, {
      token: "t",
      fetch: fetchImpl,
      runner: noopRunner,
    });

    expect(result).toBeNull();
  });

  test("a commit with no author date is skipped", async () => {
    const fetchImpl: typeof fetch = (async (_input: string | URL | Request) =>
      jsonResponse([{ commit: { author: null } }, commit("2026-08-19T09:00:00Z")])) as typeof fetch;

    const result = await fetchFirstAuthoredAt("acme/widgets", 42, {
      token: "t",
      fetch: fetchImpl,
      runner: noopRunner,
    });

    expect(result).toBe("2026-08-19T09:00:00Z");
  });
});
