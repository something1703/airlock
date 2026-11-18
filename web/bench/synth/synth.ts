// `synth-tpl.v1` — the deterministic, offline stand-in for `synth.v1` (docs/04-PROMPTS.md §9). Same output
// schema (text, gold, quasi, profile, task), fictional values assembled from parts, no model call. The cloud
// generator (`synth.v1`, live only) lives in ../live.ts and goes through the same `validateItem`.
import { isNormalised } from "../../src/engine/normaliser";
import { type BenchItem, type GoldSpan, type GoldType, type Language, type Length, type Profile, type QuasiSpan, LANGUAGES, LENGTHS } from "../dataset";
import { digits, hash32, int, pick, rng, sample, type Rng } from "../rng";
import { PARTS, type LanguageParts, type QuasiDef } from "./parts";
import { CHAT_SLOTS, DOC_TYPES, LETTER_SLOTS, orgList, type DocTypeDef, type ExtraSlot } from "./templates";

export const GENERATOR_ID = "synth-tpl.v1";
/** "Today" for ages and dates — fixed so the dataset never changes with the calendar. */
export const REFERENCE_DATE = { y: 2026, m: 11, d: 18 };

export type DatasetName = "synth-v1" | "synth-hard" | "demo-set";
export const DATASET_SIZES: Record<Exclude<DatasetName, "demo-set">, number> = { "synth-v1": 600, "synth-hard": 120 };
export const DEFAULT_SEED = 20261118;

interface Slot {
  value: string;
  gold?: { type: GoldType; role: string };
}

const asciiFold = (s: string): string => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z]/g, "");

function fillFormat(fmt: string, vars: Record<string, string>): string {
  return fmt.replace(/\{([a-z]+)\}/g, (_, k: string) => vars[k] ?? "");
}

const fromFormat = (r: Rng, fmt: string): string => fmt.replace(/#/g, () => String(int(r, 0, 9)));

/** ISO 13616 check digits, so the IBAN validator in the pattern pack accepts it. */
export function iban(country: string, bban: string): string {
  const numeric = (bban + country + "00").toUpperCase().replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rem = 0;
  for (const ch of numeric) rem = (rem * 10 + Number(ch)) % 97;
  const check = String(98 - rem).padStart(2, "0");
  return (country + check + bban).replace(/(.{4})/g, "$1 ").trim();
}

function makeIban(r: Rng, p: LanguageParts): string {
  const bank = p.ibanCountry === "GB" ? pick(r, ["HRLW", "FNWK", "LKSP"]) : digits(r, p.ibanBankDigits);
  return iban(p.ibanCountry, bank + digits(r, p.ibanAccountDigits));
}

function ageOn(y: number, m: number, d: number): number {
  const ref = REFERENCE_DATE;
  return ref.y - y - (m > ref.m || (m === ref.m && d > ref.d) ? 1 : 0);
}

/** Distinct first/last names for everyone in a document. */
function people(r: Rng, p: LanguageParts, n: number): { first: string; last: string }[] {
  const firsts = sample(r, p.first, n);
  const lasts = sample(r, p.last, n);
  return firsts.map((first, i) => ({ first, last: lasts[i]! }));
}

interface Rendered {
  text: string;
  gold: GoldSpan[];
}

/** Fills `{slot}` markers; every private value that lands in the text becomes a gold span (deduplicated). */
function render(template: string, slots: Record<string, Slot>, gold: Map<string, GoldSpan>): string {
  return template.replace(/\{([a-z0-9_]+)\}/g, (whole, key: string) => {
    const slot = slots[key];
    if (!slot) throw new Error(`template slot {${key}} has no value`);
    if (slot.gold && !gold.has(slot.value)) gold.set(slot.value, { text: slot.value, type: slot.gold.type, role: slot.gold.role });
    return slot.value;
  });
}

export interface ItemSpec {
  dataset: DatasetName;
  index: number;
  seed: number;
  docType: DocTypeDef;
  language: Language;
  length: Length;
  hard: boolean;
}

/** One document. Pure function of its spec. */
export function generateItem(spec: ItemSpec): BenchItem {
  const r = rng(hash32(`${spec.dataset}:${spec.seed}:${spec.index}`));
  const p = PARTS[spec.language];
  const dt = spec.docType;
  const t = dt.text[spec.language];
  const chat = dt.style === "chat";
  const slotText = chat ? CHAT_SLOTS[spec.language] : LETTER_SLOTS[spec.language];

  const [writer, other, other2, child] = people(r, p, 4) as [{ first: string; last: string }, { first: string; last: string }, { first: string; last: string }, { first: string; last: string }];
  const place = pick(r, spec.hard ? p.smallTowns : p.cities);
  const employer = pick(r, p.employers);
  const org = dt.org === "employer" ? employer : pick(r, orgList(p, dt.org).filter((o) => o !== employer));
  const by = int(r, 1958, 2004);
  const bm = int(r, 1, 12);
  const bd = int(r, 1, 28);
  const age = ageOn(by, bm, bd);
  const dob = fillFormat(p.dobFormat, { d: String(bd), m: p.months[bm - 1]!, y: String(by) });
  const address = fillFormat(pick(r, p.addressFormats), { n: String(int(r, 2, 180)), s: pick(r, p.streets), u: String(int(r, 1, 24)) });
  const phone = fillFormat(pick(r, p.phoneFormats), { a: digits(r, 3), b: digits(r, 2), c: digits(r, 4) });
  const email = `${asciiFold(writer.first)}.${asciiFold(writer.last)}@${pick(r, ["example.com", "example.org", "example.net"])}`;
  const password = `${pick(r, p.passwordWords)}-${pick(r, p.passwordWords)}-${digits(r, 2)}`;
  const otp = String(int(r, 100000, 999999));

  // Quasi-identifiers: synth-v1 has 1–2 subtle details; synth-hard 3–5, with a rare job that reveals the occupation.
  const quasiCount = spec.hard ? int(r, 3, 5) : spec.length === "short" ? 1 : int(r, 1, 2);
  const rare = spec.hard ? pick(r, p.rareOccupations) : null;
  const quasiDefs: QuasiDef[] = rare ? [rare, ...sample(r, p.quasi, quasiCount - 1)] : sample(r, p.quasi, quasiCount);
  const occupation = rare?.occupation ?? pick(r, p.occupations);

  const writerFull = `${writer.first} ${writer.last}`;
  const otherFull = `${other.first} ${other.last}`;
  const other2Role = dt.key === "group chat" ? "a parent in the writer's group chat" : "the writer's colleague";
  const slots: Record<string, Slot> = {
    writer: { value: writerFull, gold: { type: "PERSON", role: "the writer" } },
    writer_first: { value: writer.first, gold: { type: "PERSON", role: "the writer" } },
    other: { value: otherFull, gold: { type: "PERSON", role: dt.otherRole } },
    other_first: { value: other.first, gold: { type: "PERSON", role: dt.otherRole } },
    other2: { value: `${other2.first} ${other2.last}`, gold: { type: "PERSON", role: other2Role } },
    other2_first: { value: other2.first, gold: { type: "PERSON", role: other2Role } },
    child: { value: child.first, gold: { type: "PERSON", role: "the writer's child" } },
    org: { value: org, gold: { type: "ORG", role: dt.org === "employer" ? "the writer's employer" : dt.orgRole } },
    employer: { value: employer, gold: { type: "ORG", role: "the writer's employer" } },
    city: { value: place.name, gold: { type: "LOCATION", role: "the writer's town" } },
    address: { value: address, gold: { type: "LOCATION", role: "the writer's home address" } },
    phone: { value: phone, gold: { type: "CONTACT", role: "the writer's phone number" } },
    email: { value: email, gold: { type: "CONTACT", role: "the writer's email" } },
    id: { value: fromFormat(r, dt.idFormat), gold: { type: "ID", role: `the writer's ${dt.text.en.idLabel}` } },
    id_label: { value: t.idLabel },
    dob: { value: dob, gold: { type: "DATE", role: "the writer's date of birth" } },
    otp: { value: otp, gold: { type: "SECRET", role: "a one-time code" } },
    password: { value: password, gold: { type: "SECRET", role: "the writer's password" } },
    health: { value: pick(r, p.health), gold: { type: "HEALTH", role: "the writer's medical condition" } },
    iban: { value: makeIban(r, p), gold: { type: "ID", role: "the writer's bank account" } },
    occupation: { value: occupation },
  };

  const extras: ExtraSlot[] = spec.length === "short" ? [] : spec.length === "medium" ? dt.extras.slice(0, 2) : dt.extras;
  const fillerCount = spec.length === "short" ? int(r, 0, 1) : spec.length === "medium" ? int(r, 2, 4) : int(r, 8, 11);
  const speakers = dt.key === "group chat" ? [writer.first, other.first, other2.first] : [writer.first, other.first];
  const fillers = sample(r, chat ? p.chatFillers : p.fillers, fillerCount).map((f) => (chat ? `${pick(r, speakers)}: ${f}` : f));
  const quasiLines = quasiDefs.map((q) => fillFormat(slotText.quasi.replace("{lead}", chat ? "" : pick(r, p.quasiLead)), { quasi: q.text, writer_first: "{writer_first}" }));

  const intro = spec.hard ? slotText.intro : slotText.introWithOccupation;
  const middle = [
    ...(spec.length === "short" ? [] : [t.situation[1]]),
    slotText.address,
    ...extras.map((e) => slotText[e]),
    ...quasiLines,
    ...fillers,
  ];
  // Deterministic shuffle of the middle; intro first, ask last (so every document reads naturally).
  const shuffled = sample(r, middle, middle.length);
  const body = [intro, t.situation[0], ...shuffled, t.ask];

  const gold = new Map<string, GoldSpan>();
  let text: string;
  if (chat) {
    text = [t.opener, ...body, t.closing].map((line) => render(line, slots, gold)).join("\n");
  } else {
    const paragraphs: string[] = [];
    for (let i = 0; i < body.length; i += 3) paragraphs.push(body.slice(i, i + 3).map((s) => render(s, slots, gold)).join(" "));
    text = [render(t.opener, slots, gold), ...paragraphs, render(t.closing, slots, gold)].join("\n\n");
  }

  const quasi: QuasiSpan[] = quasiDefs.map((q) => ({ text: q.text, reveals: q.reveals }));
  const profile: Profile = { name: writerFull, city: place.name, employer, age, occupation, metro: place.metro };
  const prefix = spec.dataset === "demo-set" ? "demo" : spec.dataset;
  return {
    id: `${prefix}-${String(spec.index + 1).padStart(4, "0")}`,
    dataset: spec.dataset,
    split: spec.dataset === "demo-set" ? "test" : spec.index % 5 === 4 ? "test" : "dev",
    provenance: spec.dataset === "demo-set" ? "airlock-bench-demo" : "airlock-bench-template",
    generator: GENERATOR_ID,
    synthetic: true,
    doc_type: dt.key,
    language: spec.language,
    length: spec.length,
    quasi_count: quasiDefs.length,
    text,
    gold: [...gold.values()],
    quasi,
    profile,
    task: dt.task,
    task_kind: dt.taskKind,
  };
}

/** 10 doc types × 3 languages × 3 lengths, cycled; index → combination is fixed. */
export function generateDataset(dataset: Exclude<DatasetName, "demo-set">, seed = DEFAULT_SEED, n = DATASET_SIZES[dataset]): BenchItem[] {
  const out: BenchItem[] = [];
  for (let i = 0; i < n; i++) {
    const docType = DOC_TYPES[i % DOC_TYPES.length]!;
    const language = LANGUAGES[Math.floor(i / DOC_TYPES.length) % LANGUAGES.length]!;
    const length = LENGTHS[Math.floor(i / (DOC_TYPES.length * LANGUAGES.length)) % LENGTHS.length]!;
    out.push(generateItem({ dataset, index: i, seed, docType, language, length, hard: dataset === "synth-hard" }));
  }
  return out;
}

/** The 5 video scenarios (docs/09-TESTING.md §7), as fixed English documents. */
export const DEMO_SCENARIOS: { docType: string; length: Length }[] = [
  { docType: "landlord dispute", length: "medium" },
  { docType: "email to HR", length: "medium" },
  { docType: "contract clause", length: "medium" },
  { docType: "scam message", length: "short" },
  { docType: "text-message thread", length: "short" },
];

export function generateDemoSet(seed = DEFAULT_SEED): BenchItem[] {
  return DEMO_SCENARIOS.map((s, index) => {
    const docType = DOC_TYPES.find((d) => d.key === s.docType);
    if (!docType) throw new Error(`unknown demo doc type ${s.docType}`);
    return generateItem({ dataset: "demo-set", index, seed, docType, language: "en", length: s.length, hard: false });
  });
}

export interface ValidationIssue {
  itemId: string;
  problem: string;
}

/**
 * docs/07 §3 validation: every gold span is an exact substring, profile values appear in the text, the text is
 * already in the engine's normal form (so spans mean the same before and after `normalise`). Applied to
 * template and model-generated items alike; invalid items are dropped and the drop rate is logged.
 */
export function validateItem(it: BenchItem): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const bad = (problem: string): void => {
    issues.push({ itemId: it.id, problem });
  };
  if (typeof it.text !== "string" || it.text.trim() === "") bad("empty text");
  else {
    if (!isNormalised(it.text)) bad("text is not in normal form");
    for (const g of it.gold ?? []) if (!g.text || !it.text.includes(g.text)) bad(`gold span not in text (${g.type})`);
    for (const q of it.quasi ?? []) if (!q.text || !it.text.includes(q.text)) bad("quasi span not in text");
    const pr = it.profile;
    if (!pr) bad("missing profile");
    else for (const k of ["name", "city", "employer"] as const) if (!pr[k] || !it.text.includes(pr[k])) bad(`profile ${k} not in text`);
  }
  return issues;
}
