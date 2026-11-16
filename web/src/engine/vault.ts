import { ranges } from "./foldedSearch";
import { type Candidate, type PrivacyCategory, compareSpans, spansOverlap, substringOf } from "./types";

/** One "always protect" entry the user saved. Stored only on device, encrypted (INV-6). */
export interface VaultEntry {
  id: string;
  canonical: string;
  aliases: string[];
  category: PrivacyCategory;
  roleHint?: string | null;
  /** The user themself → always `[[PERSON_ME]]`. */
  isUser: boolean;
}

/** Canonical plus aliases, longest first. */
export function allTerms(e: VaultEntry): string[] {
  return [...new Set([e.canonical, ...e.aliases].filter((t) => t.trim().length > 0))].sort((a, b) => {
    const la = [...a].length;
    const lb = [...b].length;
    return la !== lb ? lb - la : a < b ? -1 : a > b ? 1 : 0;
  });
}

/** D1 — Vault matcher (highest-priority detector). Folded, word-bounded; longer terms win. */
export class VaultMatcher {
  constructor(readonly entries: readonly VaultEntry[]) {}

  detect(text: string): Candidate[] {
    const terms = this.entries
      .flatMap((entry) => allTerms(entry).map((term) => ({ term, entry })))
      .sort((a, b) => [...b.term].length - [...a.term].length);
    const hits: { span: { start: number; end: number }; entry: VaultEntry }[] = [];
    for (const { term, entry } of terms) {
      for (const span of ranges(term, text)) {
        if (!hits.some((h) => spansOverlap(h.span, span))) hits.push({ span, entry });
      }
    }
    hits.sort((a, b) => compareSpans(a.span, b.span));
    const out: Candidate[] = [];
    for (const { span, entry } of hits) {
      const value = substringOf(text, span);
      if (value === null) continue;
      out.push({
        span, text: value, category: entry.category, subtype: entry.isUser ? "self" : null, detector: "vault", confidence: "high",
        roleHint: entry.isUser ? "the user" : (entry.roleHint ?? null), vaultEntryId: entry.id,
      });
    }
    return out;
  }
}
