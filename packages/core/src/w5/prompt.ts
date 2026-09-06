import type { ClassifierWindow } from "./classifier";

export function buildSystemPrompt(): string {
  return [
    "You are w5, an assistant that helps a developer notice what they are working on.",
    "Nothing you produce is shared without the developer's review.",
    "",
    "Split the window of Claude Code messages into segments and classify each one.",
    "Respond with JSON matching exactly this schema:",
    "",
    '{"segments": [{',
    '  "startedAt": string (ISO timestamp within the window),',
    '  "endedAt": string (ISO timestamp within the window),',
    '  "what": string (short description of the work done),',
    '  "why": string (the goal it serves, or "unknown"),',
    '  "matchedQuest": string | null (id of an open quest this segment continues),',
    '  "proposedQuest": {"title": string, "objective": string, "commitment": "promised" | "personal" | "exploratory"} | null,',
    '  "matchedActivity": string | null (id of an open activity listed below this continues),',
    '  "continuesActivity": string | null (id of a closed activity listed below this resumes),',
    '  "newActivityReason": string | null (one sentence saying why no listed activity fits),',
    '  "isSwitch": boolean (true when the objective changed versus the previous segment),',
    '  "trigger": string | null (text from the transcript that caused the switch),',
    '  "confidence": number (0 to 1),',
    '  "questions": array of "which_quest" | "why" | "trigger" (only what the window cannot answer)',
    '}], "sessionNote": string | null (at most 300 characters on where the session is heading)}',
    "",
    "Reusing an activity is the default: prefer matchedActivity, then continuesActivity.",
    "Opening a new activity needs a reason: newActivityReason says why no candidate fits.",
    "Set exactly one of matchedActivity, continuesActivity, newActivityReason per segment; never zero, never two.",
    "An activity is one contiguous stretch of attention on one objective; that objective resumed after a gap is continuesActivity, not a new activity.",
    "The context-only section is not classified: never emit a segment covering it.",
    "trigger must be a quote or close paraphrase, not an inference.",
    "questions must list only fields the window does not answer.",
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
  lines.push("your open activities this session (prefer matchedActivity on one of these):");
  if (window.sessionOpenActivities.length === 0) {
    lines.push("  (none)");
  } else {
    for (const activity of window.sessionOpenActivities) {
      lines.push(
        `  - ${activity.activityId}: ${activity.what} — why ${activity.why} (quest ${activity.questTitle ?? "none"}, opened ${activity.openedAt}, last trace ended ${activity.lastTraceEndedAt})`,
      );
    }
  }
  lines.push("");
  lines.push("recent activities in this project (use continuesActivity to resume one):");
  if (window.recentActivities.length === 0) {
    lines.push("  (none)");
  } else {
    for (const activity of window.recentActivities) {
      const closed =
        activity.closedAt === null
          ? "still open"
          : `closed ${activity.closedAt} (${activity.closeReason ?? "unknown"})`;
      lines.push(
        `  - ${activity.activityId}: ${activity.what} — why ${activity.why} (quest ${activity.questTitle ?? "none"}, opened ${activity.openedAt}, ${closed})`,
      );
    }
  }
  lines.push("");
  lines.push("recent side quests:");
  if (window.recentSideQuests.length === 0) {
    lines.push("  (none)");
  } else {
    for (const quest of window.recentSideQuests) {
      lines.push(`  - ${quest.id}: ${quest.title} — triggered by "${quest.trigger}"`);
    }
  }
  lines.push("");
  lines.push("context only — do not classify these messages:");
  if (window.overlapMessages.length === 0) {
    lines.push("  (none)");
  } else {
    for (const message of window.overlapMessages) {
      lines.push(`  [${message.ts}] ${message.role}: ${message.text}`);
    }
  }
  if (window.previousSessionNote !== null) {
    lines.push("");
    lines.push(`your note from the previous run: ${window.previousSessionNote}`);
  }
  lines.push("");
  lines.push("messages:");
  for (const message of window.messages) {
    lines.push(`  [${message.ts}] ${message.role}: ${message.text}`);
  }
  return lines.join("\n");
}
