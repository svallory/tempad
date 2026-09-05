import { type ClassifierResult, type ClassifierWindow, validateResult } from "./classifier";

export function extractJsonText(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (fenced?.[1] ?? text).trim();
}

export async function classifyWithRetry(
  window: ClassifierWindow,
  userPrompt: string,
  request: (prompt: string) => Promise<string>,
): Promise<ClassifierResult> {
  const first = await request(userPrompt);
  try {
    return validateResult(JSON.parse(extractJsonText(first)), window);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const retryPrompt = `${userPrompt}\n\nYour previous response was invalid: ${message}\nRespond with valid JSON only.`;
    const second = await request(retryPrompt);
    return validateResult(JSON.parse(extractJsonText(second)), window);
  }
}
