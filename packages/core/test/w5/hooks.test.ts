import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAdditionalContext,
  installHooks,
  renderHookSettings,
  uninstallHooks,
} from "../../src/w5/hooks";
import type { QuestionRow } from "../../src/w5/questions";

describe("renderHookSettings", () => {
  test("marks every entry with tempad: true", () => {
    const fragment = renderHookSettings("/usr/local/bin/tempad");
    expect(fragment.Stop).toBeDefined();
    expect(fragment.PreCompact).toBeDefined();
    expect(fragment.SessionEnd).toBeDefined();
    expect(fragment.UserPromptSubmit).toBeDefined();
  });
});

describe("installHooks / uninstallHooks", () => {
  test("installs alongside an unrelated existing Stop hook, is idempotent, uninstall removes only tempad entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-hooks-test-"));
    const settingsPath = join(dir, "settings.json");
    try {
      writeFileSync(
        settingsPath,
        JSON.stringify({
          hooks: {
            Stop: [{ hooks: [{ type: "command", command: "other-tool" }] }],
          },
        }),
      );

      installHooks(settingsPath, "/usr/local/bin/tempad");
      const afterFirst = JSON.parse(readFileSync(settingsPath, "utf8"));
      const stopCommands = afterFirst.hooks.Stop.flatMap(
        (entry: { hooks: { command: string }[] }) => entry.hooks.map((hook) => hook.command),
      );
      expect(stopCommands).toContain("other-tool");
      expect(stopCommands.some((command: string) => command.includes("w5-stop.sh"))).toBe(true);

      installHooks(settingsPath, "/usr/local/bin/tempad");
      const afterSecond = JSON.parse(readFileSync(settingsPath, "utf8"));
      const stopCommandsSecond = afterSecond.hooks.Stop.flatMap(
        (entry: { hooks: { command: string }[] }) => entry.hooks.map((hook) => hook.command),
      );
      const tempadCount = stopCommandsSecond.filter((command: string) =>
        command.includes("w5-stop.sh"),
      ).length;
      expect(tempadCount).toBe(1);

      uninstallHooks(settingsPath);
      const afterUninstall = JSON.parse(readFileSync(settingsPath, "utf8"));
      const stopCommandsThird = afterUninstall.hooks.Stop.flatMap(
        (entry: { hooks: { command: string }[] }) => entry.hooks.map((hook) => hook.command),
      );
      expect(stopCommandsThird).toEqual(["other-tool"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildAdditionalContext", () => {
  test("renders the question id and the answer command", () => {
    const questions: QuestionRow[] = [
      {
        id: "Q1",
        traceId: "T1",
        sessionId: "s1",
        kind: "which_quest",
        state: "asked",
        turnsWatched: 3,
        turnsAtAsk: 3,
        isSwitch: true,
      },
    ];
    const text = buildAdditionalContext(questions);
    expect(text).toContain("Q1");
    expect(text).toContain("tempad answer Q1");
  });

  test("returns empty string for no questions", () => {
    expect(buildAdditionalContext([])).toBe("");
  });
});

describe("w5-stop.sh", () => {
  test("forwards session id and forces on non-Stop events", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-hookscript-test-"));
    try {
      const fakeTempad = join(dir, "tempad");
      const argvLog = join(dir, "argv.log");
      writeFileSync(fakeTempad, `#!/bin/sh\necho "$@" >> "${argvLog}"\n`);
      chmodSync(fakeTempad, 0o755);

      const scriptPath = join(import.meta.dir, "../../hooks/w5-stop.sh");

      const runHook = async (hookEventName: string) => {
        const proc = Bun.spawn({
          cmd: ["bash", scriptPath],
          env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TEMPAD_BIN: fakeTempad },
          stdin: new Response(JSON.stringify({ session_id: "s1", hook_event_name: hookEventName })),
          stdout: "ignore",
          stderr: "ignore",
        });
        await proc.exited;
      };

      await runHook("Stop");
      await runHook("PreCompact");

      const argv = readFileSync(argvLog, "utf8").trim().split("\n");
      expect(argv[0]).toBe("w5 enqueue --session s1");
      expect(argv[1]).toBe("w5 enqueue --session s1 --forced");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
