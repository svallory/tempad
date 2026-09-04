import type { Database } from "bun:sqlite";
import type { Config } from "../config/env.ts";
import { getSyncState, setSyncState } from "../db/sync-state.ts";
import { discoverRepositories } from "./github/discover.ts";
import { branchesContaining, commitExists, logCommits } from "./github/log.ts";
import { mirrorRepository } from "./github/mirror.ts";
import { fetchPullRequests } from "./github/pull-requests.ts";
import type { CommandRunner } from "./github/request.ts";
import type { Collector, SyncOptions, SyncSummary } from "./types.ts";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function lowerBound(since: string, lastSyncAt: string | undefined): string {
  if (!lastSyncAt) return since;
  return new Date(new Date(lastSyncAt).getTime() - SEVEN_DAYS_MS).toISOString();
}

export interface GithubCollectorDependencies {
  fetch: typeof fetch;
  runner: CommandRunner;
  ghCliRetryDelayMs?: number;
}

function upsertRepository(
  database: Database,
  fullName: string,
  org: string,
  isPersonal: boolean,
  defaultBranch: string | undefined,
): void {
  database
    .query(
      `INSERT INTO gh_repos (full_name, org, is_personal, default_branch)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(full_name) DO UPDATE SET
         default_branch = COALESCE(excluded.default_branch, gh_repos.default_branch)`,
    )
    .run(fullName, org, isPersonal ? 1 : 0, defaultBranch ?? null);
}

function setMirroredAt(database: Database, fullName: string, timestamp: string): void {
  database
    .query(`UPDATE gh_repos SET mirrored_at = ? WHERE full_name = ?`)
    .run(timestamp, fullName);
}

function upsertCommit(
  database: Database,
  repo: string,
  commit: {
    sha: string;
    branches: string[];
    authorName: string;
    authorEmail: string;
    authoredAt: string;
    committedAt: string;
    subject: string;
    body: string;
    filesChanged: number | null;
    insertions: number | null;
    deletions: number | null;
  },
): "inserted" | "updated" {
  const existing = database.query(`SELECT sha FROM gh_commits WHERE sha = ?`).get(commit.sha);
  database
    .query(
      `INSERT INTO gh_commits
         (sha, repo, branches, author_name, author_email, authored_at, committed_at, subject, body, files_changed, insertions, deletions)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(sha) DO UPDATE SET
         branches = excluded.branches,
         author_name = excluded.author_name,
         author_email = excluded.author_email,
         authored_at = excluded.authored_at,
         committed_at = excluded.committed_at,
         subject = excluded.subject,
         body = excluded.body,
         files_changed = excluded.files_changed,
         insertions = excluded.insertions,
         deletions = excluded.deletions`,
    )
    .run(
      commit.sha,
      repo,
      JSON.stringify(commit.branches),
      commit.authorName,
      commit.authorEmail,
      commit.authoredAt,
      commit.committedAt,
      commit.subject,
      commit.body,
      commit.filesChanged,
      commit.insertions,
      commit.deletions,
    );
  return existing ? "updated" : "inserted";
}

function upsertPullRequest(
  database: Database,
  pullRequest: {
    repo: string;
    number: number;
    title: string;
    state: string;
    author: string;
    role: string;
    createdAt: string;
    mergedAt: string | null;
    closedAt: string | null;
  },
): "inserted" | "updated" {
  const existing = database
    .query(`SELECT number FROM gh_pull_requests WHERE repo = ? AND number = ?`)
    .get(pullRequest.repo, pullRequest.number);
  database
    .query(
      `INSERT INTO gh_pull_requests (repo, number, title, state, author, role, created_at, merged_at, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo, number) DO UPDATE SET
         title = excluded.title,
         state = excluded.state,
         author = excluded.author,
         role = excluded.role,
         created_at = excluded.created_at,
         merged_at = excluded.merged_at,
         closed_at = excluded.closed_at`,
    )
    .run(
      pullRequest.repo,
      pullRequest.number,
      pullRequest.title,
      pullRequest.state,
      pullRequest.author,
      pullRequest.role,
      pullRequest.createdAt,
      pullRequest.mergedAt,
      pullRequest.closedAt,
    );
  return existing ? "updated" : "inserted";
}

export function createGithubCollector(dependencies: GithubCollectorDependencies): Collector {
  return {
    name: "github",
    async sync(database: Database, config: Config, options: SyncOptions): Promise<SyncSummary> {
      const syncStart = new Date().toISOString();
      const syncState = getSyncState(database, "github");
      const lower = lowerBound(options.since ?? config.since, syncState?.lastSyncAt);
      const fetchImplementation = options.fetch ?? dependencies.fetch;

      const requestOptions = {
        token: config.ghToken,
        fetch: fetchImplementation,
        runner: dependencies.runner,
        ghCliRetryDelayMs: dependencies.ghCliRetryDelayMs,
      };

      let inserted = 0;
      let updated = 0;
      let deleted = 0;
      const warnings: string[] = [];
      let anyMirrorFailed = false;

      const discovery = await discoverRepositories(
        config.ghUser,
        config.ghOrgs,
        config.ghIncludePersonal,
        lower,
        requestOptions,
      );

      for (const repository of discovery.repositories.values()) {
        upsertRepository(
          database,
          repository.fullName,
          repository.org,
          repository.isPersonal,
          repository.defaultBranch,
        );
      }

      for (const repository of discovery.repositories.values()) {
        const mirrorResult = await mirrorRepository(
          repository.fullName,
          repository.org,
          config.home,
          dependencies.runner,
          repository.sshUrl,
        );

        if (!mirrorResult.ok) {
          warnings.push(mirrorResult.error);
          anyMirrorFailed = true;
          continue;
        }

        setMirroredAt(database, repository.fullName, new Date().toISOString());

        const commits = await logCommits(mirrorResult.path, lower, dependencies.runner);
        const matchingEmails = new Set(config.gitAuthorEmails.map((email) => email.toLowerCase()));

        for (const commit of commits) {
          if (!matchingEmails.has(commit.authorEmail.toLowerCase())) continue;

          const branches = await branchesContaining(
            mirrorResult.path,
            commit.sha,
            dependencies.runner,
          );
          const outcome = upsertCommit(database, repository.fullName, { ...commit, branches });
          if (outcome === "inserted") inserted++;
          else updated++;
        }

        const storedShas = database
          .query(`SELECT sha FROM gh_commits WHERE repo = ? AND authored_at >= ?`)
          .all(repository.fullName, lower) as { sha: string }[];

        for (const { sha } of storedShas) {
          const exists = await commitExists(mirrorResult.path, sha, dependencies.runner);
          const branches = exists
            ? await branchesContaining(mirrorResult.path, sha, dependencies.runner)
            : [];
          if (!exists || branches.length === 0) {
            database.query(`DELETE FROM gh_commits WHERE sha = ?`).run(sha);
            deleted++;
          }
        }

        const authoredNumbers =
          discovery.authoredPullRequestNumbersByRepository.get(repository.fullName) ?? new Set();
        const reviewedNumbers =
          discovery.reviewedPullRequestNumbersByRepository.get(repository.fullName) ?? new Set();

        if (authoredNumbers.size > 0 || reviewedNumbers.size > 0) {
          const pullRequests = await fetchPullRequests(
            repository.fullName,
            lower,
            authoredNumbers,
            reviewedNumbers,
            requestOptions,
          );
          for (const pullRequest of pullRequests) {
            const outcome = upsertPullRequest(database, pullRequest);
            if (outcome === "inserted") inserted++;
            else updated++;
          }
        }
      }

      if (anyMirrorFailed) {
        throw new Error(
          `github sync failed: ${warnings.length} repository(ies) could not be mirrored: ${warnings.join("; ")}`,
        );
      }

      setSyncState(database, "github", syncStart);

      return { source: "github", inserted, updated, deleted, warnings };
    },
  };
}
