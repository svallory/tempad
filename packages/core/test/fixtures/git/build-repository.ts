import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CommitSpec {
  message: string;
  authorName: string;
  authorEmail: string;
  date: string;
  files: Record<string, string>;
}

async function run(argv: string[], cwd: string, env?: Record<string, string>): Promise<void> {
  const proc = Bun.spawn(argv, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`${argv.join(" ")} failed in ${cwd}: ${stderr}`);
  }
}

export async function buildRepository(commits: CommitSpec[]): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), "tempad-git-fixture-"));
  await run(["git", "init", "--initial-branch=main"], directory);
  await run(["git", "config", "user.name", "fixture"], directory);
  await run(["git", "config", "user.email", "fixture@example.com"], directory);

  for (const commit of commits) {
    await addCommit(directory, commit);
  }

  return directory;
}

export async function addCommit(directory: string, commit: CommitSpec): Promise<void> {
  for (const [path, content] of Object.entries(commit.files)) {
    await Bun.write(join(directory, path), content);
  }
  await run(["git", "add", "-A"], directory);
  await run(
    [
      "git",
      "commit",
      "-m",
      commit.message,
      "--author",
      `${commit.authorName} <${commit.authorEmail}>`,
    ],
    directory,
    {
      GIT_AUTHOR_DATE: commit.date,
      GIT_COMMITTER_DATE: commit.date,
    },
  );
}

export async function mirrorRepository(
  sourceDirectory: string,
  mirrorDirectory: string,
): Promise<void> {
  await run(["git", "clone", "--mirror", sourceDirectory, mirrorDirectory], tmpdir());
}

export async function updateMirror(mirrorDirectory: string): Promise<void> {
  await run(["git", "remote", "update", "--prune"], mirrorDirectory);
}
