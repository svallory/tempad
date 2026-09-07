import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { QUEST_DECLARE_OPTIONS } from "../../src/intent/cli";

const SKILL_PATH = join(import.meta.dir, "../../skills/tempad-quest/SKILL.md");

function extractDeclareInvocations(markdown: string): string[] {
  const fences = [...markdown.matchAll(/```\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
  const invocations: string[] = [];
  for (const fence of fences) {
    const joined = fence.replace(/\\\n\s*/g, " ");
    for (const line of joined.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("tempad quest declare")) invocations.push(trimmed);
    }
  }
  return invocations;
}

function tokenize(command: string): string[] {
  // Replace unquoted <...> placeholders (which may contain spaces) with a
  // single dummy token before splitting, so a placeholder like
  // `<subagent session id>` counts as one argument, matching what an agent
  // filling in a real id would actually pass.
  const withDummies = command.replace(/<[^>]+>/g, "placeholder");
  const tokens: string[] = [];
  const regex = /"([^"]*)"|(\S+)/g;
  let match: RegExpExecArray | null = regex.exec(withDummies);
  while (match !== null) {
    tokens.push(match[1] ?? match[2] ?? "");
    match = regex.exec(withDummies);
  }
  return tokens;
}

describe("SKILL.md tempad quest declare invocations", () => {
  const markdown = readFileSync(SKILL_PATH, "utf8");
  const invocations = extractDeclareInvocations(markdown);

  test("the skill file contains at least one declare invocation to check", () => {
    expect(invocations.length).toBeGreaterThan(0);
  });

  for (const invocation of invocations) {
    test(`parses cleanly with the CLI's own parseArgs config: ${invocation}`, () => {
      const tokens = tokenize(invocation);
      // tokens[0..2] are "tempad quest declare" -- parseArgs only sees the flags.
      const args = tokens.slice(3);
      expect(() => parseArgs({ args, options: QUEST_DECLARE_OPTIONS, strict: true })).not.toThrow();
    });
  }
});
