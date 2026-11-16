import { describe, expect, it } from "vitest";
import { EgressGate, EntityMap, GateBlocked, PatternDetector, makeEntity, generalise, idToken, compareIds, type Entity, type LegendLine, type VaultEntry } from "../src/engine";
import { allTerms } from "../src/engine/vault";
import { int, pick, rng } from "./support";

/**
 * docs/09-TESTING.md §2 — 10,000 seeded cases. Clean drafts must always pass; every mutation
 * (surface form, Vault alias with random case/diacritics, pattern instance, zero-width variant,
 * homoglyph variant, partial organisation name) must always block.
 */
const PEOPLE = ["Raj Patel", "Lena Okafor", "Tomasz Wiśniewski", "Aiko Tanaka", "Jorge Álvarez", "Priya Natarajan", "Dmitri Volkov", "Siobhan Kearney"];
const ORGS = ["Brightline Logistics", "Harbor View Clinic", "Northgate Academy"];
const FILLER = "the heater has been broken for three weeks and nobody called back about repair please help me reply firmly landlord says it is fine but not cold apartment since october we talked yesterday again today kind of frustrating thanks a lot".split(" ");
const CONFUSABLES: Record<string, string> = { a: "а", e: "е", o: "о", p: "р", c: "с", i: "і" };
const ZERO_WIDTH = ["​", "‌", "‍", "⁠", "﻿"];
const ACCENTS: Record<string, string> = { a: "á", e: "é", i: "í", o: "ó", u: "ú", n: "ñ" };
const IBANS = ["GB82WEST12345698765432", "DE89370400440532013000", "FR1420041010050500013M02606"];

const shuffle = <T,>(r: () => number, xs: T[]): T[] => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; }
  return a;
};

interface Scenario { entities: Entity[]; vault: VaultEntry[] }

function scenario(r: () => number): Scenario {
  const names = shuffle(r, PEOPLE);
  const vaultName = names.shift()!;
  const count = int(r, 1, 3);
  const entities: Entity[] = Array.from({ length: count }, (_, i) => {
    const name = names[i]!;
    return makeEntity({ id: `PERSON_${i + 1}`, category: "person", canonical: name, surfaceForms: new Set([name, name.split(" ")[0]!]), sources: new Set(["llm"]), confidence: "high" });
  });
  const org = pick(r, ORGS);
  entities.push(makeEntity({ id: "ORG_1", category: "org", canonical: org, surfaceForms: new Set([org]), action: generalise(2), generalisedText: "an organisation", sources: new Set(["llm"]), confidence: "high" }));
  return { entities, vault: [{ id: "v1", canonical: vaultName, aliases: [vaultName.split(" ")[0]!], category: "person", roleHint: "my sister", isUser: false }] };
}

function cleanDraft(s: Scenario, r: () => number): { words: string[]; legend: LegendLine[] } {
  const words = Array.from({ length: int(r, 4, 30) }, () => pick(r, FILLER));
  const people = s.entities.filter((e) => e.category === "person");
  const used = new Set<string>();
  for (let i = int(r, 1, 3); i > 0; i--) {
    const e = pick(r, people);
    used.add(e.id);
    words.splice(int(r, 0, words.length), 0, idToken(e.id) + (r() < 0.5 ? "'s" : ""));
  }
  if (r() < 0.5) words.splice(int(r, 0, words.length), 0, "an organisation");
  return { words, legend: [...used].sort(compareIds).map((id) => ({ placeholder: id, description: "the user's landlord" })) };
}

function card(r: () => number): string {
  const digits = [4, ...Array.from({ length: 14 }, () => int(r, 0, 9))];
  let sum = 0;
  [...digits].reverse().forEach((d, i) => { const x = i % 2 === 0 ? d * 2 : d; sum += x > 9 ? x - 9 : x; });
  digits.push((10 - (sum % 10)) % 10);
  const s = digits.join("");
  return r() < 0.5 ? s : [0, 4, 8, 12].map((i) => s.slice(i, i + 4)).join(" ");
}

function mutation(kind: number, s: Scenario, r: () => number): string {
  const forms = shuffle(r, s.entities.flatMap((e) => [...e.surfaceForms]));
  switch (kind) {
    case 0: return forms[0]! + (r() < 0.5 ? "'s" : "");
    case 1: {
      const term = pick(r, allTerms(s.vault[0]!));
      return [...term].map((ch) => {
        let c = ch;
        const a = ACCENTS[ch.toLowerCase()];
        if (a && int(r, 0, 2) === 0) c = a;
        return r() < 0.5 ? c.toUpperCase() : c.toLowerCase();
      }).join("");
    }
    case 2:
      switch (int(r, 0, 4)) {
        case 0: return card(r);
        case 1: return pick(r, IBANS);
        case 2: return `user${int(r, 1, 9999)}@mail.example.org`;
        case 3: return `312-555-${String(int(r, 0, 9999)).padStart(4, "0")}`;
        default: return `${int(r, 100, 665)}-${int(r, 10, 99)}-${int(r, 1000, 9999)}`;
      }
    case 3: {
      const chars = [...forms[0]!];
      chars.splice(int(r, 1, chars.length - 1), 0, pick(r, ZERO_WIDTH));
      return chars.join("");
    }
    case 5: {
      const org = s.entities.find((e) => e.category === "org")!.canonical.split(" ");
      return r() < 0.5 ? org.slice(0, 2).join(" ") : org[0]!;
    }
    default: {
      const form = forms.find((f) => [...f].some((c) => CONFUSABLES[c])) ?? forms[0]!;
      const chars = [...form];
      const idx = chars.map((c, i) => (CONFUSABLES[c] ? i : -1)).filter((i) => i >= 0);
      if (idx.length > 0) { const i = pick(r, idx); chars[i] = CONFUSABLES[chars[i]!]!; }
      return chars.join("");
    }
  }
}

describe("egress gate property test", () => {
  it("10,000 cases: every mutation blocks, no clean draft false-blocks", () => {
    const r = rng(20261116);
    const patterns = new PatternDetector();
    let falseBlocks = 0;
    let misses = 0;
    const draftOf = (text: string, legend: LegendLine[], map: EntityMap) => ({ text, legend, replacements: [], entities: map, secretWarnings: [], revealedVaultIds: new Set<string>(), keptValues: new Set<string>() });
    for (let i = 0; i < 10_000; i++) {
      const s = scenario(r);
      const gate = new EgressGate(patterns, s.vault);
      const map = new EntityMap(s.entities);
      const { words, legend } = cleanDraft(s, r);
      if (i % 2 === 0) {
        try { gate.seal(draftOf(words.join(" "), legend, map)); } catch (e) {
          falseBlocks++;
          if (falseBlocks <= 3) expect.fail(`false block on clean draft: ${words.join(" ")} → ${[...(e as GateBlocked).checks]}`);
        }
      }
      const mutated = [...words];
      const kind = i % 6;
      mutated.splice(int(r, 0, mutated.length), 0, mutation(kind, s, r));
      const text = mutated.join(" ");
      try {
        gate.seal(draftOf(text, legend, map));
        misses++;
        if (misses <= 5) expect.fail(`mutation kind ${kind} passed the gate: ${text}`);
      } catch (e) {
        if (!(e instanceof GateBlocked)) throw e;
      }
    }
    expect(falseBlocks).toBe(0);
    expect(misses).toBe(0);
  });
});
