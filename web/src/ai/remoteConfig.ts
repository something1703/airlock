// Remote Config for the web app (AGENTS.md §5.4: model names and thresholds come from Remote Config with
// bundled defaults). Values are typed and validated by AppConfig; anything missing or mistyped falls back.
import type { FirebaseApp } from "firebase/app";
import { activate, fetchAndActivate, getAll, getRemoteConfig } from "firebase/remote-config";

/**
 * Returns the server values that differ from nothing (source "remote") as strings. Uses the cached,
 * previously fetched config immediately and waits at most `waitMs` for a fresh fetch; startup is never
 * blocked longer than that, and failures (offline, App Check) leave the bundled defaults in place.
 */
export async function loadRemoteConfig(app: FirebaseApp, waitMs = 2500): Promise<Record<string, string>> {
  try {
    const rc = getRemoteConfig(app);
    rc.settings.minimumFetchIntervalMillis = 60 * 60 * 1000;
    rc.settings.fetchTimeoutMillis = waitMs;
    await activate(rc).catch(() => false);
    await Promise.race([fetchAndActivate(rc).catch(() => false), new Promise((r) => setTimeout(r, waitMs))]);
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(getAll(rc))) if (value.getSource() === "remote") out[key] = value.asString();
    return out;
  } catch {
    return {};
  }
}
