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
  /**
   * Which prompt and apply path this window is for. `"inferred"` is the
   * pre-verifier behavior, used by `[w5].mode = "inferred"` and by backfill's
   * per-session fallback for a session that never declares anything; it is what
   * decides which schema the model is asked to fill in, so it must travel with
   * the window rather than being guessed from which optional fields are set.
   */
  mode: "declared" | "inferred";
  /**
   * The quest this session declared (`tempad quest declare`), as of the window's
   * reference time. `null` means the session has not declared anything yet, which
   * the verifier reads as "ask to declare" rather than "infer one".
   */
  declaredQuest: DeclaredQuestSlice | null;
  /** Set only for a subagent session, from the parent's own declaration. */
  parentDeclaredQuest: DeclaredQuestSlice | null;
  /**
   * alias -> real activity id, e.g. `{ A1: "01H..." }`. The model only ever sees
   * the alias, so there is no 26-character id for it to garble, and `apply.ts`
   * maps whatever it returns back through this map.
   */
  activityAliases: Record<string, string>;
  /**
   * Inference-mode only (`[w5].mode = "inferred"`, or the backfill fallback for a
   * session that never declares anything). Absent in declared mode.
   */
  openQuests?: {
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
  /** Inference-mode only, like `openQuests`. */
  recentSideQuests?: { id: string; title: string; trigger: string }[];
  overlapMessages: { ts: string; role: string; text: string }[];
  previousSessionNote: string | null;
}

export interface DeclaredQuestSlice {
  title: string;
  objective: string | null;
  plan: string[];
}

export type QuestionKind = "belongs" | "declare";

/** Retained for the inference fallback; declared mode proposes no quests. */
export type Commitment = "promised" | "personal" | "exploratory";

/** The question kinds the pre-verifier classifier was allowed to raise. */
export type LegacyQuestionKind = "which_quest" | "why" | "trigger";

export interface ClassifierSegment {
  startedAt: string;
  endedAt: string;
  what: string;
  why: string;
  /**
   * Does this segment belong to the declared quest (the parent's, for a
   * subagent)? Declared mode requires it -- `validateSegment` rejects a segment
   * without it -- and inference mode is never asked for it, hence optional here.
   */
  belongs?: boolean;
  /**
   * Short string naming what it looks like instead; required when `belongs` is
   * false, forced to null when it is true. Declared mode only.
   */
  guess?: string | null;
  /** Alias (`"A1"`), never a real id, in declared mode. */
  matchedActivity: string | null;
  /** Alias (`"A1"`), never a real id, in declared mode. */
  continuesActivity: string | null;
  newActivityReason: string | null;
  isSwitch: boolean;
  trigger: string | null;
  confidence: number;
  /**
   * Inference-mode only. The verifier makes no quest decision, so these are
   * absent in declared mode and only read on the fallback path.
   */
  matchedQuest?: string | null;
  proposedQuest?: { title: string; objective: string; commitment: Commitment } | null;
  questions?: LegacyQuestionKind[];
}

export interface ClassifierResult {
  segments: ClassifierSegment[];
  sessionNote: string | null;
  /**
   * Segments that named none of the three activity selectors and were given a
   * default `newActivityReason` instead of being rejected. Optional because a
   * result built by hand (tests, a stub classifier) repaired nothing; only
   * `validateResult` ever sets it.
   */
  selectorDefaulted?: number;
  /**
   * Segments that named more than one selector and were narrowed to the first by
   * precedence (matchedActivity > continuesActivity > newActivityReason).
   */
  selectorAmbiguous?: number;
}

export const MAX_SESSION_NOTE_LENGTH = 300;

/** Stands in for a `newActivityReason` the classifier omitted entirely. */
export const DEFAULT_NEW_ACTIVITY_REASON = "classifier gave no reason";

/**
 * Optional fields a model routinely omits rather than sending as `null`. JSON has
 * no way to distinguish "absent" from "null" here and the two mean the same thing
 * to us, so absent is normalized to `null` before anything is validated -- a
 * missing key used to be reported as "expected string or null" and fail the whole
 * window.
 */
const NULLABLE_SEGMENT_FIELDS = [
  "guess",
  "matchedQuest",
  "proposedQuest",
  "matchedActivity",
  "continuesActivity",
  "newActivityReason",
  "trigger",
] as const;

export const QUESTION_KINDS = new Set<QuestionKind>(["belongs", "declare"]);
const LEGACY_QUESTION_KINDS = new Set<LegacyQuestionKind>(["which_quest", "why", "trigger"]);
const COMMITMENTS = new Set<Commitment>(["promised", "personal", "exploratory"]);

function requireString(value: unknown, path: string, problems: string[]): value is string {
  if (typeof value !== "string") {
    problems.push(`${path}: expected string, got ${typeof value}`);
    return false;
  }
  return true;
}

interface SelectorCounters {
  selectorDefaulted: number;
  selectorAmbiguous: number;
}

function validateSegment(
  raw: unknown,
  index: number,
  problems: string[],
  bounds: { firstTs: string; lastTs: string } | null,
  counters: SelectorCounters,
  aliases: Set<string> | null,
  mode: "declared" | "inferred",
): void {
  const where = `segments[${index}]`;
  if (typeof raw !== "object" || raw === null) {
    problems.push(`${where}: expected an object`);
    return;
  }
  const segment = raw as Record<string, unknown>;

  for (const field of NULLABLE_SEGMENT_FIELDS) {
    if (segment[field] === undefined) segment[field] = null;
  }

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

  // `belongs`/`guess` are the verifier's fields; an inference-mode window is never
  // asked for them, so requiring them there would reject every window that path
  // produces.
  if (mode === "inferred") {
    if (segment.belongs !== undefined && typeof segment.belongs !== "boolean") {
      problems.push(`${where}.belongs: expected boolean`);
    }
  } else if (typeof segment.belongs !== "boolean") {
    problems.push(`${where}.belongs: expected boolean`);
  } else if (segment.belongs === false) {
    // A doubt with nothing to say is useless to the human answering it, so this
    // is the one new hard requirement rather than a repair.
    if (typeof segment.guess !== "string" || segment.guess.trim() === "") {
      problems.push(`${where}.guess: expected a non-empty string when belongs is false`);
    }
  } else if (segment.guess !== null) {
    // Repair, don't reject: a segment that belongs has no need to guess what else
    // it might be, and a model that fills it in anyway is just noisy.
    segment.guess = null;
  }

  if (
    segment.matchedQuest !== undefined &&
    segment.matchedQuest !== null &&
    typeof segment.matchedQuest !== "string"
  ) {
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

  // An alias the window never offered resolves to nothing, exactly as a
  // fabricated ULID did before the alias scheme: it is dropped here so the
  // existing selector repair below re-defaults the segment, rather than adding a
  // third counter for the same failure.
  if (aliases !== null) {
    if (typeof segment.matchedActivity === "string" && !aliases.has(segment.matchedActivity)) {
      segment.matchedActivity = null;
    }
    if (typeof segment.continuesActivity === "string" && !aliases.has(segment.continuesActivity)) {
      segment.continuesActivity = null;
    }
  }

  // The prompt still asks for exactly one selector, but a model that sets none or
  // several is repaired rather than rejected: failing the window loses a real
  // stretch of work over a formatting slip, and both repairs are counted so the
  // run summary shows how often the model is missing the rule.
  const selectors = [
    segment.matchedActivity,
    segment.continuesActivity,
    segment.newActivityReason,
  ].filter((candidate) => candidate !== null);
  if (selectors.length === 0) {
    segment.newActivityReason = DEFAULT_NEW_ACTIVITY_REASON;
    counters.selectorDefaulted += 1;
  } else if (selectors.length > 1) {
    if (segment.matchedActivity !== null) {
      segment.continuesActivity = null;
      segment.newActivityReason = null;
    } else {
      segment.newActivityReason = null;
    }
    counters.selectorAmbiguous += 1;
  }
  if (segment.trigger !== null && typeof segment.trigger !== "string") {
    problems.push(`${where}.trigger: expected string or null`);
  }
  if (typeof segment.isSwitch !== "boolean") {
    problems.push(`${where}.isSwitch: expected boolean`);
  }

  if (segment.proposedQuest !== undefined && segment.proposedQuest !== null) {
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

  // Inference-mode only: the verifier raises no per-segment questions.
  if (segment.questions !== undefined) {
    if (!Array.isArray(segment.questions)) {
      problems.push(`${where}.questions: expected array`);
    } else {
      for (const [questionIndex, question] of segment.questions.entries()) {
        if (!LEGACY_QUESTION_KINDS.has(question as LegacyQuestionKind)) {
          problems.push(
            `${where}.questions[${questionIndex}]: unknown question kind ${String(question)}`,
          );
        }
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

  const mode = window?.mode ?? "declared";
  // Inference mode carries real ids in its slice, not aliases, so there is no
  // closed set to validate a selector against.
  const aliases =
    mode === "declared" && window !== undefined && window.activityAliases !== undefined
      ? new Set(Object.keys(window.activityAliases))
      : null;

  const counters: SelectorCounters = { selectorDefaulted: 0, selectorAmbiguous: 0 };
  const segments = (raw as { segments: unknown[] }).segments;
  for (const [index, segment] of segments.entries()) {
    validateSegment(segment, index, problems, bounds, counters, aliases, mode);
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
  return {
    segments: result.segments,
    sessionNote: result.sessionNote ?? null,
    selectorDefaulted: counters.selectorDefaulted,
    selectorAmbiguous: counters.selectorAmbiguous,
  };
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
    // The window's mode decides which schema the model is asked to fill in.
    const systemPrompt = buildSystemPrompt(window.mode);
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
