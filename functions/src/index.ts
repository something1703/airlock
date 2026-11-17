// Airlock Cloud Functions (v2). docs/05-FIREBASE-AND-GCP.md §7. Only ever handle SEALED data (INV-1, INV-7).
import { DlpServiceClient } from "@google-cloud/dlp";
import { initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { deltaFor, isoWeek, type SyncedReceipt } from "./stats.js";
import { INFO_TYPES, mapFindings, validateScanInput } from "./scan.js";

initializeApp();
const db = getFirestore();

/**
 * Receipt created → add it to `users/{uid}/stats/{isoWeek}`. Idempotent: a marker doc per receipt is created
 * in the same transaction, so an at-least-once retry never double-counts. Logs ids only, never content (INV-8).
 */
export const aggregateStats = onDocumentCreated("users/{uid}/receipts/{receiptId}", async (event) => {
  const receipt = event.data?.data() as SyncedReceipt | undefined;
  if (!receipt) return;
  const { uid, receiptId } = event.params;
  let week: string;
  try {
    week = isoWeek(receipt.createdAt);
  } catch {
    logger.warn("aggregateStats: bad createdAt", { uid, receiptId });
    return;
  }
  const d = deltaFor(receipt);
  const statsRef = db.doc(`users/${uid}/stats/${week}`);
  const markerRef = db.doc(`users/${uid}/statsSeen/${receiptId}`);
  await db.runTransaction(async (tx) => {
    if ((await tx.get(markerRef)).exists) return;
    const update: Record<string, unknown> = {
      week,
      requests: FieldValue.increment(d.requests),
      sealedDetails: FieldValue.increment(d.sealedDetails),
      generalised: FieldValue.increment(d.generalised),
      onDeviceAnswers: FieldValue.increment(d.onDeviceAnswers),
      cloudAnswers: FieldValue.increment(d.cloudAnswers),
      blocked: FieldValue.increment(d.blocked),
      updatedAt: FieldValue.serverTimestamp(),
    };
    // A nested map (not "byCategory.x" keys): `set` with merge treats dots literally; only `update` reads them as paths.
    update.byCategory = Object.fromEntries(Object.entries(d.byCategory).map(([k, v]) => [k, FieldValue.increment(v)]));
    tx.set(statsRef, update, { merge: true });
    tx.create(markerRef, { at: FieldValue.serverTimestamp() });
  });
});

let dlp: DlpServiceClient | null = null;

/**
 * "Scan with Google": Sensitive Data Protection on text the user already SENT (sealed). App Check + auth
 * required; ≤ 20k chars. Returns findings so the app can say "found 0 personal details" or list them.
 */
export const scanSealed = onCall({ enforceAppCheck: true }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign-in required.");
  const input = validateScanInput(req.data);
  if ("error" in input) throw new HttpsError("invalid-argument", input.error);
  const project = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT;
  if (!project) throw new HttpsError("internal", "No project.");
  dlp ??= new DlpServiceClient();
  const [res] = await dlp.inspectContent({
    parent: `projects/${project}/locations/global`,
    inspectConfig: { infoTypes: INFO_TYPES.map((name) => ({ name })), minLikelihood: "POSSIBLE", includeQuote: true, limits: { maxFindingsPerRequest: 50 } },
    item: { value: input.text },
  });
  const findings = mapFindings(res.result?.findings as Parameters<typeof mapFindings>[0]);
  logger.info("scanSealed", { uid: req.auth.uid, chars: input.text.length, findings: findings.length });
  return { findings };
});

/** Deletes everything Airlock synced for the caller (`users/{uid}` and all subcollections). */
export const deleteUserData = onCall({ enforceAppCheck: true }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign-in required.");
  await db.recursiveDelete(db.doc(`users/${req.auth.uid}`));
  logger.info("deleteUserData", { uid: req.auth.uid });
  return { deleted: true };
});
