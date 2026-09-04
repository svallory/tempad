import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandRunner } from "../src/collect/github/request.ts";
import { createGithubCollector } from "../src/collect/github.ts";
import type { Config } from "../src/config/env.ts";
import { openDatabase } from "../src/db/database.ts";
import { addCommit, buildRepository } from "./fixtures/git/build-repository.ts";

const FIXTURES_DIR = join(import.meta.dir, "fixtures/github");

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf8"));
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function baseConfig(home: string): Config {
  return {
    mondayApiToken: "token",
    mondayUser: "1",
    ghUser: "svallory",
    ghOrgs: ["Mosaicstg"],
    ghIncludePersonal: false,
    ghToken: "gh-token",
    gitAuthorEmails: ["me@saulo.engineer"],
    claudeDirs: [],
    hostSlug: "test-host",
    tz: "America/Sao_Paulo",
    since: "2026-08-01",
    home,
  };
}

function makeRunner(mirrorRoot: { source: string | undefined }): CommandRunner {
  return {
    async run(argv, cwd) {
      const [bin, ...args] = argv;
      if (bin !== "git") {
        return { code: 1, stdout: "", stderr: `unexpected command: ${argv.join(" ")}` };
      }
      if (args[0] === "clone" && args[1] === "--mirror") {
        const source = mirrorRoot.source;
        if (!source) return { code: 1, stdout: "", stderr: "no source configured" };
        const dest = args[3] as string;
        const proc = Bun.spawn(["git", "clone", "--mirror", source, dest], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const code = await proc.exited;
        return {
          code,
          stdout: "",
          stderr: code === 0 ? "" : await new Response(proc.stderr).text(),
        };
      }

      const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const code = await proc.exited;
      return { code, stdout, stderr };
    },
  };
}

function makeFetch(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.includes("/search/commits")) {
      return jsonResponse(loadFixture("search-commits.json"));
    }
    if (url.includes("reviewed-by")) {
      return jsonResponse(loadFixture("search-issues-reviewed.json"));
    }
    if (url.includes("/search/issues")) {
      return jsonResponse(loadFixture("search-issues-authored.json"));
    }
    if (url.includes("/pulls")) {
      return jsonResponse(loadFixture("pulls.json"));
    }
    return jsonResponse({ items: [], total_count: 0 });
  }) as typeof fetch;
}

describe("github collector", () => {
  test("a second sync immediately after the first is fully idempotent across timezone offsets", async () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), "tempad-home-"));
    const sourceDirectory = await buildRepository([
      {
        message: "commit with non-UTC offset",
        authorName: "Saulo Vallory",
        authorEmail: "me@saulo.engineer",
        date: "2026-09-02T22:00:00-03:00",
        files: { "readme.md": "hello" },
      },
      {
        message: "another commit with non-UTC offset",
        authorName: "Saulo Vallory",
        authorEmail: "me@saulo.engineer",
        date: "2026-09-03T23:30:00-03:00",
        files: { "other.md": "hi" },
      },
    ]);

    try {
      const dbPath = join(homeDirectory, "tempad.db");
      const database = openDatabase(dbPath);
      const config = baseConfig(homeDirectory);
      const mirrorRoot = { source: sourceDirectory };
      const collector = createGithubCollector({
        fetch: makeFetch(),
        runner: makeRunner(mirrorRoot),
      });

      const firstSummary = await collector.sync(database, config, {});
      expect(firstSummary.deleted).toBe(0);

      const commitRows = database
        .query("SELECT sha, authored_at FROM gh_commits WHERE repo = ?")
        .all("Mosaicstg/LiUNA-Campaigns") as { sha: string; authored_at: string }[];
      expect(commitRows.length).toBe(2);
      for (const row of commitRows) {
        expect(row.authored_at.endsWith("Z")).toBe(true);
      }

      const secondSummary = await collector.sync(database, config, {});
      expect(secondSummary.inserted).toBe(0);
      expect(secondSummary.deleted).toBe(0);

      database.close();
    } finally {
      rmSync(homeDirectory, { recursive: true, force: true });
      rmSync(sourceDirectory, { recursive: true, force: true });
    }
  });

  test("discovers, mirrors, logs commits, records PRs, and is idempotent", async () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), "tempad-home-"));
    const sourceDirectory = await buildRepository([
      {
        message: "initial commit",
        authorName: "Saulo Vallory",
        authorEmail: "me@saulo.engineer",
        date: "2026-09-02T10:00:00-03:00",
        files: { "readme.md": "hello" },
      },
      {
        message: "second commit",
        authorName: "Someone Else",
        authorEmail: "someone@example.com",
        date: "2026-09-03T10:00:00-03:00",
        files: { "other.md": "hi" },
      },
    ]);

    try {
      const dbPath = join(homeDirectory, "tempad.db");
      const database = openDatabase(dbPath);
      const config = baseConfig(homeDirectory);
      const mirrorRoot = { source: sourceDirectory };
      const collector = createGithubCollector({
        fetch: makeFetch(),
        runner: makeRunner(mirrorRoot),
      });

      const firstSummary = await collector.sync(database, config, {});

      expect(firstSummary.source).toBe("github");
      expect(firstSummary.inserted).toBeGreaterThan(0);
      expect(firstSummary.warnings).toEqual([]);

      const commitRows = database
        .query("SELECT sha, author_email FROM gh_commits WHERE repo = ?")
        .all("Mosaicstg/LiUNA-Campaigns") as { sha: string; author_email: string }[];
      expect(commitRows.length).toBe(1);
      expect(commitRows[0]?.author_email).toBe("me@saulo.engineer");

      const pullRequestRows = database
        .query("SELECT number, role, state FROM gh_pull_requests WHERE repo = ?")
        .all("Mosaicstg/LiUNA-Campaigns") as { number: number; role: string; state: string }[];
      expect(pullRequestRows).toEqual([{ number: 42, role: "author", state: "merged" }]);

      const secondSummary = await collector.sync(database, config, {});
      expect(secondSummary.inserted).toBe(0);
      expect(secondSummary.deleted).toBe(0);

      database.close();
    } finally {
      rmSync(homeDirectory, { recursive: true, force: true });
      rmSync(sourceDirectory, { recursive: true, force: true });
    }
  });

  test("reconcile deletes rows for shas no longer reachable after history rewrite", async () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), "tempad-home-"));
    const sourceDirectory = await buildRepository([
      {
        message: "keep me",
        authorName: "Saulo Vallory",
        authorEmail: "me@saulo.engineer",
        date: "2026-09-02T10:00:00-03:00",
        files: { "a.md": "a" },
      },
      {
        message: "will be rewritten",
        authorName: "Saulo Vallory",
        authorEmail: "me@saulo.engineer",
        date: "2026-09-03T10:00:00-03:00",
        files: { "b.md": "b" },
      },
    ]);

    try {
      const dbPath = join(homeDirectory, "tempad.db");
      const database = openDatabase(dbPath);
      const config = baseConfig(homeDirectory);
      const mirrorRoot = { source: sourceDirectory };
      const runner = makeRunner(mirrorRoot);
      const collector = createGithubCollector({ fetch: makeFetch(), runner });

      await collector.sync(database, config, {});

      const before = database
        .query("SELECT sha FROM gh_commits WHERE repo = ?")
        .all("Mosaicstg/LiUNA-Campaigns") as { sha: string }[];
      expect(before.length).toBe(2);

      await runner.run(["git", "reset", "--hard", "HEAD~1"], sourceDirectory);
      await addCommit(sourceDirectory, {
        message: "replacement commit",
        authorName: "Saulo Vallory",
        authorEmail: "me@saulo.engineer",
        date: "2026-09-04T10:00:00-03:00",
        files: { "c.md": "c" },
      });

      const summary = await collector.sync(database, config, {});
      expect(summary.deleted).toBe(1);

      const after = database
        .query("SELECT sha FROM gh_commits WHERE repo = ?")
        .all("Mosaicstg/LiUNA-Campaigns") as { sha: string }[];
      expect(after.length).toBe(2);

      database.close();
    } finally {
      rmSync(homeDirectory, { recursive: true, force: true });
      rmSync(sourceDirectory, { recursive: true, force: true });
    }
  });

  test("rate limit: retries on 403 with Retry-After, fails after exhausting retries", async () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), "tempad-home-"));
    try {
      const dbPath = join(homeDirectory, "tempad.db");
      const database = openDatabase(dbPath);
      const config = baseConfig(homeDirectory);

      let callCount = 0;
      const succeedAfterTwo: typeof fetch = (async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/search/commits")) {
          callCount++;
          if (callCount <= 2) {
            return new Response("rate limited", {
              status: 403,
              headers: { "Retry-After": "0" },
            });
          }
          return jsonResponse(loadFixture("search-commits.json"));
        }
        if (url.includes("reviewed-by"))
          return jsonResponse(loadFixture("search-issues-reviewed.json"));
        if (url.includes("/search/issues"))
          return jsonResponse(loadFixture("search-issues-authored.json"));
        if (url.includes("/pulls")) return jsonResponse(loadFixture("pulls.json"));
        return jsonResponse({ items: [], total_count: 0 });
      }) as typeof fetch;

      const noopRunner: CommandRunner = {
        async run() {
          return { code: 0, stdout: "", stderr: "" };
        },
      };

      const collector = createGithubCollector({ fetch: succeedAfterTwo, runner: noopRunner });
      const summary = await collector.sync(database, config, {});
      expect(summary.source).toBe("github");
      expect(callCount).toBe(3);

      database.close();
    } finally {
      rmSync(homeDirectory, { recursive: true, force: true });
    }
  });

  test("rate limit: fails the source after three retries", async () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), "tempad-home-"));
    try {
      const dbPath = join(homeDirectory, "tempad.db");
      const database = openDatabase(dbPath);
      const config = baseConfig(homeDirectory);

      const alwaysRateLimited: typeof fetch = (async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/search/commits")) {
          return new Response("rate limited", { status: 403, headers: { "Retry-After": "0" } });
        }
        return jsonResponse({ items: [], total_count: 0 });
      }) as typeof fetch;

      const noopRunner: CommandRunner = {
        async run() {
          return { code: 0, stdout: "", stderr: "" };
        },
      };

      const collector = createGithubCollector({ fetch: alwaysRateLimited, runner: noopRunner });
      await expect(collector.sync(database, config, {})).rejects.toThrow(/rate limit/i);

      database.close();
    } finally {
      rmSync(homeDirectory, { recursive: true, force: true });
    }
  });

  test("a repo discovered only via reviewed-by search is still mirrored and its commits collected", async () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), "tempad-home-"));
    const sourceDirectory = await buildRepository([
      {
        message: "reviewed repo commit",
        authorName: "Someone Else",
        authorEmail: "someone@example.com",
        date: "2026-09-02T10:00:00-03:00",
        files: { "x.md": "x" },
      },
    ]);

    try {
      const dbPath = join(homeDirectory, "tempad.db");
      const database = openDatabase(dbPath);
      const config = { ...baseConfig(homeDirectory), gitAuthorEmails: ["someone@example.com"] };

      const fetchImpl: typeof fetch = (async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/search/commits")) {
          return jsonResponse({ total_count: 0, items: [] });
        }
        if (url.includes("reviewed-by")) {
          return jsonResponse(loadFixture("search-issues-reviewed-only-repo.json"));
        }
        if (url.includes("/search/issues")) {
          return jsonResponse({ total_count: 0, items: [] });
        }
        if (url.includes("/pulls")) {
          return jsonResponse(loadFixture("pulls-only-reviewed.json"));
        }
        return jsonResponse({ items: [], total_count: 0 });
      }) as typeof fetch;

      const runner = makeRunner({ source: sourceDirectory });
      const collector = createGithubCollector({ fetch: fetchImpl, runner });

      const summary = await collector.sync(database, config, {});

      expect(summary.warnings).toEqual([]);

      const repoRow = database
        .query("SELECT full_name, mirrored_at FROM gh_repos WHERE full_name = ?")
        .get("Mosaicstg/only-reviewed") as { full_name: string; mirrored_at: string | null } | null;
      expect(repoRow?.mirrored_at).not.toBeNull();

      const commitRows = database
        .query("SELECT sha FROM gh_commits WHERE repo = ?")
        .all("Mosaicstg/only-reviewed") as { sha: string }[];
      expect(commitRows.length).toBe(1);

      const pullRequestRows = database
        .query("SELECT number, role FROM gh_pull_requests WHERE repo = ?")
        .all("Mosaicstg/only-reviewed") as { number: number; role: string }[];
      expect(pullRequestRows).toEqual([{ number: 7, role: "reviewer" }]);

      database.close();
    } finally {
      rmSync(homeDirectory, { recursive: true, force: true });
      rmSync(sourceDirectory, { recursive: true, force: true });
    }
  });

  test("one repo failing to mirror does not block commits/PRs for other repos, and is warned", async () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), "tempad-home-"));
    const sourceDirectory = await buildRepository([
      {
        message: "good repo commit",
        authorName: "Saulo Vallory",
        authorEmail: "me@saulo.engineer",
        date: "2026-09-02T10:00:00-03:00",
        files: { "readme.md": "hello" },
      },
    ]);

    try {
      const dbPath = join(homeDirectory, "tempad.db");
      const database = openDatabase(dbPath);
      const config = baseConfig(homeDirectory);

      const fetchImpl: typeof fetch = (async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/search/commits")) {
          return jsonResponse({
            total_count: 2,
            items: [
              { repository: { full_name: "Mosaicstg/broken-repo" } },
              { repository: { full_name: "Mosaicstg/LiUNA-Campaigns" } },
            ],
          });
        }
        if (url.includes("reviewed-by")) return jsonResponse({ total_count: 0, items: [] });
        if (url.includes("/search/issues"))
          return jsonResponse(loadFixture("search-issues-authored.json"));
        if (url.includes("/pulls")) return jsonResponse(loadFixture("pulls.json"));
        return jsonResponse({ items: [], total_count: 0 });
      }) as typeof fetch;

      const runner: CommandRunner = {
        async run(argv, cwd) {
          if (
            argv[0] === "git" &&
            argv[1] === "clone" &&
            argv.some((arg) => arg.includes("broken-repo.git"))
          ) {
            return { code: 1, stdout: "", stderr: "simulated clone failure" };
          }
          return makeRunner({ source: sourceDirectory }).run(argv, cwd);
        },
      };

      const collector = createGithubCollector({ fetch: fetchImpl, runner });

      await expect(collector.sync(database, config, {})).rejects.toThrow(/could not be mirrored/i);

      const commitRows = database
        .query("SELECT sha FROM gh_commits WHERE repo = ?")
        .all("Mosaicstg/LiUNA-Campaigns") as { sha: string }[];
      expect(commitRows.length).toBe(1);

      const pullRequestRows = database
        .query("SELECT number FROM gh_pull_requests WHERE repo = ?")
        .all("Mosaicstg/LiUNA-Campaigns") as { number: number }[];
      expect(pullRequestRows).toEqual([{ number: 42 }]);

      const brokenRepoRow = database
        .query("SELECT mirrored_at FROM gh_repos WHERE full_name = ?")
        .get("Mosaicstg/broken-repo") as { mirrored_at: string | null } | null;
      expect(brokenRepoRow?.mirrored_at).toBeNull();

      database.close();
    } finally {
      rmSync(homeDirectory, { recursive: true, force: true });
      rmSync(sourceDirectory, { recursive: true, force: true });
    }
  });

  test("gh CLI fallback retries on secondary rate limit stderr, then succeeds", async () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), "tempad-home-"));
    try {
      const dbPath = join(homeDirectory, "tempad.db");
      const database = openDatabase(dbPath);
      const config = { ...baseConfig(homeDirectory), ghToken: undefined };

      let searchCommitsCalls = 0;
      const runner: CommandRunner = {
        async run(argv) {
          const fullPath = argv[2] ?? "";
          if (typeof fullPath === "string" && fullPath.includes("/search/commits")) {
            searchCommitsCalls++;
            if (searchCommitsCalls <= 2) {
              return {
                code: 1,
                stdout: "",
                stderr: "gh: You have exceeded a secondary rate limit. (HTTP 403)",
              };
            }
            return {
              code: 0,
              stdout: JSON.stringify(loadFixture("search-commits.json")),
              stderr: "",
            };
          }
          if (typeof fullPath === "string" && fullPath.includes("reviewed-by")) {
            return {
              code: 0,
              stdout: JSON.stringify(loadFixture("search-issues-reviewed.json")),
              stderr: "",
            };
          }
          if (typeof fullPath === "string" && fullPath.includes("/search/issues")) {
            return {
              code: 0,
              stdout: JSON.stringify(loadFixture("search-issues-authored.json")),
              stderr: "",
            };
          }
          if (typeof fullPath === "string" && fullPath.includes("/pulls")) {
            return { code: 0, stdout: JSON.stringify(loadFixture("pulls.json")), stderr: "" };
          }
          return { code: 0, stdout: JSON.stringify({ items: [], total_count: 0 }), stderr: "" };
        },
      };

      const noopFetch: typeof fetch = (async () =>
        jsonResponse({ items: [], total_count: 0 })) as unknown as typeof fetch;
      const collector = createGithubCollector({ fetch: noopFetch, runner, ghCliRetryDelayMs: 0 });

      const summary = await collector.sync(database, config, {});

      expect(searchCommitsCalls).toBe(3);
      expect(summary.source).toBe("github");

      database.close();
    } finally {
      rmSync(homeDirectory, { recursive: true, force: true });
    }
  });

  test("gh CLI fallback retries when a call succeeds (code 0) but returns unparseable output", async () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), "tempad-home-"));
    try {
      const dbPath = join(homeDirectory, "tempad.db");
      const database = openDatabase(dbPath);
      const config = { ...baseConfig(homeDirectory), ghToken: undefined };

      let pullsCalls = 0;
      const runner: CommandRunner = {
        async run(argv) {
          const fullPath = argv[2] ?? "";
          if (typeof fullPath === "string" && fullPath.includes("/search/commits")) {
            return {
              code: 0,
              stdout: JSON.stringify(loadFixture("search-commits.json")),
              stderr: "",
            };
          }
          if (typeof fullPath === "string" && fullPath.includes("reviewed-by")) {
            return {
              code: 0,
              stdout: JSON.stringify(loadFixture("search-issues-reviewed.json")),
              stderr: "",
            };
          }
          if (typeof fullPath === "string" && fullPath.includes("/search/issues")) {
            return {
              code: 0,
              stdout: JSON.stringify(loadFixture("search-issues-authored.json")),
              stderr: "",
            };
          }
          if (typeof fullPath === "string" && fullPath.includes("/pulls")) {
            pullsCalls++;
            if (pullsCalls <= 2) {
              return { code: 0, stdout: "", stderr: "" };
            }
            return { code: 0, stdout: JSON.stringify(loadFixture("pulls.json")), stderr: "" };
          }
          return { code: 0, stdout: JSON.stringify({ items: [], total_count: 0 }), stderr: "" };
        },
      };

      const noopFetch: typeof fetch = (async () =>
        jsonResponse({ items: [], total_count: 0 })) as unknown as typeof fetch;
      const collector = createGithubCollector({ fetch: noopFetch, runner, ghCliRetryDelayMs: 0 });

      const summary = await collector.sync(database, config, {});

      expect(pullsCalls).toBe(3);
      const pullRequestRows = database
        .query("SELECT number FROM gh_pull_requests WHERE repo = ?")
        .all("Mosaicstg/LiUNA-Campaigns") as { number: number }[];
      expect(pullRequestRows).toEqual([{ number: 42 }]);
      expect(summary.warnings).toEqual([]);

      database.close();
    } finally {
      rmSync(homeDirectory, { recursive: true, force: true });
    }
  });
});
