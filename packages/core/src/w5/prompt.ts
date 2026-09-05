import type { ClassifierWindow } from "./classifier";

export function buildSystemPrompt(): string {
  return [
    "You are w5, a self-awareness assistant that helps a developer notice what they are actually working on.",
    "This is not surveillance: nothing you produce is shared without the developer's review, and your job is to help them see their own patterns of work, not to police them.",
    "",
    "Given a window of recent Claude Code session messages, split it into segments and classify each one.",
    "Respond with JSON matching exactly this schema:",
    "",
    '{"segments": [{',
    '  "startedAt": string (ISO timestamp within the window),',
    '  "endedAt": string (ISO timestamp within the window),',
    '  "what": string (short description of the work done),',
    '  "why": string (the goal it serves, or "unknown"),',
    '  "matchedQuest": string | null (id of an open quest this segment continues),',
    '  "proposedQuest": {"title": string, "objective": string, "commitment": "promised" | "personal" | "exploratory"} | null,',
    '  "matchedActivity": string | null (id of an existing activity this segment continues),',
    '  "isSwitch": boolean (true when the objective changed versus the previous trace),',
    '  "trigger": string | null (quoted or closely paraphrased text from the transcript that caused the switch),',
    '  "confidence": number (0 to 1),',
    '  "questions": array of "which_quest" | "why" | "trigger" (only what cannot be told from the window)',
    "}]}",
    "",
    "isSwitch means the objective changed compared to the previous trace provided in the window.",
    "trigger must be a quote or a close paraphrase from the transcript, not an inference.",
    "questions must list only the fields you could not determine from the window; do not ask about things the window already answers.",
  ].join("\n");
}

export function buildUserPrompt(window: ClassifierWindow): string {
  const lines: string[] = [];
  lines.push(`session: ${window.sessionId}`);
  lines.push(`title: ${window.title ?? "unknown"}`);
  lines.push(`cwd: ${window.cwd ?? "unknown"}`);
  lines.push(`git branch: ${window.gitBranch ?? "unknown"}`);
  lines.push(`org/project: ${window.org}/${window.project}`);
  lines.push("");
  lines.push("open quests:");
  if (window.openQuests.length === 0) {
    lines.push("  (none)");
  } else {
    for (const quest of window.openQuests) {
      lines.push(
        `  - ${quest.id}: ${quest.title} — ${quest.objective ?? "no objective"} (last activity ${quest.lastActivityAt ?? "unknown"})`,
      );
    }
  }
  lines.push("");
  lines.push("previous trace:");
  lines.push(
    window.previousTrace
      ? `  activity ${window.previousTrace.activityId}: ${window.previousTrace.what} (quest ${window.previousTrace.questId ?? "none"})`
      : "  (none)",
  );
  lines.push("");
  lines.push("messages:");
  for (const message of window.messages) {
    lines.push(`  [${message.ts}] ${message.role}: ${message.text}`);
  }
  return lines.join("\n");
}
