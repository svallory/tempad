import { describe, expect, test } from "bun:test";
import {
  AnthropicClassifier,
  type ClassifierWindow,
  validateResult,
} from "../../src/w5/classifier";
import { buildUserPrompt } from "../../src/w5/prompt";

const window: ClassifierWindow = {
  sessionId: "s",
  title: "marko-ui",
  cwd: "/w/marko-ui",
  gitBranch: "main",
  org: "personal",
  project: "marko-ui",
  messages: [
    { ts: "2026-09-04T15:00:00.000Z", role: "user", text: "fix the walk order bug" },
    {
      ts: "2026-09-04T15:20:00.000Z",
      role: "user",
      text: "wait, what does Astryx do for agents? compare it with ours",
    },
  ],
  openQuests: [
    {
      id: "Q1",
      title: "Ship marko-ui",
      objective: "86 components",
      lastActivityAt: "2026-09-04T14:00:00.000Z",
    },
  ],
  previousTrace: { activityId: "A1", what: "fixing walk order", questId: "Q1" },
};

const good = {
  segments: [
    {
      startedAt: "2026-09-04T15:00:00.000Z",
      endedAt: "2026-09-04T15:20:00.000Z",
      what: "fix walk order",
      why: "ship marko-ui",
      matchedQuest: "Q1",
      proposedQuest: null,
      matchedActivity: "A1",
      isSwitch: false,
      trigger: null,
      confidence: 0.9,
      questions: [],
    },
    {
      startedAt: "2026-09-04T15:20:00.000Z",
      endedAt: "2026-09-04T15:20:00.000Z",
      what: "compare Astryx",
      why: "unknown",
      matchedQuest: null,
      proposedQuest: {
        title: "Compare Astryx",
        objective: "see what they claim",
        commitment: "exploratory",
      },
      matchedActivity: null,
      isSwitch: true,
      trigger: "what does Astryx do for agents?",
      confidence: 0.6,
      questions: ["which_quest"],
    },
  ],
};

describe("classifier", () => {
  test("validateResult accepts a good result and rejects a bad one listing problems", () => {
    expect(validateResult(good).segments.length).toBe(2);
    expect(() =>
      validateResult({
        segments: [{ ...good.segments[0], confidence: 2, questions: ["nope"] }],
      }),
    ).toThrow(/confidence.*questions|questions.*confidence/s);
  });

  test("user prompt contains messages, open quests and previous trace", () => {
    const text = buildUserPrompt(window);
    expect(text).toContain("Astryx");
    expect(text).toContain("Ship marko-ui");
    expect(text).toContain("fixing walk order");
  });

  test("anthropic client parses JSON text and retries once on invalid output", async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls += 1;
      const body =
        calls === 1
          ? { content: [{ type: "text", text: "not json" }] }
          : { content: [{ type: "text", text: JSON.stringify(good) }] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const classifier = new AnthropicClassifier({ apiKey: "k", model: "m", fetch: fakeFetch });
    const result = await classifier.classify(window);
    expect(calls).toBe(2);
    expect(result.segments[1]?.isSwitch).toBe(true);
  });

  test("anthropic client fails after the retry", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ content: [{ type: "text", text: "{" }] }), {
        status: 200,
      })) as unknown as typeof fetch;
    const classifier = new AnthropicClassifier({ apiKey: "k", model: "m", fetch: fakeFetch });
    await expect(classifier.classify(window)).rejects.toThrow();
  });

  test("validateResult rejects a segment whose timestamps fall outside the window", () => {
    expect(() =>
      validateResult(
        {
          segments: [{ ...good.segments[0], startedAt: "2026-09-04T13:00:00.000Z" }],
        },
        window,
      ),
    ).toThrow(/outside the window/);

    expect(() =>
      validateResult(
        {
          segments: [{ ...good.segments[0], endedAt: "2026-09-04T18:00:00.000Z" }],
        },
        window,
      ),
    ).toThrow(/outside the window/);

    expect(validateResult(good, window).segments.length).toBe(2);
  });

  test("anthropic client throws with status and body excerpt on a non-2xx response, never the key", async () => {
    const secretKey = "sk-ant-super-secret-do-not-leak";
    const fakeFetch = (async () =>
      new Response("unauthorized: invalid x-api-key header", {
        status: 401,
      })) as unknown as typeof fetch;
    const classifier = new AnthropicClassifier({ apiKey: secretKey, model: "m", fetch: fakeFetch });

    let message = "";
    try {
      await classifier.classify(window);
      throw new Error("should have thrown");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("401");
    expect(message).toContain("unauthorized: invalid x-api-key header");
    expect(message).not.toContain(secretKey);
  });
});
