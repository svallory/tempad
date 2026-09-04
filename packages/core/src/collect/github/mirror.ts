import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CommandRunner } from "./request.ts";

export function mirrorPath(tempadHome: string, org: string, repo: string): string {
  return join(tempadHome, "repos", org, `${repo}.git`);
}

function sshUrlFor(fullName: string): string {
  return `git@github.com:${fullName}.git`;
}

export async function mirrorRepository(
  fullName: string,
  org: string,
  tempadHome: string,
  runner: CommandRunner,
  sshUrl?: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const [, repo] = fullName.split("/");
  if (!repo) {
    return { ok: false, error: `Invalid repository full name: ${fullName}` };
  }
  const path = mirrorPath(tempadHome, org, repo);
  const url = sshUrl ?? sshUrlFor(fullName);

  if (existsSync(path)) {
    const result = await runner.run(["git", "remote", "update", "--prune"], path);
    if (result.code !== 0) {
      return {
        ok: false,
        error: `git remote update --prune failed for ${fullName}: ${result.stderr}`,
      };
    }
    return { ok: true, path };
  }

  const result = await runner.run(["git", "clone", "--mirror", url, path]);
  if (result.code !== 0) {
    return { ok: false, error: `git clone --mirror failed for ${fullName}: ${result.stderr}` };
  }
  return { ok: true, path };
}
