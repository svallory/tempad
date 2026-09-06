import { classifyWithRetry } from "./classifier-shared";
import { buildSystemPrompt, buildUserPrompt } from "./prompt";

export interface ClassifierWindow {
  sessionId: string;
  title: string | null;
  cwd: string | null;
  gitBranch: string | null;
  org: string;
  project: string;
  messages: { ts: string; role: string; text: string }[];
  openQuests: {
    id: string;
    title: string;
    objective: string | null;
    lastActivityAt: string | null;
  }[];
  sessionOpenActivities: {
    activityId: string;
    what: string;
    why: string;
    questId: string | null;
    questTitle: string | null;
    openedAt: string;
    lastTraceEndedAt: string;
  }[];
  recentActivities: {
    activityId: string;
    what: string;
    why: string;
    questId: string | null;
    questTitle: string | null;
    openedAt: string;
    lastTraceEndedAt: string;
    closedAt: string | null;
    closeReason: string | null;
  }[];
  recentSideQuests: { id: string; title: string; trigger: string }[];
  overlapMessages: { ts: string; role: string; text: string }[];
  previousSessionNote: string | null;
}

export type QuestionKind = "which_quest" | "why" | "trigger";
export type Commitment = "promised" | "personal" | "exploratory";

export interface ClassifierSegment {
  startedAt: string;
  endedAt: string;
  what: string;
  why: string;
  matchedQuest: string | null;
  proposedQuest: { title: string; objective: string; commitment: Commitment } | null;
  matchedActivity: string | null;
  continuesActivity: string | null;
  newActivityReason: string | null;
  isSwitch: boolean;
  trigger: string | null;
  confidence: number;
  questions: QuestionKind[];
}

export interface ClassifierResult {
  segments: ClassifierSegment[];
  sessionNote: string | null;
}

export const MAX_SESSION_NOTE_LENGTH = 300;

const QUESTION_KINDS = new Set<QuestionKind>(["which_quest", "why", "trigger"]);
const COMMITMENTS = new Set<Commitment>(["promised", "personal", "exploratory"]);

function requireString(value: unknown, path: string, problems: string[]): value is string {
  if (typeof value !== "string") {
    problems.push(`${path}: expected string, got ${typeof value}`);
    return false;
  }
  return true;
}

function validateSegment(
  raw: unknown,
  index: number,
  problems: string[],
  bounds: { firstTs: string; lastTs: string } | null,
): void {
  const where = `segments[${index}]`;
  if (typeof raw !== "object" || raw === null) {
    problems.push(`${where}: expected an object`);
    return;
  }
  const segment = raw as Record<string, unknown>;

  const startedAtIsString = requireString(segment.startedAt, `${where}.startedAt`, problems);
  const endedAtIsString = requireString(segment.endedAt, `${where}.endedAt`, problems);
  requireString(segment.what, `${where}.what`, problems);
  requireString(segment.why, `${where}.why`, problems);

  if (bounds !== null) {
    if (startedAtIsString) {
      const startedAt = segment.startedAt as string;
      if (startedAt < bounds.firstTs || startedAt > bounds.lastTs) {
        problems.push(
          `${where}.startedAt: ${startedAt} is outside the window [${bounds.firstTs}, ${bounds.lastTs}]`,
        );
      }
    }
    if (endedAtIsString) {
      const endedAt = segment.endedAt as string;
      if (endedAt < bounds.firstTs || endedAt > bounds.lastTs) {
        problems.push(
          `${where}.endedAt: ${endedAt} is outside the window [${bounds.firstTs}, ${bounds.lastTs}]`,
        );
      }
    }
  }

  if (segment.matchedQuest !== null && typeof segment.matchedQuest !== "string") {
    problems.push(`${where}.matchedQuest: expected string or null`);
  }
  if (segment.matchedActivity !== null && typeof segment.matchedActivity !== "string") {
    problems.push(`${where}.matchedActivity: expected string or null`);
  }
  if (segment.continuesActivity !== null && typeof segment.continuesActivity !== "string") {
    problems.push(`${where}.continuesActivity: expected string or null`);
  }
  if (segment.newActivityReason !== null && typeof segment.newActivityReason !== "string") {
    problems.push(`${where}.newActivityReason: expected string or null`);
  }

  const candidates = [
    segment.matchedActivity,
    segment.continuesActivity,
    segment.newActivityReason,
  ].filter((candidate) => candidate !== null && candidate !== undefined);
  if (candidates.length !== 1) {
    problems.push(
      `${where}: set exactly one of matchedActivity, continuesActivity, newActivityReason (got ${candidates.length})`,
    );
  }
  if (segment.trigger !== null && typeof segment.trigger !== "string") {
    problems.push(`${where}.trigger: expected string or null`);
  }
  if (typeof segment.isSwitch !== "boolean") {
    problems.push(`${where}.isSwitch: expected boolean`);
  }

  if (segment.proposedQuest !== null) {
    if (typeof segment.proposedQuest !== "object") {
      problems.push(`${where}.proposedQuest: expected object or null`);
    } else {
      const proposed = segment.proposedQuest as Record<string, unknown>;
      requireString(proposed.title, `${where}.proposedQuest.title`, problems);
      requireString(proposed.objective, `${where}.proposedQuest.objective`, problems);
      if (!COMMITMENTS.has(proposed.commitment as Commitment)) {
        problems.push(`${where}.proposedQuest.commitment: expected promised|personal|exploratory`);
      }
    }
  }

  if (typeof segment.confidence !== "number" || segment.confidence < 0 || segment.confidence > 1) {
    problems.push(`${where}.confidence: expected number between 0 and 1`);
  }

  if (!Array.isArray(segment.questions)) {
    problems.push(`${where}.questions: expected array`);
  } else {
    for (const [questionIndex, question] of segment.questions.entries()) {
      if (!QUESTION_KINDS.has(question as QuestionKind)) {
        problems.push(
          `${where}.questions[${questionIndex}]: unknown question kind ${String(question)}`,
        );
      }
    }
  }
}

export function validateResult(raw: unknown, window?: ClassifierWindow): ClassifierResult {
  const problems: string[] = [];
  if (
    typeof raw !== "object" ||
    raw === null ||
    !Array.isArray((raw as { segments?: unknown }).segments)
  ) {
    throw new Error("classifier result: expected { segments: [...] }");
  }

  const bounds =
    window !== undefined && window.messages.length > 0
      ? {
          firstTs: window.messages[0]?.ts as string,
          lastTs: window.messages.at(-1)?.ts as string,
        }
      : null;

  const segments = (raw as { segments: unknown[] }).segments;
  for (const [index, segment] of segments.entries()) {
    validateSegment(segment, index, problems, bounds);
  }

  const sessionNote = (raw as { sessionNote?: unknown }).sessionNote;
  if (
    sessionNote !== undefined &&
    sessionNote !== null &&
    (typeof sessionNote !== "string" || sessionNote.length > MAX_SESSION_NOTE_LENGTH)
  ) {
    problems.push(
      `sessionNote: expected null or a string of at most ${MAX_SESSION_NOTE_LENGTH} characters`,
    );
  }
  if (problems.length > 0) {
    throw new Error(`classifier result invalid:\n${problems.join("\n")}`);
  }
  const result = raw as { segments: ClassifierSegment[]; sessionNote?: string | null };
  return { segments: result.segments, sessionNote: result.sessionNote ?? null };
}

export interface Classifier {
  classify(window: ClassifierWindow): Promise<ClassifierResult>;
}

export interface AnthropicClassifierOptions {
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 180_000;

export class AnthropicClassifier implements Classifier {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: AnthropicClassifierOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async classify(window: ClassifierWindow): Promise<ClassifierResult> {
    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt(window);
    return classifyWithRetry(window, userPrompt, (prompt) => this.request(systemPrompt, prompt));
  }

  private async request(systemPrompt: string, userPrompt: string): Promise<string> {
    const response = await this.fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const bodyText = await response.text();
      throw new Error(
        `anthropic request failed: status ${response.status} ${bodyText.slice(0, 200)}`,
      );
    }

    const body = (await response.json()) as { content: { type: string; text?: string }[] };
    const textBlock = body.content.find(
      (block) => block.type === "text" && typeof block.text === "string",
    );
    if (!textBlock?.text) throw new Error("anthropic response contained no text block");
    return textBlock.text;
  }
}
