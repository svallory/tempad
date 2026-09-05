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
  previousTrace: { activityId: string; what: string; questId: string | null } | null;
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
  isSwitch: boolean;
  trigger: string | null;
  confidence: number;
  questions: QuestionKind[];
}

export interface ClassifierResult {
  segments: ClassifierSegment[];
}

const QUESTION_KINDS = new Set<QuestionKind>(["which_quest", "why", "trigger"]);
const COMMITMENTS = new Set<Commitment>(["promised", "personal", "exploratory"]);

function requireString(value: unknown, path: string, problems: string[]): value is string {
  if (typeof value !== "string") {
    problems.push(`${path}: expected string, got ${typeof value}`);
    return false;
  }
  return true;
}

function validateSegment(raw: unknown, index: number, problems: string[]): void {
  const where = `segments[${index}]`;
  if (typeof raw !== "object" || raw === null) {
    problems.push(`${where}: expected an object`);
    return;
  }
  const segment = raw as Record<string, unknown>;

  requireString(segment.startedAt, `${where}.startedAt`, problems);
  requireString(segment.endedAt, `${where}.endedAt`, problems);
  requireString(segment.what, `${where}.what`, problems);
  requireString(segment.why, `${where}.why`, problems);

  if (segment.matchedQuest !== null && typeof segment.matchedQuest !== "string") {
    problems.push(`${where}.matchedQuest: expected string or null`);
  }
  if (segment.matchedActivity !== null && typeof segment.matchedActivity !== "string") {
    problems.push(`${where}.matchedActivity: expected string or null`);
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

export function validateResult(raw: unknown): ClassifierResult {
  const problems: string[] = [];
  if (
    typeof raw !== "object" ||
    raw === null ||
    !Array.isArray((raw as { segments?: unknown }).segments)
  ) {
    throw new Error("classifier result: expected { segments: [...] }");
  }
  const segments = (raw as { segments: unknown[] }).segments;
  for (const [index, segment] of segments.entries()) validateSegment(segment, index, problems);
  if (problems.length > 0) {
    throw new Error(`classifier result invalid:\n${problems.join("\n")}`);
  }
  return raw as ClassifierResult;
}

export interface Classifier {
  classify(window: ClassifierWindow): Promise<ClassifierResult>;
}

function extractJsonText(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (fenced?.[1] ?? text).trim();
}

export interface AnthropicClassifierOptions {
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
}

export class AnthropicClassifier implements Classifier {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AnthropicClassifierOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async classify(window: ClassifierWindow): Promise<ClassifierResult> {
    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt(window);

    const first = await this.request(systemPrompt, userPrompt);
    try {
      return validateResult(JSON.parse(extractJsonText(first)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryPrompt = `${userPrompt}\n\nYour previous response was invalid: ${message}\nRespond with valid JSON only.`;
      const second = await this.request(systemPrompt, retryPrompt);
      return validateResult(JSON.parse(extractJsonText(second)));
    }
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
    });
    const body = (await response.json()) as { content: { type: string; text?: string }[] };
    const textBlock = body.content.find(
      (block) => block.type === "text" && typeof block.text === "string",
    );
    if (!textBlock?.text) throw new Error("anthropic response contained no text block");
    return textBlock.text;
  }
}
