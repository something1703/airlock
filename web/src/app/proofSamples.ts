// Fictional sample messages for Proof mode ("Try a sample") and the scripted demo engines (`?demo=1`).
// Every name, company, domain, amount and code here is made up.
import type { ClaimContext, GroundedResult } from "../engine/engines";
import { patternTactics } from "../engine/proof";

export interface ProofSample {
  label: string;
  message: string;
  /** What the demo's "on-device model" answers to `tactics.v1`. */
  tactics: { tactics: { tactic: string; evidence: string }[]; claims: string[] };
  /** What the demo's "Gemini + Google Search" answers to `claimcheck.v1`. */
  cloud: string;
}

export const PROOF_SAMPLES: ProofSample[] = [
  {
    label: "A text from “your bank”",
    message: "Lakeview Bank: we noticed a suspicious payment of £740 on your card. Your account has been frozen. To unlock it, reply with the 6-digit code we just sent you within 2 hours. Do not share this message with anyone.",
    tactics: {
      tactics: [{ tactic: "secrecy", evidence: "Do not share this message with anyone" }, { tactic: "authority", evidence: "Lakeview Bank" }],
      claims: ["A bank has frozen the account because of a suspicious payment", "The account can be unlocked by replying with a one-time code"],
    },
    cloud: "VERDICT: LIKELY_SCAM\nWHY: Banks don't ask customers to send one-time codes by text. Consumer guidance lists a request for a code as a common sign of fraud.\nDO:\n- Call the number on the back of your card.\n- Check your account in your bank's official app.\nDONT:\n- Don't reply with any code.\n- Don't click links in the message.",
  },
  {
    label: "A parcel fee",
    message: "Swiftpost: your parcel is on hold because of an unpaid customs fee of 1.99. Pay now at bit.ly/3Fk9xQz or it will be returned to the sender.",
    tactics: {
      tactics: [{ tactic: "urgency", evidence: "Pay now" }, { tactic: "unusual_payment", evidence: "unpaid customs fee of 1.99" }],
      claims: ["A parcel is being held until a small customs fee is paid", "The fee can be paid through a link in the text"],
    },
    cloud: "VERDICT: LIKELY_SCAM\nWHY: Small “customs fee” texts with short links are a widely reported delivery scam. Couriers tell customers to check the official tracking page instead.\nDO:\n- Check the tracking number on the courier's official website.\n- Report the text to your mobile provider.\nDONT:\n- Don't pay through the link.\n- Don't enter card details.",
  },
  {
    label: "A dentist reminder",
    message: "Reminder from Bright Smile Dental: your check-up is on Tuesday at 3:30pm. Reply C to confirm or call the practice to rebook.",
    tactics: { tactics: [], claims: ["The reader has a dental check-up booked"] },
    cloud: "VERDICT: LIKELY_LEGIT\nWHY: Appointment reminders that only ask you to confirm are normal. This one doesn't ask for money, codes or personal details.\nDO:\n- Call the practice on its usual number if you're unsure.\nDONT:\n- Don't reply with personal details.",
  },
];

/** Demo `tactics.v1`: the sample's scripted answer, or the pattern findings for any other text. */
export function demoTactics(message: string): string {
  const sample = PROOF_SAMPLES.find((s) => s.message.trim() === message.trim());
  if (sample) return JSON.stringify(sample.tactics);
  const tactics = patternTactics(message).map((f) => ({ tactic: f.tactic, evidence: f.evidence ?? "" }));
  return JSON.stringify({ tactics, claims: ["The message asks the reader to act on what it says"] });
}

const DEMO_SOURCES: Pick<GroundedResult, "sources" | "supports"> = {
  sources: [
    { chunkIndex: 0, title: "consumer-advice.example (demo source)", uri: "https://consumer-advice.example/scam-texts" },
    { chunkIndex: 1, title: "fraud-help.example (demo source)", uri: "https://fraud-help.example/check-a-message" },
  ],
  supports: [],
};

/** A neutral stand-in for Google's Search Suggestions in demo mode (live mode shows Google's own snippet). */
const DEMO_ENTRY_POINT = `<style>.d{font:13px/1.4 system-ui,sans-serif;border:1px dashed #8a94a6;border-radius:12px;padding:8px 12px;color:#4a5568}@media(prefers-color-scheme:dark){.d{color:#a3aec2}}</style><div class="d">Demo mode · in live mode, Google Search suggestions for this check appear here.</div>`;

/** Demo `claimcheck.v1`: matches the sealed claim to a sample, else answers from the tactics found. */
export function demoClaimCheck(sealedValue: string, ctx: ClaimContext): Partial<GroundedResult> {
  const sample = PROOF_SAMPLES.find((s) => s.tactics.claims.includes(sealedValue));
  const strong = ctx.tactics.some((t) => t === "credential_request" || t === "unusual_payment");
  const text = sample?.cloud ?? (strong
    ? "VERDICT: LIKELY_SCAM\nWHY: Messages that ask for codes or unusual payments match common scam warnings.\nDO:\n- Contact the organisation using a number from its official website.\nDONT:\n- Don't send money or codes."
    : "VERDICT: UNCLEAR\nWHY: The demo can't check this message against the web.\nDO:\n- Contact the sender through a channel you already trust.\nDONT:\n- Don't click links you weren't expecting.");
  const why = /WHY: ([^\n]*)/.exec(text)?.[1] ?? "";
  const first = why.split(". ")[0] ?? "";
  return {
    text, modelVersion: "gemini-demo-search", latencyMs: 900, searchEntryPointHtml: DEMO_ENTRY_POINT, webSearchQueries: [],
    ...DEMO_SOURCES, supports: first ? [{ text: first, chunkIndices: [0, 1] }] : [],
  };
}
