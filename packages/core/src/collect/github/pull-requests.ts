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
      });
    }

    if (pulls.length < PER_PAGE) break;
  }

  return records;
}
