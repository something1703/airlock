// Pure logic for scanSealed: input validation and mapping Sensitive Data Protection findings. No I/O.

export const MAX_SCAN_CHARS = 20_000;
export const INFO_TYPES = ["EMAIL_ADDRESS", "PHONE_NUMBER", "CREDIT_CARD_NUMBER", "IBAN_CODE", "US_SOCIAL_SECURITY_NUMBER", "PERSON_NAME", "STREET_ADDRESS", "LOCATION"];

export type ScanInputError = "missing-text" | "too-long";

/** Accepts only `{ text: string }` with 1..20k chars (the app sends SEALED text, by explicit user action). */
export function validateScanInput(data: unknown): { text: string } | { error: ScanInputError } {
  const text = (data as { text?: unknown } | null)?.text;
  if (typeof text !== "string" || text.trim().length === 0) return { error: "missing-text" };
  if (text.length > MAX_SCAN_CHARS) return { error: "too-long" };
  return { text };
}

export interface Finding {
  infoType: string;
  likelihood: string;
  /** Code-point offsets into the scanned text. */
  start: number;
  end: number;
  quote: string;
}

interface DlpFinding {
  infoType?: { name?: string | null } | null;
  likelihood?: string | number | null;
  quote?: string | null;
  location?: { codepointRange?: { start?: string | number | null; end?: string | number | null } | null } | null;
}

/** Maps DLP `inspectContent` findings to a small stable shape, sorted by position. */
export function mapFindings(findings: readonly DlpFinding[] | null | undefined): Finding[] {
  return (findings ?? [])
    .map((f) => ({
      infoType: f.infoType?.name ?? "UNKNOWN",
      likelihood: String(f.likelihood ?? "LIKELIHOOD_UNSPECIFIED"),
      start: Number(f.location?.codepointRange?.start ?? 0),
      end: Number(f.location?.codepointRange?.end ?? 0),
      quote: f.quote ?? "",
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
}
