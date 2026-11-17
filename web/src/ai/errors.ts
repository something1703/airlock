import { AIError } from "firebase/ai";
import { EngineError } from "../engine/engines";

/**
 * Maps any SDK / browser error to an EngineError carrying a code only — never the SDK's message, which
 * may echo prompt or answer text (INV-8).
 */
export function mapError(e: unknown, depth = 0): EngineError {
  if (e instanceof EngineError) return e;
  if (typeof DOMException !== "undefined" && e instanceof DOMException) {
    switch (e.name) {
      case "AbortError": return new EngineError("cancelled");
      case "QuotaExceededError": return new EngineError("contextTooLong");
      case "NotSupportedError": return new EngineError("unsupportedLanguage");
      case "NotAllowedError": return new EngineError("needsUserGesture");
      case "NetworkError": return new EngineError("offline");
      default: return new EngineError("other", `dom.${e.name}`);
    }
  }
  if (e instanceof AIError) {
    const status = e.customErrorData?.status;
    const block = e.customErrorData?.response?.promptFeedback?.blockReason as string | undefined;
    if (block) return new EngineError(block === "MODEL_ARMOR" ? "armorBlocked" : "cloudBlocked");
    if (status === 429) return new EngineError("quota");
    if (status !== undefined && status >= 500) return new EngineError("serviceUnavailable");
    if (status === 401 || status === 403) return new EngineError("appCheck", `http.${status}`);
    if (status !== undefined) return new EngineError("other", `http.${status}`);
    switch (e.code) {
      case "unsupported": return new EngineError("unavailable");
      case "parse-failed": return new EngineError("parse");
      case "api-not-enabled": return new EngineError("other", "api-not-enabled");
      case "fetch-error": return new EngineError(isOffline() ? "offline" : "other", "fetch");
      default: {
        const cause = (e as { cause?: unknown }).cause;
        if (cause && depth < 3) return mapError(cause, depth + 1);
        return new EngineError("other", `ai.${e.code}`);
      }
    }
  }
  if (e instanceof TypeError && /fetch|network/i.test(e.message)) return new EngineError("offline");
  return new EngineError("other", "unknown");
}

const isOffline = (): boolean => typeof navigator !== "undefined" && navigator.onLine === false;
