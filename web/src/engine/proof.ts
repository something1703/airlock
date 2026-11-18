// Proof mode (docs/02-ARCHITECTURE.md §6.4, docs/04-PROMPTS.md §7): "Is this a scam?"
//
//   raw message ─► TacticScanner (pattern rules + `tactics.v1`, phone only) ─► red flags + raw claims
//               ─► ClaimExtractor (cleans the claims) ─► SealPipeline (Strict, auto) ─► EgressGate.seal ─► SealedText
//               ─► ClaimCheckEngine (cloud only + Google Search) ─► restore ─► verdict card
//
// The raw message only ever reaches the PhoneOnlyEngine (INV-1, INV-3). The cloud receives each claim as
// SealedText that passed the gate, plus fixed-vocabulary context (tactic ids, a sender type) — never user text.
// Without the on-device model or a connection, the card is built from on-device findings only (INV-9).
import type { AppConfig } from "../core/appConfig";
import { ANALYSIS_OPTIONS, EngineError, type ClaimCheckEngine, type EngineErrorCode, type GroundedResult, type PhoneOnlyEngine } from "./engines";
import { contains, fold } from "./foldedSearch";
import { EgressGate } from "./gate";
import type { ReceiptLedger } from "./ledger";
import { firstJsonObject } from "./llmDetector";
import { normalise } from "./normaliser";
import type { PatternDetector } from "./patterns";
import type { UserOverride } from "./policy";
import { SealPipeline, sealSettings, type SealResult } from "./pipeline";
import type { PromptLibrary } from "./prompts";
import { restore, type RestoreResult } from "./restore";
import type { SealDraft } from "./sealer";
import { EntityMap, renderedLegend, type PlaceholderId, type PrivacyCategory, type SealedText } from "./types";
import { VaultMatcher, type VaultEntry } from "./vault";

// MARK: Vocabularies (fixed — the only non-sealed words that may reach the cloud)

export const TACTIC_IDS = ["urgency", "secrecy", "authority", "fear", "unusual_payment", "credential_request", "link", "too_good", "emotional"] as const;
export type TacticId = (typeof TACTIC_IDS)[number];
const isTacticId = (s: string): s is TacticId => (TACTIC_IDS as readonly string[]).includes(s);

/** Short labels for chips. */
export const TACTIC_LABEL: Record<TacticId, string> = {
  urgency: "Rushes you",
  secrecy: "Asks for secrecy",
  authority: "Claims authority",
  fear: "Uses threats",
  unusual_payment: "Odd way to pay",
  credential_request: "Asks for a code or password",
  link: "Pushes a link",
  too_good: "Too good to be true",
  emotional: "Plays on feelings",
};

/** Why each tactic matters (shown under model-found flags, which have no rule detail). */
export const TACTIC_WHY: Record<TacticId, string> = {
  urgency: "Scammers rush you so you don't stop to check",
  secrecy: "Being told to keep quiet is a common warning sign",
  authority: "Says it's from someone official — check that yourself",
  fear: "Threats are used to make you act without thinking",
  unusual_payment: "Gift cards, crypto and transfers are hard to get back",
  credential_request: "Real organisations don't ask you to send codes or passwords",
  link: "Links in unexpected messages can lead to fake pages",
  too_good: "Unexpected prizes and refunds are a common hook",
  emotional: "Pressure through feelings makes it harder to check",
};

/** Plain English names sent to the cloud in `{{tactics}}` (fixed strings, no user content). */
const TACTIC_PROMPT_NAME: Record<TacticId, string> = {
  urgency: "urgency", secrecy: "secrecy", authority: "authority", fear: "fear", unusual_payment: "unusual payment",
  credential_request: "credential request", link: "link to click or app to install", too_good: "too good to be true", emotional: "emotional pressure",
};

/** How strongly each tactic suggests a scam (pattern findings can weigh more, e.g. a look-alike link). */
const TACTIC_WEIGHT: Record<TacticId, number> = { urgency: 1, secrecy: 2, authority: 1, fear: 2, unusual_payment: 3, credential_request: 3, link: 1, too_good: 2, emotional: 1 };

export const SENDER_TYPES = ["a bank or payment service", "a delivery company", "a government agency", "tech support", "a phone or utility company", "an online shop or service", "an employer or boss", "a family member or friend", "unknown"] as const;
export type SenderType = (typeof SENDER_TYPES)[number];

/** One red flag. `evidence` is a quote from the message — shown on this device only, never sent. */
export interface TacticFlag {
  tactic: TacticId;
  evidence: string | null;
  source: "pattern" | "model";
  /** A fixed explanation from the pattern rules ("Shortened link — you can't see where it goes"). */
  detail: string | null;
  weight: number;
}

// MARK: Pattern pre-checks (deterministic, run first)

const SHORTENERS = new Set(["bit.ly", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "is.gd", "buff.ly", "cutt.ly", "rebrand.ly", "shorturl.at", "tiny.cc", "rb.gy", "t.ly", "s.id", "bl.ink", "shorturl.ca", "v.gd", "qrco.de"]);
const ODD_TLDS = new Set(["xyz", "top", "click", "live", "icu", "online", "site", "link", "support", "tk", "ml", "ga", "cf", "gq", "vip", "club", "win", "loan", "zip", "mov", "rest", "bar", "buzz", "monster", "sbs", "cfd", "cyou", "quest", "info"]);
const BARE_TLDS = "com|net|org|info|biz|io|co|uk|us|ca|au|in|de|fr|ie|nz|ly|me|xyz|top|click|live|icu|online|site|shop|app|link|support|help|gov|edu|ru|cn|tk|ml|ga|cf|gq|cc|ws|vip|club|win|loan|zip|mov|rest|bar|buzz|monster|sbs|cfd|cyou|quest|example";
const URL_RE = new RegExp(String.raw`\b(?:https?://[^\s<>"'()\]]+|www\.[^\s<>"'()\]]+|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:${BARE_TLDS})\b(?:/[^\s<>"'()\]]*)?)`, "gi");
const LOGIN_WORDS = /(?:^|[.-])(?:login|log-in|signin|secure|verify|verification|account|update|support|billing|confirm|auth|wallet|refund|unlock|recover|helpdesk|service)(?:[.-]|$)/;
const GOV_SUFFIX = /\.(?:gov|mil)(?:\.[a-z]{2})?$|\.gc\.ca$|\.europa\.eu$|\.nhs\.uk$/;
const IMPERSONATED = ["paypal", "amazon", "apple", "icloud", "netflix", "microsoft", "google", "usps", "fedex", "dhl", "royalmail", "evri", "hmrc", "irs", "chase", "wellsfargo", "barclays", "hsbc", "santander", "coinbase", "binance", "whatsapp", "facebook", "instagram"];

/** Host of a matched link, lowercase, without `www.`. */
export function linkHost(url: string): string {
  return url.replace(/^https?:\/\//i, "").split(/[/?#:]/)[0]!.toLowerCase().replace(/\.+$/, "").replace(/^www\./, "");
}

/** Registrable domain: last two labels, or three for `co.uk`-style second levels. */
export function registrableDomain(host: string): string {
  const labels = host.split(".");
  if (labels.length <= 2) return host;
  const sld = labels[labels.length - 2]!;
  const tld = labels[labels.length - 1]!;
  const n = tld.length === 2 && ["co", "com", "org", "gov", "ac", "net", "gc", "nhs", "ltd"].includes(sld) ? 3 : 2;
  return labels.slice(-n).join(".");
}

/** Every link in the message with its most worrying property (null = nothing odd about the address itself). */
export function linkFindings(raw: string, senderType: SenderType): { url: string; host: string; detail: string | null; weight: number }[] {
  // Brand-like words: the usual impersonated names, plus capitalised words mid-sentence ("your Examplebank card").
  const brands = new Set(IMPERSONATED);
  for (const m of raw.matchAll(/(?<=[a-z,] )[A-Z][A-Za-z]{3,}\b/g)) brands.add(m[0].toLowerCase());
  const out: { url: string; host: string; detail: string | null; weight: number }[] = [];
  for (const m of raw.matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;:!?]+$/, "");
    const host = linkHost(url);
    if (!host.includes(".")) continue;
    const reg = registrableDomain(host);
    const main = reg.split(".")[0] ?? reg;
    const tld = host.split(".").pop() ?? "";
    let detail: string | null = null;
    let weight = 1;
    const worse = (d: string, w: number): void => {
      if (w > weight || detail === null) { detail = d; weight = Math.max(weight, w); }
    };
    if (SHORTENERS.has(host)) worse("Shortened link — you can't see where it really goes", 2);
    if (ODD_TLDS.has(tld)) worse("Unusual web address ending", 2);
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) worse("Link to a bare number address, not a named website", 3);
    const prefix = host.slice(0, Math.max(0, host.length - reg.length));
    if (LOGIN_WORDS.test(`.${prefix}${main}.`) && main.includes("-")) worse("Link looks like a copy of a login page", 3);
    const labels = host.split(".").slice(0, -1);
    const borrowed = [...brands].find((b) => (labels.includes(b) && main !== b) || (IMPERSONATED.includes(b) && main.includes("-") && main.split("-").includes(b)));
    if (borrowed) worse("The link doesn't match who the message claims to be from", 3);
    if (senderType === "a government agency" && !GOV_SUFFIX.test(host)) worse("Claims to be official, but the link isn't a government website", 3);
    out.push({ url, host, detail, weight });
  }
  return out;
}

interface Rule {
  tactic: TacticId;
  re: RegExp;
  detail: string;
  weight?: number;
  /** A match preceded by these words is a warning, not a request ("never share this code"). */
  negatable?: boolean;
}

const RULES: Rule[] = [
  { tactic: "unusual_payment", re: /\b(?:gift ?cards?|itunes cards?|google play cards?|steam cards?|apple gift|amazon gift|vanilla (?:visa|card)|voucher codes?)\b/i, detail: "Asks for gift cards — real organisations don't take payment this way" },
  { tactic: "unusual_payment", re: /\b(?:bitcoin|btc|ethereum|usdt|tether|crypto(?:currency)? wallet|bc1[a-z0-9]{25,59}|0x[a-f0-9]{40})\b/i, detail: "Asks for cryptocurrency — payments that can't be reversed" },
  { tactic: "unusual_payment", re: /\b(?:western union|moneygram|wire (?:the )?(?:money|transfer|funds)|zelle|venmo|cash ?app|friends and family)\b/i, detail: "Asks for a payment that's hard to get back", weight: 2 },
  { tactic: "credential_request", re: /\b(?:send|share|reply with|text (?:me|us|back)|tell (?:me|us)|give (?:me|us)|read (?:me|us|it|out)|forward|provide)\b[^.!?\n]{0,30}\b(?:code|pin|password|passcode|otp|one[- ]time|login details|security (?:number|question)s?|card details)\b/i, detail: "Real organisations don't ask you to send codes or passwords", negatable: true },
  { tactic: "link", re: /\b(?:anydesk|teamviewer|quick ?support|remote access|install (?:this|the|our) app|download (?:this|the|our) app|\.apk\b)/i, detail: "Asks you to install something or give remote access", weight: 3 },
  { tactic: "urgency", re: /\b(?:within (?:the next )?\d+ ?(?:minutes?|mins?|hours?|hrs?)|immediately|act now|right away|final (?:notice|warning|reminder)|last chance|urgent(?:ly)?|today only|before midnight|expires? today)\b/i, detail: "A deadline that leaves no time to check" },
  { tactic: "fear", re: /\b(?:(?:account|card|access|number)\s+(?:has been|is|will be|was)\s+(?:locked|suspended|frozen|closed|blocked|disabled|restricted)|arrest(?:ed)?|warrant|legal action|lawsuit|prosecut\w*|penalt(?:y|ies)|deport\w*)\b/i, detail: "Threats of a loss, a fine or the police" },
  { tactic: "secrecy", re: /\b(?:don'?t tell|do not tell|keep (?:this|it) (?:between us|secret|quiet|confidential|to yourself)|tell no ?one|don'?t mention)\b/i, detail: "Being told to keep quiet is a common warning sign" },
  { tactic: "too_good", re: /\b(?:you(?:'ve| have) (?:won|been selected)|claim your (?:prize|reward|refund|gift)|lottery|jackpot|guaranteed (?:returns?|profits?)|double your money|risk[- ]free (?:returns?|investment))\b/i, detail: "A prize, refund or easy money you didn't expect" },
  { tactic: "emotional", re: /\b(?:hi (?:mum|mom|dad)\b|new number|lost my phone|broke my phone|family emergency|i'?m in (?:trouble|hospital|jail))/i, detail: "A sudden personal emergency or new number" },
  { tactic: "authority", re: /\b(?:police|irs|hmrc|tax office|social security|federal|fraud (?:team|department)|security team|tech support|microsoft support|apple support)\b/i, detail: "Says it's from an official body — check that yourself" },
];

function negated(text: string, at: number): boolean {
  const before = text.slice(Math.max(0, at - 24), at).toLowerCase();
  return /\b(?:never|don'?t|do not|won'?t|will not|no one should|nobody will)\b[^.!?]*$/.test(before);
}

/** Deterministic red flags (docs/04-PROMPTS.md §7: link mismatch, shortened URLs, gift cards, crypto, OTP requests …). */
export function patternTactics(raw: string, senderType = senderTypeOf(raw)): TacticFlag[] {
  const flags: TacticFlag[] = [];
  for (const rule of RULES) {
    for (const m of raw.matchAll(new RegExp(rule.re.source, rule.re.flags.includes("g") ? rule.re.flags : rule.re.flags + "g"))) {
      if (rule.negatable && negated(raw, m.index ?? 0)) continue;
      flags.push({ tactic: rule.tactic, evidence: m[0].trim(), source: "pattern", detail: rule.detail, weight: rule.weight ?? TACTIC_WEIGHT[rule.tactic] });
      break;
    }
  }
  for (const l of linkFindings(raw, senderType)) {
    if (l.detail) flags.push({ tactic: "link", evidence: l.url, source: "pattern", detail: l.detail, weight: l.weight });
  }
  return flags;
}

// MARK: Sender type (rules, on device)

/** Keyword lists per sender type; on a tie the earlier type wins (a "customs fee" on a parcel is a delivery text). */
const SENDER_WORDS: [SenderType, RegExp][] = [
  ["a delivery company", /\b(?:parcel|package|delivery|deliver|courier|shipment|shipping|usps|ups|fedex|dhl|royal mail|evri|redelivery|tracking)\b/gi],
  ["a bank or payment service", /\b(?:bank(?! holiday)|banking|card|credit union|debit|visa|mastercard|paypal|account number|overdraft|statement|transfer|payee)\b/gi],
  ["a government agency", /\b(?:tax|irs|hmrc|revenue|government|police|court|fine|social security|dmv|council|immigration|visa application|customs|benefits?|refund from|federal)\b/gi],
  ["tech support", /\b(?:tech support|microsoft|windows|virus|malware|your computer|icloud|apple id|antivirus|hacked)\b/gi],
  ["a phone or utility company", /\b(?:electricity|energy|gas bill|water bill|broadband|phone bill|mobile plan|carrier|utility|meter)\b/gi],
  ["an online shop or service", /\b(?:order|subscription|netflix|amazon|prime|membership|purchase|prize|reward|voucher|store)\b/gi],
  ["an employer or boss", /\b(?:boss|ceo|manager|hr department|payroll|the team|my meeting|in a meeting|colleague|job offer|recruit\w*)\b/gi],
  ["a family member or friend", /\b(?:mum|mom|dad|grandma|grandpa|son|daughter|it'?s me|new number|lost my phone|love you|darling|sweetheart)\b/gi],
];

/** Who the message claims to come from, as one of `SENDER_TYPES` (a fixed phrase, safe to send). */
export function senderTypeOf(raw: string): SenderType {
  let best: SenderType = "unknown";
  let bestCount = 0;
  for (const [type, re] of SENDER_WORDS) {
    const count = [...raw.matchAll(re)].length;
    if (count > bestCount) { best = type; bestCount = count; }
  }
  return best;
}

// MARK: TacticScanner (`tactics.v1`, phone only)

/** Longest message `tactics.v1` reads (Chrome's on-device window, with room for output). Patterns read it all. */
export const MAX_TACTICS_INPUT = 8000;

export interface TacticScan {
  flags: TacticFlag[];
  /** Raw claims from the on-device model — derived from the message, so they must be sealed before leaving. */
  claims: string[];
  senderType: SenderType;
  modelStatus: "ok" | "unavailable" | "failed";
}

/** Keeps a model-reported tactic only if its evidence is really in the message (drops hallucinations). */
function verifiedEvidence(evidence: string, raw: string): string | null | false {
  const e = evidence.trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, "");
  if (!e) return false;
  if (contains(e, raw)) return e.length > 140 ? `${e.slice(0, 137)}…` : e;
  const words = fold(e).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3);
  if (!words.length) return false;
  const hay = fold(raw);
  const found = words.filter((w) => hay.includes(w)).length;
  return found / words.length >= 0.67 ? null : false;
}

/** Parses `tactics.v1` output. Returns null if it isn't the expected JSON. */
export function parseTacticsOutput(output: string, raw: string): { flags: TacticFlag[]; claims: string[] } | null {
  const json = firstJsonObject(output);
  if (!json) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as { tactics?: unknown; claims?: unknown };
  const flags: TacticFlag[] = [];
  if (Array.isArray(o.tactics)) {
    for (const t of o.tactics) {
      if (!t || typeof t !== "object") continue;
      const id = String((t as { tactic?: unknown }).tactic ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
      if (!isTacticId(id)) continue;
      const ev = verifiedEvidence(String((t as { evidence?: unknown }).evidence ?? ""), raw);
      if (ev === false) continue;
      flags.push({ tactic: id, evidence: ev, source: "model", detail: null, weight: TACTIC_WEIGHT[id] });
    }
  }
  const claims = Array.isArray(o.claims) ? o.claims.filter((c): c is string => typeof c === "string") : [];
  return { flags, claims };
}

/** Pattern flags first, then model flags for tactics the patterns didn't find. */
export function mergeFlags(pattern: TacticFlag[], model: TacticFlag[]): TacticFlag[] {
  const out = [...pattern];
  for (const f of model) if (!out.some((x) => x.tactic === f.tactic)) out.push(f);
  return out;
}

export class TacticScanner {
  constructor(
    private readonly phone: PhoneOnlyEngine,
    private readonly prompts: PromptLibrary,
  ) {}

  async scan(raw: string): Promise<TacticScan> {
    const senderType = senderTypeOf(raw);
    const pattern = patternTactics(raw, senderType);
    let modelStatus: TacticScan["modelStatus"] = "ok";
    let model: { flags: TacticFlag[]; claims: string[] } | null = null;
    if ((await this.phone.availability()) !== "available") modelStatus = "unavailable";
    else {
      try {
        const prompt = this.prompts.render("tactics.v1", { message: raw.slice(0, MAX_TACTICS_INPUT) });
        model = parseTacticsOutput((await this.phone.respond({ promptId: "tactics.v1", text: prompt }, ANALYSIS_OPTIONS)).text, raw);
        if (!model) modelStatus = "failed";
      } catch (e) {
        modelStatus = e instanceof EngineError && e.code === "unavailable" ? "unavailable" : "failed";
      }
    }
    return { flags: mergeFlags(pattern, model?.flags ?? []), claims: extractClaims(model?.claims ?? []), senderType, modelStatus };
  }
}

// MARK: ClaimExtractor

export const MAX_CLAIMS = 3;

/** Cleans the model's claims: one line each, sensible length, no duplicates, at most `MAX_CLAIMS`. */
export function extractClaims(claims: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of claims) {
    const line = normalise(c.replace(/[\r\n]+/g, " ")).text.trim().replace(/^[-*•\d.)\s]+/, "").trim();
    if (line.length < 8 || !/\p{L}/u.test(line)) continue;
    const clipped = line.length > 240 ? `${line.slice(0, 237).trimEnd()}…` : line;
    const key = fold(clipped);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clipped);
    if (out.length === MAX_CLAIMS) break;
  }
  return out;
}

// MARK: Sealing claims

export type SealedClaim = { claim: string; sealed: SealedText } | { claim: string; sealed: null };

/**
 * Seals the claims on the device: the full pipeline (Strict) over all claims at once, plus every Vault name
 * and rule-detected detail from the *whole message* protected wherever it reappears; then each claim line goes
 * through `EgressGate.seal` on its own. A claim the gate blocks stays on the device (`sealed: null`).
 * Returns null if the on-device model couldn't read the claims (INV-9: nothing is sent).
 */
export async function sealClaims(raw: string, claims: readonly string[], deps: Pick<ProofDeps, "phone" | "patterns" | "vault" | "prompts" | "config">): Promise<{ claims: SealedClaim[]; result: SealResult } | null> {
  const settings = sealSettings(deps.config, { dial: "strict", taskSummary: "checking whether a message they received is a scam" });
  const pipeline = new SealPipeline(deps.phone, deps.patterns, deps.vault, deps.prompts, settings);
  const text = claims.join("\n");
  let result: SealResult;
  try {
    result = await pipeline.run(text);
  } catch {
    return null;
  }
  if (result.reasons.some((r) => r.kind === "phoneUnavailable" || r.kind === "llmFailed" || r.kind === "refused")) return null;
  // Details found anywhere in the message (Vault names, contacts, IDs, codes, addresses) stay sealed in the claims too.
  const fromMessage = [...new VaultMatcher(deps.vault).detect(raw), ...deps.patterns.detect(raw)].filter((c) => c.category !== "date" && c.category !== "quasi");
  let overrides = new Map<PlaceholderId, UserOverride>();
  for (const c of fromMessage) {
    if (!contains(c.text, result.normalised.text)) continue;
    ({ result, overrides } = pipeline.protect(result, c.text, c.category as Exclude<PrivacyCategory, "quasi">, overrides, result.acceptedRisks));
  }
  const gate = new EgressGate(deps.patterns, deps.vault);
  const lines = result.draft.text.split("\n");
  const perLine = lines.length === claims.length;
  const units = perLine ? lines.map((l, i) => ({ claim: claims[i]!, text: l.trim() })) : [{ claim: claims.join(" "), text: result.draft.text.replace(/\n+/g, " ").trim() }];
  const sealed: SealedClaim[] = units.map(({ claim, text: line }) => {
    const used = new Set([...line.matchAll(/\[\[([A-Z]+_(?:\d+|ME))\]\]/g)].map((m) => m[1]!));
    const draft: SealDraft = { ...result.draft, text: line, legend: result.draft.legend.filter((l) => used.has(l.placeholder)), replacements: [] };
    try {
      return { claim, sealed: gate.seal(draft) };
    } catch {
      return { claim, sealed: null };
    }
  });
  return { claims: sealed, result };
}

// MARK: claimcheck.v1

/** Renders `claimcheck.v1`. `{{sealed_claims}}` is exactly the gate-checked outbound text (value + legend). */
export function claimCheckPrompt(prompts: PromptLibrary, sealed: SealedText, ctx: { tactics: readonly TacticId[]; senderType: SenderType }): string {
  const claims = sealed.legend.length ? `${sealed.value}\n\n${renderedLegend(sealed)}` : sealed.value;
  const tactics = ctx.tactics.length ? [...new Set(ctx.tactics)].map((t) => TACTIC_PROMPT_NAME[t]).join(", ") : "none found";
  return prompts.render("claimcheck.v1", { sealed_claims: claims, tactics, sender_type: ctx.senderType === "unknown" ? "unknown" : ctx.senderType });
}

export type ClaimVerdict = "LIKELY_SCAM" | "UNCLEAR" | "LIKELY_LEGIT";

/** One line of the answer, with where it sits in the model text (for inline grounding citations). */
export interface AnswerItem {
  text: string;
  start: number;
  end: number;
}

export interface ParsedCheck {
  verdict: ClaimVerdict;
  why: AnswerItem[];
  do: AnswerItem[];
  dont: AnswerItem[];
}

const HEADER = /^[\s>#*_-]*(VERDICT|WHY|DON['’]?T|DO NOT|DO)\b[\s*_]*[:：–-][\s*_]*/i;

/** Parses the VERDICT / WHY / DO / DONT format. Tolerates markdown, bullets and inline lists. */
export function parseClaimCheck(text: string): ParsedCheck {
  const sections: Record<"VERDICT" | "WHY" | "DO" | "DONT", AnswerItem[]> = { VERDICT: [], WHY: [], DO: [], DONT: [] };
  let current: keyof typeof sections | null = null;
  let offset = 0;
  for (const line of text.split("\n")) {
    const lineStart = offset;
    offset += line.length + 1;
    let body = line;
    let bodyStart = lineStart;
    const h = HEADER.exec(line);
    if (h) {
      const name = h[1]!.toUpperCase().replace(/['’]/g, "");
      current = name === "DO NOT" ? "DONT" : (name as keyof typeof sections);
      body = line.slice(h[0].length);
      bodyStart = lineStart + h[0].length;
    }
    if (!current) continue;
    for (const part of current === "DO" || current === "DONT" ? splitInline(body, bodyStart) : [{ text: body, start: bodyStart }]) {
      const bullet = /^[\s>*_-]*(?:[-*•·]|\d+[.)])?\s*/.exec(part.text)?.[0] ?? "";
      const clean = part.text.slice(bullet.length).replace(/\*\*|__/g, "").trim();
      if (clean) sections[current].push({ text: clean, start: part.start + bullet.length, end: part.start + part.text.length });
    }
  }
  const verdictText = sections.VERDICT.map((x) => x.text).join(" ") || text;
  const v = /LIKELY[\s_]*SCAM|LIKELY[\s_]*LEGIT|UNCLEAR/i.exec(verdictText)?.[0].toUpperCase().replace(/\s+/g, "_");
  const verdict: ClaimVerdict = v === "LIKELY_SCAM" || v === "LIKELY_LEGIT" ? v : "UNCLEAR";
  return { verdict, why: sections.WHY, do: sections.DO.slice(0, 4), dont: sections.DONT.slice(0, 3) };
}

function splitInline(body: string, start: number): { text: string; start: number }[] {
  if (!/;\s/.test(body)) return [{ text: body, start }];
  const out: { text: string; start: number }[] = [];
  let at = 0;
  for (const piece of body.split(/;\s+/)) {
    const idx = body.indexOf(piece, at);
    out.push({ text: piece, start: start + idx });
    at = idx + piece.length;
  }
  return out;
}

// MARK: Grounding display

/** A grounding source as shown: numbered in the order Gemini cited them. */
export interface NumberedSource {
  n: number;
  title: string;
  uri: string;
}

export interface CitedItem {
  /** Model text (placeholders) — restored for display. */
  modelText: string;
  restored: RestoreResult;
  /** Source numbers supporting this line (inline grounding support). */
  cites: number[];
}

/** Only http(s) links are shown (a source can never become `javascript:`). */
export function safeHttpUrl(uri: string): string | null {
  try {
    const u = new URL(uri);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Numbers the usable sources and attaches inline citations to each answer line that a support overlaps. */
export function cite(modelText: string, items: AnswerItem[], grounded: Pick<GroundedResult, "sources" | "supports">): { sources: NumberedSource[]; cites: number[][] } {
  const byChunk = new Map<number, number>();
  const sources: NumberedSource[] = [];
  const byUri = new Map<string, number>();
  for (const s of [...grounded.sources].sort((a, b) => a.chunkIndex - b.chunkIndex)) {
    const uri = safeHttpUrl(s.uri);
    if (!uri) continue;
    let n = byUri.get(uri);
    if (n === undefined) {
      n = sources.length + 1;
      byUri.set(uri, n);
      sources.push({ n, title: s.title.trim() || new URL(uri).hostname, uri });
    }
    byChunk.set(s.chunkIndex, n);
  }
  const cites = items.map(() => new Set<number>());
  for (const sup of grounded.supports) {
    const t = sup.text.trim();
    if (!t) continue;
    const at = modelText.indexOf(t);
    if (at < 0) continue;
    const end = at + t.length;
    items.forEach((it, i) => {
      if (it.start < end && at < it.end) for (const c of sup.chunkIndices) {
        const n = byChunk.get(c);
        if (n !== undefined) cites[i]!.add(n);
      }
    });
  }
  return { sources, cites: cites.map((c) => [...c].sort((a, b) => a - b)) };
}

// MARK: Results

export interface ClaimFinding {
  verdict: ClaimVerdict;
  why: CitedItem[];
  do: CitedItem[];
  dont: CitedItem[];
  sources: NumberedSource[];
  /** Google's Search Suggestions snippet; must be shown with this finding, unmodified. */
  searchEntryPointHtml: string | null;
  webSearchQueries: string[];
  modelVersion: string;
  latencyMs: number;
}

export type ClaimOutcome =
  | { status: "checked"; claim: string; sealed: SealedText; finding: ClaimFinding; receiptId: string | null }
  /** The gate blocked it: the claim still looked private, so it stayed on this device. */
  | { status: "kept"; claim: string }
  | { status: "failed"; claim: string; sealed: SealedText; error: EngineErrorCode }
  /** Sealed, but not sent (offline or no cloud). */
  | { status: "notSent"; claim: string; sealed: SealedText | null };

export type Verdict = "likelyScam" | "unsure" | "looksLegit";

export type ProofMode =
  /** At least one claim was checked against the web. */
  | "checked"
  | "offline"
  /** The on-device model is unavailable or failed — rules only, nothing sent (INV-9). */
  | "onDeviceUnavailable"
  /** No checkable claims. */
  | "noClaims"
  /** Every claim still looked private after sealing — nothing sent. */
  | "allKept"
  | "cloudFailed"
  /** No cloud engine (no Firebase config) or Proof switched off in Remote Config. */
  | "noCloud";

export interface ProofResult {
  mode: ProofMode;
  verdict: Verdict;
  score: number;
  flags: TacticFlag[];
  senderType: SenderType;
  claims: ClaimOutcome[];
  /** Placeholder → real value for the claims (local only, used to restore answers). */
  entities: EntityMap;
  /** The cloud error behind `cloudFailed` (a code, never content). */
  cloudError: EngineErrorCode | null;
  elapsedMs: number;
}

/** Sum of the strongest flag per tactic. */
export function tacticScore(flags: readonly TacticFlag[]): number {
  const best = new Map<TacticId, number>();
  for (const f of flags) best.set(f.tactic, Math.max(best.get(f.tactic) ?? 0, f.weight));
  return [...best.values()].reduce((a, b) => a + b, 0);
}

/** At or above this, the red flags alone make a message look like a scam. */
export const STRONG_SCORE = 5;

/**
 * Combines on-device red flags with the web check. Never "Looks legitimate" without a web check, and never
 * over strong red flags. Copy built on this must still say Airlock can't be sure.
 */
export function aggregateVerdict(flags: readonly TacticFlag[], findings: readonly ClaimVerdict[]): Verdict {
  const score = tacticScore(flags);
  if (!findings.length) return score >= STRONG_SCORE ? "likelyScam" : "unsure";
  if (findings.includes("LIKELY_SCAM")) return "likelyScam";
  if (score >= STRONG_SCORE) return findings.every((f) => f === "LIKELY_LEGIT") ? "unsure" : "likelyScam";
  if (findings.every((f) => f === "LIKELY_LEGIT")) return "looksLegit";
  if (score === 0 && findings.some((f) => f === "LIKELY_LEGIT")) return "looksLegit";
  return "unsure";
}

export type ProofStage = "scanning" | "sealing" | "checking" | "done";

export interface ProofDeps {
  phone: PhoneOnlyEngine;
  claimCheck: ClaimCheckEngine | null;
  patterns: PatternDetector;
  vault: readonly VaultEntry[];
  prompts: PromptLibrary;
  config: AppConfig;
  online: boolean;
  /** Each claim that reaches Gemini gets a receipt in the local chain. */
  ledger?: ReceiptLedger;
  threadId?: string;
}

const toFinding = (g: GroundedResult, entities: EntityMap): ClaimFinding => {
  const parsed = parseClaimCheck(g.text);
  const items = [...parsed.why, ...parsed.do, ...parsed.dont];
  const { sources, cites } = cite(g.text, items, g);
  const ctx = { entities };
  let k = 0;
  const wrap = (xs: AnswerItem[]): CitedItem[] => xs.map((x) => ({ modelText: x.text, restored: restore(x.text, ctx), cites: cites[k++] ?? [] }));
  return {
    verdict: parsed.verdict, why: wrap(parsed.why), do: wrap(parsed.do), dont: wrap(parsed.dont), sources,
    searchEntryPointHtml: g.searchEntryPointHtml, webSearchQueries: g.webSearchQueries, modelVersion: g.modelVersion, latencyMs: g.latencyMs,
  };
};

/** The whole Proof flow. Pure apart from the engines it is given (unit-tested with mocks). */
export async function runProof(raw: string, deps: ProofDeps, onStage: (s: ProofStage) => void = () => {}): Promise<ProofResult> {
  const t0 = performance.now();
  const message = normalise(raw).text.trim();
  onStage("scanning");
  const scan = await new TacticScanner(deps.phone, deps.prompts).scan(message);
  const tactics = [...new Set(scan.flags.map((f) => f.tactic))];
  const base = { flags: scan.flags, senderType: scan.senderType, score: tacticScore(scan.flags), entities: new EntityMap(), cloudError: null };
  const done = (mode: ProofMode, claims: ClaimOutcome[], extra: Partial<ProofResult> = {}): ProofResult => {
    onStage("done");
    const findings = claims.flatMap((c) => (c.status === "checked" ? [c.finding.verdict] : []));
    return { ...base, mode, claims, verdict: aggregateVerdict(scan.flags, findings), elapsedMs: performance.now() - t0, ...extra };
  };
  if (scan.modelStatus !== "ok") return done("onDeviceUnavailable", []);
  if (!scan.claims.length) return done("noClaims", []);

  onStage("sealing");
  const sealedClaims = await sealClaims(message, scan.claims, deps);
  if (!sealedClaims) return done("onDeviceUnavailable", []);
  const entities = sealedClaims.result.draft.entities;
  const notSent = (): ClaimOutcome[] => sealedClaims.claims.map((c) => (c.sealed ? { status: "notSent", claim: c.claim, sealed: c.sealed } : { status: "kept", claim: c.claim }));
  if (!sealedClaims.claims.some((c) => c.sealed)) return done("allKept", notSent(), { entities });
  if (!deps.claimCheck || !deps.config.bool("feature_proof")) return done("noCloud", notSent(), { entities });
  if (!deps.online) return done("offline", notSent(), { entities });

  onStage("checking");
  const ctx = { tactics, senderType: scan.senderType };
  const armor = deps.config.armorExpected ? "pass" : "notConfigured";
  const threadId = deps.threadId ?? "proof";
  const sealMs = performance.now() - t0;
  const outcomes = await Promise.all(sealedClaims.claims.map(async (c): Promise<ClaimOutcome> => {
    if (!c.sealed) return { status: "kept", claim: c.claim };
    const sealed = c.sealed;
    const started = performance.now();
    try {
      const g = await deps.claimCheck!.check(sealed, ctx);
      const receipt = deps.ledger ? await deps.ledger.append(sealed, threadId, "cloudOnly", g.modelVersion, armor, sealMs, g.latencyMs) : null;
      return { status: "checked", claim: c.claim, sealed, finding: toFinding(g, entities), receiptId: receipt?.id ?? null };
    } catch (e) {
      const code = e instanceof EngineError ? e.code : "other";
      if (code === "armorBlocked" && deps.ledger) await deps.ledger.append(sealed, threadId, "cloudOnly", "blocked", "blocked", sealMs, performance.now() - started);
      return { status: "failed", claim: c.claim, sealed, error: code };
    }
  }));
  if (outcomes.some((o) => o.status === "checked")) return done("checked", outcomes, { entities });
  const errors = outcomes.flatMap((o) => (o.status === "failed" ? [o.error] : []));
  if (errors.includes("offline")) return done("offline", outcomes, { entities });
  return done("cloudFailed", outcomes, { entities, cloudError: errors[0] ?? "other" });
}

// MARK: Share warning

const SHARE_PHRASE: Record<TacticId, string> = {
  urgency: "rushes you to act",
  secrecy: "asks you to keep it secret",
  authority: "claims to be from an official organisation",
  fear: "threatens you with a locked account, a fine or the police",
  unusual_payment: "asks for an unusual payment, like gift cards or crypto",
  credential_request: "asks for a code, PIN or password",
  link: "pushes you to click a link or install something",
  too_good: "promises a prize, refund or easy money",
  emotional: "plays on your feelings",
};

/**
 * A friendly heads-up for family, built only from fixed phrases (tactics and sender type) — no names,
 * links, numbers or quotes from the message, and none of Gemini's grounded text. Null for "Looks legitimate".
 */
export function shareWarning(r: Pick<ProofResult, "verdict" | "flags" | "senderType">): string | null {
  if (r.verdict === "looksLegit") return null;
  const kind = r.verdict === "likelyScam" ? "a message that looks like a scam" : "a suspicious message";
  const from = r.senderType === "unknown" ? "" : ` It claimed to be from ${r.senderType}.`;
  const phrases = [...new Set(r.flags.map((f) => f.tactic))].map((t) => SHARE_PHRASE[t]);
  const list = phrases.length === 0 ? "" : phrases.length === 1 ? ` It ${phrases[0]}.` : ` It ${phrases.slice(0, -1).join(", ")} and ${phrases.at(-1)}.`;
  return `Heads up: I got ${kind}.${from}${list} If you get one like it, don't reply, click links or share codes. Contact the organisation using a number from their official website, not the message.`;
}
