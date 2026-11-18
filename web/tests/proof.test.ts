import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AppConfig } from "../src/core/appConfig";
import { ALL_CATEGORIES, ALL_GATE_CHECKS, renderedLegend } from "../src/engine/types";
import type { ClaimContext, GroundedResult } from "../src/engine/engines";
import { ReceiptLedger } from "../src/engine/ledger";
import { MockClaimCheckEngine, MockPhoneEngine } from "../src/engine/mocks";
import { PatternDetector } from "../src/engine/patterns";
import { PromptLibrary } from "../src/engine/prompts";
import {
  aggregateVerdict, cite, claimCheckPrompt, extractClaims, linkFindings, parseClaimCheck, parseTacticsOutput, patternTactics, runProof,
  safeHttpUrl, sealClaims, senderTypeOf, shareWarning, tacticScore, TACTIC_IDS, type ProofDeps, type ProofResult,
} from "../src/engine/proof";
import type { VaultEntry } from "../src/engine/vault";

interface Fixture {
  id: string;
  kind: "scam" | "legit";
  message: string;
  model: { tactics: { tactic: string; evidence: string }[]; claims: string[] };
  entities: { text: string; type: string }[];
  cloud: string;
  sensitive: string[];
  expect: ProofResult["verdict"][];
}
const FIXTURES = (JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures/proof/messages.json"), "utf8")) as { messages: Fixture[] }).messages;

const prompts = new PromptLibrary();
const patterns = new PatternDetector();
const config = new AppConfig();
const VAULT: VaultEntry[] = [{ id: "me", canonical: "Maya Chen", aliases: ["Maya"], category: "person", roleHint: "me", isUser: true }];

/** The message inside a rendered prompt (between <<< and >>>). */
const inner = (prompt: string): string => prompt.split("<<<\n")[1]?.split("\n>>>")[0] ?? "";

/** A scripted on-device model: tactics.v1 → the fixture's answer; detect.v1 → the fixture's entities found in the chunk. */
function phoneFor(f: Pick<Fixture, "model" | "entities">, avail: "available" | "unavailable" = "available"): MockPhoneEngine {
  return new MockPhoneEngine((id, text) => {
    if (id === "tactics.v1") return JSON.stringify(f.model);
    if (id === "detect.v1") {
      const chunk = inner(text);
      return JSON.stringify({ items: f.entities.filter((e) => chunk.includes(e.text)).map((e) => ({ text: e.text, type: e.type })) });
    }
    if (id === "gen.v1") return JSON.stringify({ rewrite: /bank/i.test(text) ? "a bank" : "an organisation" });
    if (id === "attack.v1") return JSON.stringify({ guesses: [] });
    return "{}";
  }, avail);
}

const SOURCES: Pick<GroundedResult, "sources" | "supports" | "searchEntryPointHtml" | "webSearchQueries"> = {
  sources: [
    { chunkIndex: 0, title: "consumer-advice.example", uri: "https://consumer-advice.example/scams" },
    { chunkIndex: 1, title: "bad", uri: "javascript:alert(1)" },
    { chunkIndex: 2, title: "regulator.example", uri: "https://regulator.example/warnings" },
  ],
  supports: [],
  searchEntryPointHtml: "<style>.c{color:red}</style><div class=\"c\"><a href=\"https://www.google.com/search?q=scam\">scam</a></div>",
  webSearchQueries: ["text message scam"],
};

function cloudFor(f: Pick<Fixture, "cloud">): MockClaimCheckEngine {
  return new MockClaimCheckEngine(() => ({ text: f.cloud, ...SOURCES, supports: [{ text: f.cloud.split("\n")[1]!.replace(/^WHY: /, "").split(". ")[0]!, chunkIndices: [0, 2] }] }));
}

function deps(f: Fixture, over: Partial<ProofDeps> = {}): ProofDeps & { phone: MockPhoneEngine; claimCheck: MockClaimCheckEngine } {
  return { phone: phoneFor(f), claimCheck: cloudFor(f), patterns, vault: VAULT, prompts, config, online: true, ...over } as ProofDeps & { phone: MockPhoneEngine; claimCheck: MockClaimCheckEngine };
}

/** Everything that reached the cloud engine, as it would be sent (the rendered claimcheck.v1 prompts). */
function outbound(cc: MockClaimCheckEngine): string[] {
  return cc.received.map(({ sealed, context }) => claimCheckPrompt(prompts, sealed, context));
}

describe("Proof fixtures (WP-18 acceptance: 10 scam + 5 legitimate)", () => {
  it("has 10 scam and 5 legitimate fictional messages", () => {
    expect(FIXTURES.filter((f) => f.kind === "scam")).toHaveLength(10);
    expect(FIXTURES.filter((f) => f.kind === "legit")).toHaveLength(5);
  });

  for (const f of FIXTURES) {
    it(`${f.id}: sensible verdict with the web check`, async () => {
      const d = deps(f);
      const r = await runProof(f.message, d);
      expect(r.mode).toBe("checked");
      expect(f.expect).toContain(r.verdict);
      if (f.kind === "legit") expect(r.verdict).not.toBe("likelyScam");
      if (f.kind === "scam") expect(r.verdict).not.toBe("looksLegit");
      const checked = r.claims.filter((c) => c.status === "checked");
      expect(checked.length).toBe(f.model.claims.length);
      for (const c of checked) {
        if (c.status !== "checked") continue;
        expect(c.finding.why.length).toBeGreaterThan(0);
        // javascript: sources are never shown; the rest are numbered 1..n.
        expect(c.finding.sources.map((s) => s.uri)).toEqual(["https://consumer-advice.example/scams", "https://regulator.example/warnings"]);
        expect(c.finding.why[0]!.cites).toEqual([1, 2]);
        expect(c.finding.searchEntryPointHtml).toContain("google.com/search");
      }
    });

    it(`${f.id}: INV-1 — only sealed, gate-checked claims reach the cloud; the raw message never does`, async () => {
      const d = deps(f);
      await runProof(f.message, d);
      // The raw message went only to the phone-only engine (tactics.v1).
      expect(d.phone.calls.some((c) => c.promptId === "tactics.v1" && c.text.includes(f.message))).toBe(true);
      expect(d.claimCheck.received.length).toBeGreaterThan(0);
      for (const { sealed, context } of d.claimCheck.received) {
        expect(sealed.gateReport.bypassed).toBe(false);
        expect([...sealed.gateReport.checksPassed].sort()).toEqual([...ALL_GATE_CHECKS]);
        expect(Object.isFrozen(sealed)).toBe(true);
        for (const t of context.tactics) expect(TACTIC_IDS).toContain(t);
      }
      for (const text of outbound(d.claimCheck)) {
        expect(text).not.toContain(f.message);
        for (const s of f.sensitive) expect(text).not.toContain(s);
        for (const e of f.entities) expect(text).not.toContain(e.text);
      }
    });

    it(`${f.id}: sensible verdict from on-device red flags alone (offline)`, async () => {
      const d = deps(f, { online: false });
      const r = await runProof(f.message, d);
      expect(r.mode).toBe("offline");
      expect(d.claimCheck.received).toHaveLength(0);
      expect(r.verdict).not.toBe("looksLegit"); // never without a web check
      if (f.kind === "legit") expect(r.verdict).toBe("unsure");
      if (f.kind === "scam") expect(r.flags.length).toBeGreaterThanOrEqual(2);
    });
  }

  it("most scams are already 'Likely a scam' from red flags alone; no legitimate message is", async () => {
    let strong = 0;
    for (const f of FIXTURES) {
      const r = await runProof(f.message, deps(f, { online: false }));
      if (f.kind === "scam" && r.verdict === "likelyScam") strong++;
      if (f.kind === "legit") expect(r.score).toBeLessThan(2);
    }
    expect(strong).toBeGreaterThanOrEqual(7);
  });

  it("pattern rules alone (on-device model unavailable) never call the cloud (INV-9)", async () => {
    for (const f of FIXTURES) {
      const d = deps(f, { phone: phoneFor(f, "unavailable") });
      const r = await runProof(f.message, d);
      expect(r.mode).toBe("onDeviceUnavailable");
      expect(d.claimCheck.received).toHaveLength(0);
      expect(r.claims).toHaveLength(0);
      if (f.kind === "legit") expect(r.verdict).not.toBe("likelyScam");
    }
  });

  it("restores placeholders in Gemini's answer on the device", async () => {
    const f = FIXTURES.find((x) => x.id === "scam-boss-gift-cards")!;
    const d = deps(f);
    const r = await runProof(f.message, d);
    const c = r.claims.find((x) => x.status === "checked");
    if (c?.status !== "checked") throw new Error("expected a checked claim");
    expect(c.claim).toContain("Dana Whitfield");
    expect(c.sealed.value).toContain("[[PERSON_1]]");
    expect(c.finding.do[0]!.restored.text).toContain("Dana Whitfield");
    expect(c.finding.do[0]!.modelText).toContain("[[PERSON_1]]");
  });

  it("writes a receipt for every claim sent, with the outbound hash", async () => {
    const f = FIXTURES[0]!;
    const ledger = new ReceiptLedger();
    const d = deps(f, { ledger, threadId: "proof-test" });
    const r = await runProof(f.message, d);
    const sent = r.claims.filter((c) => c.status === "checked");
    expect(ledger.receipts).toHaveLength(sent.length);
    for (const c of sent) if (c.status === "checked") expect(ledger.receipts.find((x) => x.id === c.receiptId)?.outboundSha256).toBe(c.sealed.gateReport.outboundSha256);
    expect(ledger.verify().valid).toBe(true);
    for (const rc of ledger.receipts) for (const s of f.sensitive) expect(rc.outboundText ?? "").not.toContain(s);
  });
});

describe("Proof sealing", () => {
  it("a claim repeating the user's Vault name is sealed before it can leave", async () => {
    const f = { model: { tactics: [], claims: ["Maya Chen owes a parcel fee"] }, entities: [] };
    const out = await sealClaims("Dear Maya Chen, pay the fee.", ["Maya Chen owes a parcel fee"], { phone: phoneFor(f), patterns, vault: VAULT, prompts, config });
    const s = out!.claims[0]!.sealed!;
    expect(s.value).not.toMatch(/Maya|Chen/);
    expect(renderedLegend(s)).not.toMatch(/Maya|Chen/);
  });

  it("details found anywhere in the message stay sealed when a claim repeats them", async () => {
    const message = "Call 312-555-0147 now or your account will be closed.";
    const claims = ["The bank wants a call to 312-555-0147"];
    const f = { model: { tactics: [], claims }, entities: [] };
    const out = await sealClaims(message, claims, { phone: phoneFor(f), patterns, vault: [], prompts, config });
    expect(out!.claims[0]!.sealed!.value).not.toContain("312-555");
  });

  it("a claim the gate blocks stays on the device ('kept') and nothing is sent", async () => {
    // Cyrillic "а" inside a Latin name: a mixed-script word the detectors don't read as a name; the gate (G6) blocks it.
    const claim = "Mаya must pay the fee today";
    const f: Fixture = { id: "x", kind: "scam", message: `Hi ${claim}`, model: { tactics: [], claims: [claim] }, entities: [], cloud: "VERDICT: UNCLEAR", sensitive: [], expect: ["unsure"] };
    const d = deps(f);
    const r = await runProof(f.message, d);
    expect(r.mode).toBe("allKept");
    expect(r.claims[0]!.status).toBe("kept");
    expect(d.claimCheck.received).toHaveLength(0);
  });

  it("no cloud engine or Proof switched off → nothing sent", async () => {
    const f = FIXTURES[0]!;
    const r1 = await runProof(f.message, deps(f, { claimCheck: null }));
    expect(r1.mode).toBe("noCloud");
    const d = deps(f, { config: new AppConfig({ feature_proof: "false" }) });
    const r2 = await runProof(f.message, d);
    expect(r2.mode).toBe("noCloud");
    expect(d.claimCheck.received).toHaveLength(0);
  });

  it("a cloud failure keeps the on-device red flags and says why", async () => {
    const { EngineError } = await import("../src/engine/engines");
    const f = FIXTURES[0]!;
    const failing = new MockClaimCheckEngine(() => { throw new EngineError("serviceUnavailable"); });
    const r = await runProof(f.message, deps(f, { claimCheck: failing }));
    expect(r.mode).toBe("cloudFailed");
    expect(r.cloudError).toBe("serviceUnavailable");
    expect(r.flags.length).toBeGreaterThan(0);
    const offline = new MockClaimCheckEngine(() => { throw new EngineError("offline"); });
    expect((await runProof(f.message, deps(f, { claimCheck: offline }))).mode).toBe("offline");
  });

  it("the cloud context is fixed vocabulary only", async () => {
    const f = FIXTURES[3]!;
    const d = deps(f);
    await runProof(f.message, d);
    const ctx: ClaimContext = d.claimCheck.received[0]!.context;
    expect(ctx.senderType).toBe("an employer or boss");
    expect(JSON.stringify(ctx)).not.toMatch(/Dana|Google Play|between us/);
  });
});

describe("TacticScanner rules", () => {
  it("flags shortened, odd, look-alike and mismatched links", () => {
    expect(linkFindings("Pay at bit.ly/3Fk9xQz", "unknown")[0]!.detail).toMatch(/Shortened/);
    expect(linkFindings("see https://paypal.com-secure.xyz/login", "unknown")[0]!.weight).toBe(3);
    expect(linkFindings("Claim at hmrc-refund-claim.top", "a government agency")[0]!.weight).toBe(3);
    expect(linkFindings("Open your Lakeview card app at lakeview.secure-login.example", "unknown")[0]!.detail).toMatch(/doesn't match|login page/);
    expect(linkFindings("Track it at swiftpost.co.uk/track in the Swiftpost app", "a delivery company")[0]!.detail).toBeNull();
    expect(linkFindings("Mr.Smith and St.Louis are not links", "unknown")).toHaveLength(0);
  });

  it("finds gift cards, crypto, OTP requests — but not 'never share this code'", () => {
    const ids = (s: string) => patternTactics(s).map((f) => f.tactic);
    expect(ids("Please buy two Apple gift cards")).toContain("unusual_payment");
    expect(ids("Send BTC to this wallet")).toContain("unusual_payment");
    expect(ids("Please send me the code we texted you")).toContain("credential_request");
    expect(ids("Never share this code with anyone")).not.toContain("credential_request");
    expect(ids("Don't tell anyone about this")).toContain("secrecy");
  });

  it("drops model tactics whose evidence isn't in the message, and unknown tactic names", () => {
    const raw = "Your parcel is waiting. Pay the fee today.";
    const out = parseTacticsOutput('```json\n{"tactics":[{"tactic":"urgency","evidence":"Pay the fee today"},{"tactic":"fear","evidence":"you will be arrested"},{"tactic":"magic","evidence":"parcel"}],"claims":["A parcel is waiting"]}\n```', raw)!;
    expect(out.flags.map((f) => f.tactic)).toEqual(["urgency"]);
    expect(out.claims).toEqual(["A parcel is waiting"]);
    expect(parseTacticsOutput("I can't help with that.", raw)).toBeNull();
  });

  it("cleans claims: one line, deduplicated, at most 3", () => {
    expect(extractClaims(["- The bank froze\nthe account", "the bank froze the account", "x", "Claim two is here", "Claim three is here", "Claim four is here"])).toEqual(["The bank froze the account", "Claim two is here", "Claim three is here"]);
  });

  it("guesses the claimed sender type from fixed keyword lists", () => {
    expect(senderTypeOf("Your parcel delivery failed")).toBe("a delivery company");
    expect(senderTypeOf("Your bank card was used")).toBe("a bank or payment service");
    expect(senderTypeOf("Hello there")).toBe("unknown");
  });
});

describe("claimcheck.v1 parsing and grounding display", () => {
  it("parses markdown, bullets and inline lists", () => {
    const p = parseClaimCheck("**VERDICT:** LIKELY SCAM\n**WHY:** One. Two.\n**DO:**\n1. Call the bank.\n2. Check the app.\n**DON'T:** Don't click; Don't reply");
    expect(p.verdict).toBe("LIKELY_SCAM");
    expect(p.why.map((x) => x.text)).toEqual(["One. Two."]);
    expect(p.do.map((x) => x.text)).toEqual(["Call the bank.", "Check the app."]);
    expect(p.dont.map((x) => x.text)).toEqual(["Don't click", "Don't reply"]);
    expect(parseClaimCheck("no format at all").verdict).toBe("UNCLEAR");
    expect(parseClaimCheck("VERDICT: LIKELY_LEGIT\nWHY: fine").verdict).toBe("LIKELY_LEGIT");
  });

  it("maps grounding supports onto answer lines (inline) and numbers sources (aggregate)", () => {
    const text = "VERDICT: LIKELY_SCAM\nWHY: Banks never ask for codes.\nDO:\n- Call the bank.";
    const p = parseClaimCheck(text);
    const { sources, cites } = cite(text, [...p.why, ...p.do], { sources: SOURCES.sources, supports: [{ text: "Banks never ask for codes.", chunkIndices: [2] }, { text: "Call the bank.", chunkIndices: [0, 1] }] });
    expect(sources.map((s) => s.n)).toEqual([1, 2]);
    expect(cites).toEqual([[2], [1]]);
  });

  it("only http(s) source links are allowed", () => {
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("data:text/html,hi")).toBeNull();
    expect(safeHttpUrl("https://example.org/a")).toBe("https://example.org/a");
  });

  it("the cloud prompt carries the sealed claim + legend exactly as gate-hashed", async () => {
    const f = FIXTURES[0]!;
    const d = deps(f);
    await runProof(f.message, d);
    const { sealed, context } = d.claimCheck.received[0]!;
    const text = claimCheckPrompt(prompts, sealed, context);
    expect(text).toContain(sealed.value);
    expect(text).toMatch(/Pressure tactics found in the message: [a-z ,]*urgency/);
    expect(text).not.toContain("{{");
  });
});

describe("Verdict aggregation and share warning", () => {
  it("never says 'Looks legitimate' without a web check or over strong red flags", () => {
    const strong = patternTactics("Reply with the code within 2 hours or your account will be locked. Buy gift cards.");
    expect(tacticScore(strong)).toBeGreaterThanOrEqual(5);
    expect(aggregateVerdict(strong, [])).toBe("likelyScam");
    expect(aggregateVerdict([], [])).toBe("unsure");
    expect(aggregateVerdict(strong, ["LIKELY_LEGIT"])).toBe("unsure");
    expect(aggregateVerdict([], ["LIKELY_LEGIT", "UNCLEAR"])).toBe("looksLegit");
    expect(aggregateVerdict([], ["UNCLEAR"])).toBe("unsure");
    expect(aggregateVerdict([], ["UNCLEAR", "LIKELY_SCAM"])).toBe("likelyScam");
  });

  it("the share warning is built from fixed phrases only — no names, links, numbers or quotes", async () => {
    for (const f of FIXTURES) {
      const r = await runProof(f.message, deps(f));
      const text = shareWarning(r);
      if (r.verdict === "looksLegit") { expect(text).toBeNull(); continue; }
      expect(text).toMatch(/^Heads up: I got /);
      for (const s of [...f.sensitive, ...f.entities.map((e) => e.text)]) expect(text).not.toContain(s);
      for (const flag of r.flags) if (flag.evidence && flag.evidence.length > 12) expect(text).not.toContain(flag.evidence);
      expect(text).not.toMatch(/https?:|\d{3}/);
    }
  });

  it("categories used by the claim legend are real categories", async () => {
    const f = FIXTURES[0]!;
    const d = deps(f);
    await runProof(f.message, d);
    for (const { sealed } of d.claimCheck.received) for (const k of Object.keys(sealed.gateReport.counts)) expect([...ALL_CATEGORIES, "generalised", "bucketed", "redteamApplied"]).toContain(k);
  });
});
