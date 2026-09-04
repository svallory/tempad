import type { CommandRunner } from "./request.ts";

export interface CommitRecord {
  sha: string;
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  committedAt: string;
  subject: string;
  body: string;
  filesChanged: number | null;
  insertions: number | null;
  deletions: number | null;
}

const FIELD_SEP = "\x1f";
const RECORD_SEP = "\x1e";
const LOG_FORMAT = ["%H", "%an", "%ae", "%aI", "%cI", "%s", "%b"].join(FIELD_SEP);

function parseShortstat(line: string | undefined): {
  filesChanged: number | null;
  insertions: number | null;
  deletions: number | null;
} {
  if (!line) return { filesChanged: null, insertions: null, deletions: null };

  const filesMatch = line.match(/(\d+) files? changed/);
  const insertionsMatch = line.match(/(\d+) insertions?\(\+\)/);
  const deletionsMatch = line.match(/(\d+) deletions?\(-\)/);

  return {
    filesChanged: filesMatch?.[1] ? Number.parseInt(filesMatch[1], 10) : null,
    insertions: insertionsMatch?.[1] ? Number.parseInt(insertionsMatch[1], 10) : null,
    deletions: deletionsMatch?.[1] ? Number.parseInt(deletionsMatch[1], 10) : null,
  };
}

export function parseLogOutput(output: string): CommitRecord[] {
  const records = output
    .split(RECORD_SEP)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const commits: CommitRecord[] = [];
  for (const record of records) {
    const lines = record.split("\n");
    const headerLine = lines[0] ?? "";
    const fields = headerLine.split(FIELD_SEP);
    const [sha, authorName, authorEmail, authoredAt, committedAt, subject] = fields;
    if (!sha) continue;

    const bodyAndStat = lines.slice(1).join("\n");
    const shortstatMatch = bodyAndStat.match(/^\s*(\d+ files? changed.*)$/m);
    const body = shortstatMatch
      ? bodyAndStat.slice(0, shortstatMatch.index).trim()
      : bodyAndStat.trim();
    const stat = parseShortstat(shortstatMatch?.[1]);

    commits.push({
      sha,
      authorName: authorName ?? "",
      authorEmail: authorEmail ?? "",
      authoredAt: authoredAt ?? "",
      committedAt: committedAt ?? "",
      subject: subject ?? "",
      body,
      ...stat,
    });
  }
  return commits;
}

export async function logCommits(
  mirrorDirectory: string,
  since: string,
  runner: CommandRunner,
): Promise<CommitRecord[]> {
  const result = await runner.run(
    [
      "git",
      "log",
      "--all",
      "--no-merges",
      `--since=${since}`,
      "--date=iso-strict",
      `--format=${RECORD_SEP}${LOG_FORMAT}`,
      "--shortstat",
    ],
    mirrorDirectory,
  );
  if (result.code !== 0) {
    throw new Error(`git log failed in ${mirrorDirectory}: ${result.stderr}`);
  }
  return parseLogOutput(result.stdout);
}

export async function branchesContaining(
  mirrorDirectory: string,
  sha: string,
  runner: CommandRunner,
): Promise<string[]> {
  const result = await runner.run(
    ["git", "branch", "-a", "--contains", sha, "--format=%(refname:short)"],
    mirrorDirectory,
  );
  if (result.code !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export async function commitExists(
  mirrorDirectory: string,
  sha: string,
  runner: CommandRunner,
): Promise<boolean> {
  const result = await runner.run(["git", "cat-file", "-e", sha], mirrorDirectory);
  return result.code === 0;
}
