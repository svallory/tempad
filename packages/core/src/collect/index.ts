import { claudeCollector } from "./claude.ts";
import type { CommandRunner } from "./github/request.ts";
import { createGithubCollector } from "./github.ts";
import { mondayCollector } from "./monday.ts";
import type { Collector } from "./types.ts";

const defaultRunner: CommandRunner = {
  async run(argv, cwd) {
    const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { code, stdout, stderr };
  },
};

export const collectors: Map<Collector["name"], Collector> = new Map();
collectors.set(mondayCollector.name, mondayCollector);
collectors.set(claudeCollector.name, claudeCollector);
collectors.set("github", createGithubCollector({ fetch, runner: defaultRunner }));
