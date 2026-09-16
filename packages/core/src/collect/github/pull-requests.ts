import { type GithubRequestOptions, githubRequest } from "./request.ts";

export interface PullRequestRecord {
  repo: string;
  number: number;
  title: string;
  state: "open" | "closed" | "merged";
  author: string;
  role: "author" | "reviewer";
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  updatedAt: string;
}

interface ApiPullRequest {
  number: number;
  title: string;
  state: "open" | "closed";
  user: { login: string } | null;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  closed_at: string | null;
}

const PER_PAGE = 100;

export async function fetchPullRequests(
  fullName: string,
  lower: string,
  authoredNumbers: Set<number>,
  reviewedNumbers: Set<number>,
  options: GithubRequestOptions,
): Promise<PullRequestRecord[]> {
  const records: PullRequestRecord[] = [];

  outer: for (let page = 1; ; page++) {
    const pulls = (await githubRequest(
      `/repos/${fullName}/pulls`,
      { state: "all", sort: "updated", direction: "desc", per_page: PER_PAGE, page },
      options,
    )) as ApiPullRequest[];

    if (pulls.length === 0) break;

    for (const pull of pulls) {
      if (pull.updated_at < lower) break outer;

      const isAuthored = authoredNumbers.has(pull.number);
      const isReviewed = reviewedNumbers.has(pull.number);
      if (!isAuthored && !isReviewed) continue;

      const state = pull.merged_at ? "merged" : pull.state;
      const role = isAuthored ? "author" : "reviewer";

      records.push({
        repo: fullName,
        number: pull.number,
        title: pull.title,
        state,
        author: pull.user?.login ?? "",
        role,
        createdAt: pull.created_at,
        mergedAt: pull.merged_at,
        closedAt: pull.closed_at,
        updatedAt: pull.updated_at,
      });
    }

    if (pulls.length < PER_PAGE) break;
  }

  return records;
}

interface ApiPullRequestCommit {
  commit: { author: { date: string } | null };
}

const COMMITS_PER_PAGE = 100;
/** GitHub's `pulls/{number}/commits` endpoint never returns more than this many commits. */
const MAX_COMMITS = 250;

/** Earliest commit author date among the PR's commits, or `null` if it has none. */
export async function fetchFirstAuthoredAt(
  fullName: string,
  number: number,
  options: GithubRequestOptions,
): Promise<string | null> {
  let earliest: string | null = null;
  let fetched = 0;

  for (let page = 1; fetched < MAX_COMMITS; page++) {
    const commits = (await githubRequest(
      `/repos/${fullName}/pulls/${number}/commits`,
      { per_page: COMMITS_PER_PAGE, page },
      options,
    )) as ApiPullRequestCommit[];

    if (commits.length === 0) break;
    fetched += commits.length;

    for (const commit of commits) {
      const authoredAt = commit.commit.author?.date;
      if (!authoredAt) continue;
      if (!earliest || authoredAt < earliest) earliest = authoredAt;
    }

    if (commits.length < COMMITS_PER_PAGE) break;
  }

  return earliest;
}
