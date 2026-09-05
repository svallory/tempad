import { describe, expect, test } from "bun:test";
import type { ClassifierWindow } from "../../src/w5/classifier";
import {
  ClaudeCliClassifier,
  type CliSpawn,
  type CliSpawnResult,
} from "../../src/w5/classifier-cli";

const window: ClassifierWindow = {
  sessionId: "s1",
  title: "session",
  cwd: "/repo",
  gitBranch: "main",
  org: "acme",
  project: "widgets",
  messages: [
    { ts: "2026-09-04T15:00:00.000Z", role: "user", text: "fix bug" },
    { ts: "2026-09-04T15:05:00.000Z", role: "assistant", text: "done" },
  ],
  openQuests: [],
  previousTrace: null,
};

const good = {
  segments: [
    {
      startedAt: "2026-09-04T15:00:00.000Z",
      endedAt: "2026-09-04T15:05:00.000Z",
      what: "fix bug",
      why: "ship widgets",
      matchedQuest: null,
      proposedQuest: null,
      matchedActivity: null,
      isSwitch: false,
      trigger: null,
      confidence: 0.9,
      questions: [],
    },
  ],
};

function envelope(resultText: string): string {
  return JSON.stringify({ result: resultText, session_id: "cli-session", stop_reason: "end_turn" });
}

function makeSpawn(
  handler: (
    argv: string[],
    options: { cwd: string; stdin: string; timeoutMs: number },
  ) => CliSpawnResult,
): { spawn: CliSpawn; calls: { argv: string[]; stdin: string }[] } {
  const calls: { argv: string[]; stdin: string }[] = [];
  const spawn: CliSpawn = async (argv, options) => {
    calls.push({ argv, stdin: options.stdin });
    return handler(argv, options);
  };
  return { spawn, calls };
}

describe("ClaudeCliClassifier", () => {
  test("argv contains expected flags and model, stdin carries the prompt", async () => {
    const { spawn, calls } = makeSpawn(() => ({
      code: 0,
      stdout: envelope(JSON.stringify(good)),
      stderr: "",
    }));

    const classifier = new ClaudeCliClassifier({
      model: "claude-haiku-4-5-20251001",
      cwd: "/tempad-home",
      spawn,
    });

    await classifier.classify(window);

    expect(calls).toHaveLength(1);
    const call = calls[0] as { argv: string[]; stdin: string };
    expect(call.argv[0]).toBe("claude");
    expect(call.argv).toContain("-p");
    expect(call.argv).toContain("--safe-mode");
    expect(call.argv).toContain("--no-session-persistence");
    expect(call.argv).toContain("--output-format");
    expect(call.argv).toContain("json");
    expect(call.argv).toContain("--model");
    expect(call.argv).toContain("claude-haiku-4-5-20251001");
    expect(call.argv).toContain("--tools");
    expect(call.stdin.length).toBeGreaterThan(0);
    expect(call.stdin).toContain("fix bug");
  });

  test("respects custom command", async () => {
    const { spawn, calls } = makeSpawn(() => ({
      code: 0,
      stdout: envelope(JSON.stringify(good)),
      stderr: "",
    }));

    const classifier = new ClaudeCliClassifier({
      model: "m",
      cwd: "/tempad-home",
      command: "/usr/local/bin/claude",
      spawn,
    });

    await classifier.classify(window);
    expect(calls[0]?.argv[0]).toBe("/usr/local/bin/claude");
  });

  test("parses envelope result field", async () => {
    const { spawn } = makeSpawn(() => ({
      code: 0,
      stdout: envelope(JSON.stringify(good)),
      stderr: "",
    }));

    const classifier = new ClaudeCliClassifier({ model: "m", cwd: "/tempad-home", spawn });
    const result = await classifier.classify(window);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]?.what).toBe("fix bug");
  });

  test("tolerates fenced JSON in the result field", async () => {
    const { spawn } = makeSpawn(() => ({
      code: 0,
      stdout: envelope(`\`\`\`json\n${JSON.stringify(good)}\n\`\`\``),
      stderr: "",
    }));

    const classifier = new ClaudeCliClassifier({ model: "m", cwd: "/tempad-home", spawn });
    const result = await classifier.classify(window);
    expect(result.segments).toHaveLength(1);
  });

  test("retries once on invalid JSON then throws", async () => {
    let callCount = 0;
    const { spawn } = makeSpawn(() => {
      callCount += 1;
      return { code: 0, stdout: envelope("not json"), stderr: "" };
    });

    const classifier = new ClaudeCliClassifier({ model: "m", cwd: "/tempad-home", spawn });
    await expect(classifier.classify(window)).rejects.toThrow();
    expect(callCount).toBe(2);
  });

  test("non-zero exit throws with stderr excerpt", async () => {
    const { spawn } = makeSpawn(() => ({
      code: 1,
      stdout: "",
      stderr: "boom: something went wrong",
    }));

    const classifier = new ClaudeCliClassifier({ model: "m", cwd: "/tempad-home", spawn });
    await expect(classifier.classify(window)).rejects.toThrow(/boom: something went wrong/);
  });

  test("timeout throws", async () => {
    const spawn: CliSpawn = async () => {
      throw new Error("claude cli timed out after 1ms");
    };

    const classifier = new ClaudeCliClassifier({
      model: "m",
      cwd: "/tempad-home",
      spawn,
      timeoutMs: 1,
    });

    await expect(classifier.classify(window)).rejects.toThrow(/timed out/);
  });
});
