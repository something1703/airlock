import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type Receipt, GENESIS, canonicalJson, computeHash, hashedFields, sealReceipt, sha256Hex, verifyChain } from "../src/engine";
import { fixture, int, pick, rng } from "./support";

describe("sha256", () => {
  it("known vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("matches node:crypto on random strings incl. block-boundary lengths and unicode", () => {
    const r = rng(11);
    const alphabet = ["a", "Z", " ", "é", "漢", "👩‍👩‍👧", "\n", "\u0001"];
    for (let i = 0; i < 400; i++) {
      const s = Array.from({ length: i % 150 }, () => pick(r, alphabet)).join("");
      expect(sha256Hex(s)).toBe(createHash("sha256").update(s, "utf8").digest("hex"));
    }
    for (const n of [55, 56, 57, 63, 64, 65, 119, 120, 128]) expect(sha256Hex("x".repeat(n))).toBe(createHash("sha256").update("x".repeat(n)).digest("hex"));
  });
});

describe("hash chain (spec/fixtures/hashchain.json — computed by an independent Python implementation)", () => {
  type Fx = { genesis: string; chain: { receipt: Omit<Receipt, "hash">; canonical: string; hash: string }[] };
  const f = fixture<Fx>("hashchain.json");
  const receipts = f.chain.map((l) => ({ ...l.receipt, hash: l.hash }) as Receipt);

  it("canonical JSON and hashes are byte-identical to the reference", () => {
    expect(f.genesis).toBe(GENESIS);
    f.chain.forEach((link, i) => {
      expect(canonicalJson(hashedFields(receipts[i]!))).toBe(link.canonical);
      expect(computeHash(receipts[i]!)).toBe(link.hash);
    });
    expect(verifyChain(receipts)).toEqual({ valid: true, count: 3 });
  });

  const chain = (n: number): Receipt[] => {
    const out: Receipt[] = [];
    let prev = GENESIS;
    for (let i = 1; i <= n; i++) {
      const r = sealReceipt({ id: `rcpt_${i}`, seq: i, createdAt: `2026-11-2${i % 10}T10:00:00Z`, threadId: `thr_${i % 7}`, route: (["phoneOnly", "phoneFirst", "cloudFirst", "cloudOnly"] as const)[i % 4]!, modelVersion: `m${i % 3}`, outboundSha256: sha256Hex(String(i)), outboundChars: i * 10, counts: { person: i % 5, org: i % 2 }, gate: { passed: true, checks: ["G1", "G2"] }, armor: "notConfigured", latencyMs: { seal: i }, prevHash: prev, hash: "" });
      out.push(r);
      prev = r.hash;
    }
    return out;
  };

  it("verifies 1,000 receipts and the local-only text is not hashed", () => {
    const c = chain(1000);
    expect(verifyChain(c)).toEqual({ valid: true, count: 1000 });
    expect(computeHash({ ...c[0]!, outboundText: "anything" })).toBe(c[0]!.hash);
  });
  it.each([0, 1, 17, 499, 999])("a single changed field is caught at index %i", (i) => {
    const c = chain(1000);
    c[i] = { ...c[i]!, outboundChars: c[i]!.outboundChars + 1 };
    expect(verifyChain(c)).toEqual({ valid: false, index: i, seq: i + 1, reason: "hashMismatch" });
  });
  it("a re-hashed forgery breaks the next link; gaps and genesis are caught", () => {
    const c = chain(10);
    c[4] = sealReceipt({ ...c[4]!, modelVersion: "forged" });
    expect(verifyChain(c)).toEqual({ valid: false, index: 5, seq: 6, reason: "prevHashMismatch" });
    const gap = chain(3); gap.splice(1, 1);
    expect(verifyChain(gap)).toEqual({ valid: false, index: 1, seq: 3, reason: "seqGap" });
    expect(verifyChain(chain(3).slice(1))).toEqual({ valid: false, index: 0, seq: 2, reason: "genesisMismatch" });
    expect(verifyChain([])).toEqual({ valid: true, count: 0 });
  });
  it("canonical JSON escaping and ordering", () => {
    expect(canonicalJson({ b: -1, a: ["q\"\\\n\t\u0001é", true, null] })).toBe('{"a":["q\\"\\\\\\n\\t\\u0001é",true,null],"b":-1}');
    expect(() => canonicalJson(1.5)).toThrow();
    expect(int(rng(1), 1, 1)).toBe(1);
  });
});
