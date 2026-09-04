import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { logCommits } from "../src/collect/github/log.ts";
import { buildRepository } from "./fixtures/git/build-repository.ts";

function runner() {
  return {
    async run(argv: string[], cwd?: string) {
      const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const code = await proc.exited;
      return { code, stdout, stderr };
    },
  };
}

describe("logCommits", () => {
  test("strictly filters out commits older than `since`, even ones git's --since traversal would leak", async () => {
    const directory = await buildRepository([
      {
        message: "old commit, out of chronological order on this branch",
        authorName: "Saulo Vallory",
        authorEmail: "me@saulo.engineer",
        date: "2026-07-21T13:57:02-03:00",
        files: { "old.md": "old" },
      },
      {
        message: "recent commit",
        authorName: "Saulo Vallory",
        authorEmail: "me@saulo.engineer",
        date: "2026-09-02T10:00:00-03:00",
        files: { "new.md": "new" },
      },
    ]);

    try {
      const since = "2026-08-28T00:00:00.000Z";
      const commits = await logCommits(directory, since, runner());

      expect(commits.length).toBe(1);
      expect(commits[0]?.subject).toBe("recent commit");
      for (const commit of commits) {
        expect(new Date(commit.authoredAt).getTime()).toBeGreaterThanOrEqual(
          new Date(since).getTime(),
        );
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
