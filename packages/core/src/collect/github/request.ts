export interface CommandRunner {
  run(argv: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface GithubRequestOptions {
  token: string | undefined;
  fetch: typeof fetch;
  runner: CommandRunner;
}

const API_BASE = "https://api.github.com";
const MAX_RATE_LIMIT_RETRIES = 3;

function toQueryString(query: Record<string, string | number> | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    params.set(key, String(value));
  }
  const serialized = params.toString();
  return serialized.length > 0 ? `?${serialized}` : "";
}

function parseRetryAfterSeconds(headers: Headers): number {
  const retryAfter = headers.get("Retry-After");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return seconds;
  }
  const resetHeader = headers.get("X-RateLimit-Reset");
  if (resetHeader) {
    const resetAt = Number(resetHeader);
    if (Number.isFinite(resetAt)) {
      return Math.max(0, resetAt - Math.floor(Date.now() / 1000));
    }
  }
  return 1;
}

async function requestViaFetch(
  path: string,
  query: Record<string, string | number> | undefined,
  options: GithubRequestOptions,
): Promise<unknown> {
  const url = `${API_BASE}${path}${toQueryString(query)}`;

  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    const response = await options.fetch(url, {
      headers: {
        Authorization: `Bearer ${options.token}`,
        Accept: "application/vnd.github+json",
      },
    });

    if (response.status === 403 || response.status === 429) {
      if (attempt === MAX_RATE_LIMIT_RETRIES) {
        throw new Error(
          `GitHub rate limit exceeded after ${MAX_RATE_LIMIT_RETRIES} retries: ${path}`,
        );
      }
      const waitSeconds = parseRetryAfterSeconds(response.headers);
      await Bun.sleep(waitSeconds * 1000);
      continue;
    }

    if (!response.ok) {
      throw new Error(`GitHub API error ${response.status} for ${path}: ${await response.text()}`);
    }

    return response.json();
  }

  throw new Error(`GitHub rate limit exceeded after ${MAX_RATE_LIMIT_RETRIES} retries: ${path}`);
}

async function requestViaGhCli(
  path: string,
  query: Record<string, string | number> | undefined,
  runner: CommandRunner,
): Promise<unknown> {
  const fullPath = `${path}${toQueryString(query)}`;
  const result = await runner.run(["gh", "api", fullPath]);
  if (result.code !== 0) {
    throw new Error(`gh api ${fullPath} failed: ${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

export function githubRequest(
  path: string,
  query: Record<string, string | number> | undefined,
  options: GithubRequestOptions,
): Promise<unknown> {
  if (options.token) {
    return requestViaFetch(path, query, options);
  }
  return requestViaGhCli(path, query, options.runner);
}
