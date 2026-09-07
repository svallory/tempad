import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultIntentConfig, loadIntentConfig } from "../../src/intent/config";

describe("intent config", () => {
  test("parses hero, parties, clients and w5 with defaults", () => {
    const directory = mkdtempSync(join(tmpdir(), "tempad-intent-"));
    const path = join(directory, "tempad.toml");
    writeFileSync(
      path,
      `
[hero]
name = "Saulo"
[[parties]]
slug = "mosaic"
name = "Mosaic"
joined = "2025-07-01"
[[clients]]
slug = "liuna"
name = "LiUNA"
[w5]
throttle_minutes = 5
`,
    );
    const config = loadIntentConfig(path);
    expect(config.hero?.name).toBe("Saulo");
    expect(config.parties[0]?.slug).toBe("mosaic");
    expect(config.clients[0]?.name).toBe("LiUNA");
    expect(config.w5.throttleMinutes).toBe(5);
    expect(config.w5.watchTurns).toBe(3);
    expect(config.w5.backfillDays).toBe(15);
    expect(config.w5.backend).toBe("claude-cli");
    expect(config.w5.claudeCommand).toBe("claude");
    expect(config.w5.timeoutSeconds).toBe(180);
    expect(config.w5.stintIdleMinutes).toBe(45);
    expect(config.w5.memoryHours).toBe(8);
    expect(config.w5.memoryStints).toBe(10);
    expect(config.w5.overlapMessages).toBe(3);
  });

  test("accepts the pre-rename [w5] key names and warns naming the new key", () => {
    const directory = mkdtempSync(join(tmpdir(), "tempad-intent-"));
    const path = join(directory, "tempad.toml");
    // Exactly the shape of an operator's config written before 2026-09-07.
    writeFileSync(
      path,
      `
[w5]
ask_min_activity_minutes = 20
activity_idle_minutes = 30
memory_activities = 5
`,
    );
    const warnings: string[] = [];
    const config = loadIntentConfig(path, (message) => warnings.push(message));

    expect(config.w5.askMinStintMinutes).toBe(20);
    expect(config.w5.stintIdleMinutes).toBe(30);
    expect(config.w5.memoryStints).toBe(5);

    expect(warnings).toHaveLength(3);
    expect(warnings.join("\n")).toContain("ask_min_stint_minutes");
    expect(warnings.join("\n")).toContain("stint_idle_minutes");
    expect(warnings.join("\n")).toContain("memory_stints");
  });

  test("the current [w5] key wins when both names are present, with one warning", () => {
    const directory = mkdtempSync(join(tmpdir(), "tempad-intent-"));
    const path = join(directory, "tempad.toml");
    writeFileSync(
      path,
      `
[w5]
activity_idle_minutes = 30
stint_idle_minutes = 45
`,
    );
    const warnings: string[] = [];
    const config = loadIntentConfig(path, (message) => warnings.push(message));

    expect(config.w5.stintIdleMinutes).toBe(45);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("stint_idle_minutes");
  });

  test("a config using only current key names warns about nothing", () => {
    const directory = mkdtempSync(join(tmpdir(), "tempad-intent-"));
    const path = join(directory, "tempad.toml");
    writeFileSync(path, "\n[w5]\nstint_idle_minutes = 30\n");
    const warnings: string[] = [];
    const config = loadIntentConfig(path, (message) => warnings.push(message));

    expect(config.w5.stintIdleMinutes).toBe(30);
    expect(warnings).toEqual([]);
  });

  test("parses stint_idle_minutes, memory_hours, memory_stints, overlap_messages", () => {
    const directory = mkdtempSync(join(tmpdir(), "tempad-intent-"));
    const path = join(directory, "tempad.toml");
    writeFileSync(
      path,
      `
[w5]
stint_idle_minutes = 30
memory_hours = 4
memory_stints = 5
overlap_messages = 2
`,
    );
    const config = loadIntentConfig(path);
    expect(config.w5.stintIdleMinutes).toBe(30);
    expect(config.w5.memoryHours).toBe(4);
    expect(config.w5.memoryStints).toBe(5);
    expect(config.w5.overlapMessages).toBe(2);
  });

  test("defaultIntentConfig().w5 has the stint lifecycle defaults", () => {
    const config = defaultIntentConfig();
    expect(config.w5.stintIdleMinutes).toBe(45);
    expect(config.w5.memoryHours).toBe(8);
    expect(config.w5.memoryStints).toBe(10);
    expect(config.w5.overlapMessages).toBe(3);
  });

  test("parses w5 timeout_seconds", () => {
    const directory = mkdtempSync(join(tmpdir(), "tempad-intent-"));
    const path = join(directory, "tempad.toml");
    writeFileSync(path, `[w5]\ntimeout_seconds = 60\n`);
    const config = loadIntentConfig(path);
    expect(config.w5.timeoutSeconds).toBe(60);
  });

  test("parses w5 backend and claude_command", () => {
    const directory = mkdtempSync(join(tmpdir(), "tempad-intent-"));
    const path = join(directory, "tempad.toml");
    writeFileSync(
      path,
      `
[w5]
backend = "api"
claude_command = "/opt/bin/claude"
`,
    );
    const config = loadIntentConfig(path);
    expect(config.w5.backend).toBe("api");
    expect(config.w5.claudeCommand).toBe("/opt/bin/claude");
  });

  test("falls back to default backend on unknown value", () => {
    const directory = mkdtempSync(join(tmpdir(), "tempad-intent-"));
    const path = join(directory, "tempad.toml");
    writeFileSync(path, `[w5]\nbackend = "bogus"\n`);
    const config = loadIntentConfig(path);
    expect(config.w5.backend).toBe("claude-cli");
  });

  test("defaultIntentConfig reflects claude-cli defaults", () => {
    const config = defaultIntentConfig();
    expect(config.w5.backend).toBe("claude-cli");
    expect(config.w5.claudeCommand).toBe("claude");
  });

  test("rejects a party without slug", () => {
    const directory = mkdtempSync(join(tmpdir(), "tempad-intent-"));
    const path = join(directory, "tempad.toml");
    writeFileSync(path, `[[parties]]\nname = "x"\n`);
    expect(() => loadIntentConfig(path)).toThrow(/slug/);
  });

  test("a missing tempad.toml returns defaultIntentConfig instead of crashing (first-run hero init)", () => {
    const directory = mkdtempSync(join(tmpdir(), "tempad-intent-"));
    const path = join(directory, "tempad.toml");
    // deliberately do not create the file
    const config = loadIntentConfig(path);
    expect(config).toEqual(defaultIntentConfig());
  });

  test("parses w5 mode and inference_fallback", () => {
    const directory = mkdtempSync(join(tmpdir(), "tempad-intent-"));
    const path = join(directory, "tempad.toml");
    writeFileSync(
      path,
      `
[w5]
mode = "inferred"
inference_fallback = false
`,
    );
    const config = loadIntentConfig(path);
    expect(config.w5.mode).toBe("inferred");
    expect(config.w5.inferenceFallback).toBe(false);
  });

  test("defaultIntentConfig().w5 defaults to declared mode with inference fallback on", () => {
    const config = defaultIntentConfig();
    expect(config.w5.mode).toBe("declared");
    expect(config.w5.inferenceFallback).toBe(true);
  });
});
