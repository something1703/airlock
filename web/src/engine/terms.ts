import type { Entity, PrivacyCategory } from "./types";

/** First names that are also everyday words — not checked case-sensitively as bare tokens. */
export const COMMON_WORDS = new Set([
  "will", "may", "june", "april", "august", "rose", "grace", "hope", "joy", "faith", "mark", "bill", "frank", "art", "sky", "river", "dawn",
  "summer", "autumn", "winter", "ray", "rich", "sunny", "honey", "page", "pat", "sue", "jack", "max", "victor", "trust", "ivy", "lily", "daisy",
  "ruby", "pearl", "amber", "crystal", "sandy", "rusty", "brook", "gay", "holly", "jean", "rob", "drew", "chase", "hunter", "mason", "cash",
  "king", "queen", "young", "white", "black", "brown", "green", "gray", "grey", "long", "little", "small", "good", "best", "street", "the",
  "and", "for", "you", "your", "our", "his", "her", "dear", "mom", "dad", "mum", "aunt", "uncle", "grandma", "mrs", "miss", "prof", "sir",
  "madam", "dame", "lord", "lady", "doctor",
]);

/** Generic words inside organisation and place names — never identifying on their own. */
export const GENERIC_PLACE_WORDS = new Set([
  "hospital", "clinic", "medical", "centre", "center", "health", "care", "general", "university", "college", "school", "academy",
  "institute", "bank", "group", "company", "corp", "corporation", "inc", "ltd", "llc", "limited", "partners", "services", "solutions",
  "logistics", "properties", "property", "management", "realty", "holdings", "international", "national", "global", "city", "county",
  "state", "north", "south", "east", "west", "new", "saint", "street", "road", "avenue", "lane", "drive", "court", "place", "park",
  "square", "apartment", "apartments", "unit", "suite", "floor", "view", "hill", "valley", "lake", "river", "church", "office",
  "department", "agency", "council", "trust", "foundation",
]);

export interface Term {
  text: string;
  check: "G1" | "G2";
  category: PrivacyCategory;
  caseSensitive: boolean;
}

const stripEdges = (w: string): string => w.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "");

/**
 * Every way an entity could still show up: whole surface forms (case-insensitive), plus for people,
 * organisations and places: contiguous sub-phrases of ≥ 2 words ("Mercy General" from "Mercy General
 * Hospital") and distinctive single words (≥ 3 letters for people, ≥ 4 otherwise), case-sensitive,
 * excluding everyday and generic words. Shared by the egress gate and generaliser validation.
 */
export function entityTerms(e: Entity): Term[] {
  const forms = [...e.surfaceForms].filter((f) => f.length >= 2);
  const terms: Term[] = forms.map((text) => ({ text, check: "G2", category: e.category, caseSensitive: false }));
  if (e.category !== "person" && e.category !== "org" && e.category !== "location") return terms;
  const phrases = new Set<string>();
  const singles = new Set<string>();
  const minLength = e.category === "person" ? 3 : 4;
  for (const form of forms) {
    const words = form.split(/[\s,-]+/u).map(stripEdges).filter((w) => w.length > 0);
    if (words.length >= 3) {
      for (let n = 2; n < words.length; n++) for (let i = 0; i + n <= words.length; i++) phrases.add(words.slice(i, i + n).join(" "));
    }
    for (const w of words) {
      const first = [...w][0] ?? "";
      if ([...w].length < minLength || !/\p{Lu}/u.test(first)) continue;
      const lower = w.toLowerCase();
      if (COMMON_WORDS.has(lower) || GENERIC_PLACE_WORDS.has(lower) || /^\p{N}+$/u.test(w)) continue;
      singles.add(w);
    }
  }
  const all = new Set(forms);
  for (const p of [...phrases].sort()) if (!all.has(p)) terms.push({ text: p, check: "G2", category: e.category, caseSensitive: false });
  for (const s of [...singles].sort()) if (!all.has(s)) terms.push({ text: s, check: "G2", category: e.category, caseSensitive: true });
  return terms;
}
