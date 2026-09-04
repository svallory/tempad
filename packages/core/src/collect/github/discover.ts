import { type GithubRequestOptions, githubRequest } from "./request.ts";

export interface DiscoveredRepository {
  fullName: string;
  org: string;
  isPersonal: boolean;
  defaultBranch: string | undefined;
  sshUrl: string | undefined;
}

interface SearchRepositoryItem {
  full_name: string;
  default_branch?: string;
  ssh_url?: string;
}

interface SearchCommitsResponseItem {
  repository: SearchRepositoryItem;
}

interface SearchIssuesResponseItem {
  repository_url: string;
  number: number;
  pull_request?: unknown;
}

interface SearchResponse<TItem> {
  total_count: number;
  items: TItem[];
}

const PER_PAGE = 100;

async function paginateSearch<TItem>(
  endpoint: "search/commits" | "search/issues",
  query: string,
  options: GithubRequestOptions,
): Promise<TItem[]> {
  const items: TItem[] = [];
  for (let page = 1; ; page++) {
    const response = (await githubRequest(
      `/${endpoint}`,
      { q: query, per_page: PER_PAGE, page },
      options,
    )) as SearchResponse<TItem>;
    items.push(...response.items);
    if (response.items.length < PER_PAGE) break;
  }
  return items;
}

function repositoryFromSearchUrl(repositoryUrl: string): string {
  const match = repositoryUrl.match(/repos\/([^/]+\/[^/]+)$/);
  if (!match?.[1]) {
    throw new Error(`Could not parse repository from search URL: ${repositoryUrl}`);
  }
  return match[1];
}

export interface DiscoverResult {
  repositories: Map<string, DiscoveredRepository>;
  authoredPullRequestNumbersByRepository: Map<string, Set<number>>;
  reviewedPullRequestNumbersByRepository: Map<string, Set<number>>;
}

function addPullRequestNumber(
  map: Map<string, Set<number>>,
  repository: string,
  number: number,
): void {
  const numbers = map.get(repository) ?? new Set<number>();
  numbers.add(number);
  map.set(repository, numbers);
}

export async function discoverRepositories(
  ghUser: string,
  orgs: string[],
  includePersonal: boolean,
  lower: string,
  options: GithubRequestOptions,
): Promise<DiscoverResult> {
  const repositories = new Map<string, DiscoveredRepository>();
  const authoredPullRequestNumbersByRepository = new Map<string, Set<number>>();
  const reviewedPullRequestNumbersByRepository = new Map<string, Set<number>>();

  const scopes: { scope: string; org: string | undefined; isPersonal: boolean }[] = orgs.map(
    (org) => ({ scope: `org:${org}`, org, isPersonal: false }),
  );
  if (includePersonal) {
    scopes.push({ scope: `user:${ghUser}`, org: undefined, isPersonal: true });
  }

  for (const { scope, org, isPersonal } of scopes) {
    const commitItems = await paginateSearch<SearchCommitsResponseItem>(
      "search/commits",
      `author:${ghUser} ${scope} author-date:>=${lower}`,
      options,
    );
    for (const item of commitItems) {
      const fullName = item.repository.full_name;
      const repositoryOrg = org ?? fullName.split("/")[0] ?? ghUser;
      if (!repositories.has(fullName)) {
        repositories.set(fullName, {
          fullName,
          org: repositoryOrg,
          isPersonal,
          defaultBranch: item.repository.default_branch,
          sshUrl: item.repository.ssh_url,
        });
      }
    }

    const authoredItems = await paginateSearch<SearchIssuesResponseItem>(
      "search/issues",
      `type:pr author:${ghUser} ${scope}`,
      options,
    );
    for (const item of authoredItems) {
      const fullName = repositoryFromSearchUrl(item.repository_url);
      const repositoryOrg = org ?? fullName.split("/")[0] ?? ghUser;
      if (!repositories.has(fullName)) {
        repositories.set(fullName, {
          fullName,
          org: repositoryOrg,
          isPersonal,
          defaultBranch: undefined,
          sshUrl: undefined,
        });
      }
      addPullRequestNumber(authoredPullRequestNumbersByRepository, fullName, item.number);
    }

    const reviewedItems = await paginateSearch<SearchIssuesResponseItem>(
      "search/issues",
      `type:pr reviewed-by:${ghUser} ${scope}`,
      options,
    );
    for (const item of reviewedItems) {
      const fullName = repositoryFromSearchUrl(item.repository_url);
      const repositoryOrg = org ?? fullName.split("/")[0] ?? ghUser;
      if (!repositories.has(fullName)) {
        repositories.set(fullName, {
          fullName,
          org: repositoryOrg,
          isPersonal,
          defaultBranch: undefined,
          sshUrl: undefined,
        });
      }
      addPullRequestNumber(reviewedPullRequestNumbersByRepository, fullName, item.number);
    }
  }

  return {
    repositories,
    authoredPullRequestNumbersByRepository,
    reviewedPullRequestNumbersByRepository,
  };
}
