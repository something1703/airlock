import type { PhoneAvailability } from "../engine/engines";

/** Chrome's built-in Prompt API global (read only for availability; inference goes through Firebase AI Logic). */
interface ChromeLanguageModel {
  availability(options?: unknown): Promise<"unavailable" | "downloadable" | "downloading" | "available">;
}

export async function chromeAvailability(): Promise<PhoneAvailability> {
  const lm = (globalThis as { LanguageModel?: ChromeLanguageModel }).LanguageModel;
  if (!lm) return "unavailable";
  try {
    return await lm.availability({ expectedInputs: [{ type: "text", languages: ["en"] }], expectedOutputs: [{ type: "text", languages: ["en"] }] });
  } catch {
    return "unknown";
  }
}
