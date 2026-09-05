import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAdditionalContext,
  installHooks,
  promptHookScriptPath,
  renderHookSettings,
  stopHookScriptPath,
  uninstallHooks,
} from "../../src/w5/hooks";
import type { QuestionRow } from "../../src/w5/questions";

describe("renderHookSettings", () => {
  test("computes hook paths from the package location, not the bun binary, and writes absolute paths that exist on disk", () => {
    const fragment = renderHookSettings();
    const stopCommand = fragment.Stop[0]?.hooks[0]?.command ?? "";
    const promptCommand = fragment.UserPromptSubmit[0]?.hooks[0]?.command ?? "";

    const stopScript = stopHookScriptPath();
    const promptScript = promptHookScriptPath();

    expect(existsSync(stopScript)).toBe(true);
    expect(existsSync(promptScript)).toBe(true);
    expect(stopScript.startsWith("/")).toBe(true);
    expect(promptScript.startsWith("/")).toBe(true);

    expect(stopCommand).toContain(stopScript);
    expect(promptCommand).toContain(promptScript);
    expect(stopCommand).toMatch(/^TEMPAD_BIN="bun \/.*\/src\/cli\.ts" bash \/.*w5-stop\.sh$/);
  });

  test("marks every entry with tempad: true", () => {
    const fragment = renderHookSettings();
    expect(fragment.Stop[0]?.hooks[0]?.tempad).toBe(true);
    expect(fragment.PreCompact[0]?.hooks[0]?.tempad).toBe(true);
    expect(fragment.SessionEnd[0]?.hooks[0]?.tempad).toBe(true);
    expect(fragment.UserPromptSubmit[0]?.hooks[0]?.tempad).toBe(true);
  });
});

describe("installHooks / uninstallHooks", () => {
  test("creates the settings directory if it doesn't exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-hooks-test-"));
    const nestedSettingsPath = join(dir, "nested", "does", "not", "exist", "settings.json");
    try {
      expect(existsSync(join(dir, "nested"))).toBe(false);
      installHooks(nestedSettingsPath);
      expect(existsSync(nestedSettingsPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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

      installHooks(settingsPath);
      const afterFirst = JSON.parse(readFileSync(settingsPath, "utf8"));
      const stopCommands = afterFirst.hooks.Stop.flatMap(
        (entry: { hooks: { command: string }[] }) => entry.hooks.map((hook) => hook.command),
      );
      expect(stopCommands).toContain("other-tool");
      expect(stopCommands.some((command: string) => command.includes("w5-stop.sh"))).toBe(true);

      installHooks(settingsPath);
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

  test("--bin override is reflected in the written command", () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-hooks-test-"));
    const settingsPath = join(dir, "settings.json");
    try {
      installHooks(settingsPath, "/custom/path/cli.ts");
      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      const stopCommand = settings.hooks.Stop[0].hooks[0].command as string;
      expect(stopCommand).toContain("bun /custom/path/cli.ts");
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
      const { chmodSync } = await import("node:fs");
      chmodSync(fakeTempad, 0o755);

      const scriptPath = join(import.meta.dir, "../../hooks/w5-stop.sh");

      const runHook = async (hookEventName: string) => {
        const proc = Bun.spawn({
          cmd: ["bash", scriptPath],
          env: { ...process.env, TEMPAD_BIN: fakeTempad, TEMPAD_HOME: dir },
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

  test("logs loudly and exits 0 when TEMPAD_BIN is unset", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-hookscript-test-"));
    try {
      const scriptPath = join(import.meta.dir, "../../hooks/w5-stop.sh");
      const env = { ...process.env, TEMPAD_HOME: dir };
      delete (env as Record<string, string | undefined>).TEMPAD_BIN;

      const proc = Bun.spawn({
        cmd: ["bash", scriptPath],
        env,
        stdin: new Response(JSON.stringify({ session_id: "s1", hook_event_name: "Stop" })),
        stdout: "ignore",
        stderr: "ignore",
      });
      const exitCode = await proc.exited;

      expect(exitCode).toBe(0);
      const logContent = readFileSync(join(dir, "logs", "w5.log"), "utf8");
      expect(logContent).toContain("TEMPAD_BIN not set");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
