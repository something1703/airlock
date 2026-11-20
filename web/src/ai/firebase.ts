// Firebase bootstrap for the web app: App Check before any AI call, anonymous auth for sync.
import { initializeApp, type FirebaseApp } from "firebase/app";
import { initializeAppCheck, ReCaptchaEnterpriseProvider, ReCaptchaV3Provider } from "firebase/app-check";
import { getAuth, signInAnonymously } from "firebase/auth";

export type FirebaseStatus =
  | { kind: "configured"; app: FirebaseApp; appCheck: "recaptcha" | "debug" | "off" }
  | { kind: "missingConfig" };

/** Reads the gitignored `.env.local` (VITE_FIREBASE_*). Missing config → the app runs with cloud features off. */
export function bootFirebase(env: ImportMetaEnv = import.meta.env): FirebaseStatus {
  if (!env.VITE_FIREBASE_API_KEY || !env.VITE_FIREBASE_APP_ID) return { kind: "missingConfig" };
  const app = initializeApp({
    apiKey: env.VITE_FIREBASE_API_KEY, authDomain: env.VITE_FIREBASE_AUTH_DOMAIN, projectId: env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET, messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID, appId: env.VITE_FIREBASE_APP_ID,
  });
  let appCheck: "recaptcha" | "debug" | "off" = "off";
  // Fraud Defense (reCAPTCHA Enterprise) is preferred: Firebase no longer accepts new reCAPTCHA Classic (v3)
  // registrations. The v3 key stays supported for projects registered before that.
  const enterpriseKey = env.VITE_RECAPTCHA_ENTERPRISE_SITE_KEY;
  if (enterpriseKey || env.VITE_RECAPTCHA_SITE_KEY) {
    // In development the SDK prints a debug token to register in the console; never commit it.
    if (env.DEV) (globalThis as { FIREBASE_APPCHECK_DEBUG_TOKEN?: boolean }).FIREBASE_APPCHECK_DEBUG_TOKEN = true;
    const provider = enterpriseKey ? new ReCaptchaEnterpriseProvider(enterpriseKey) : new ReCaptchaV3Provider(env.VITE_RECAPTCHA_SITE_KEY ?? "");
    initializeAppCheck(app, { provider, isTokenAutoRefreshEnabled: true });
    appCheck = env.DEV ? "debug" : "recaptcha";
  }
  return { kind: "configured", app, appCheck };
}

/** Anonymous sign-in (used for owner-only Firestore sync of sealed threads). */
export async function signInQuietly(app: FirebaseApp): Promise<string | null> {
  try {
    return (await signInAnonymously(getAuth(app))).user.uid;
  } catch {
    return null;
  }
}
