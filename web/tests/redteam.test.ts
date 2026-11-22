// Red-team regression suite (docs/13-FIX-PLAN.md FX-00). Every failure found in docs/12-REVIEW.md §3.1 is pinned
// here. Open findings use `it.fails`: the test asserts the SAFE outcome and is expected to fail until fixed. A fix
// turns `it.fails` into `it` — if an open case starts passing by accident, vitest fails the run, so it can't be
// forgotten. Test names start with the problem ID.
import { describe, expect, it } from "vitest";
import { EntityMap, restore, fidelityCheck } from "../src/engine";
import { MockClaimCheckEngine, MockPhoneEngine } from "../src/engine/mocks";
import { runProof } from "../src/engine/proof";
import { AppConfig } from "../src/core/appConfig";
import { leaks, patterns, prompts, seal, vaultEntry, type SealOptions } from "./redteamHarness";

type Case = [id: string, raw: string, needles: string[], opts?: SealOptions];

/** Asserts nothing in `needles` leaves (or the gate blocks). */
async function expectSealed([, raw, needles, opts]: Case): Promise<void> {
  const r = await seal(raw, opts ?? { items: [] });
  expect(leaks(r, needles), `outbound: ${r.outbound}`).toEqual([]);
}

/** Registers each case as open (`it.fails`) or fixed (`it`). */
function cases(list: readonly Case[], open: ReadonlySet<string> = new Set(list.map((c) => c[0]))): void {
  for (const c of list) (open.has(c[0]) ? it.fails : it)(c[0], () => expectSealed(c));
}

const VAULT = [
  vaultEntry("me", "Maya Chen", ["Maya"], "person", true),
  vaultEntry("v1", "Priya Sharma", ["Priya"], "person", false, "my sister"),
  vaultEntry("v2", "José García", [], "person", false, "my landlord"),
  vaultEntry("v3", "Anne-Marie O'Brien", ["Anne-Marie"], "person", false, "my boss"),
  vaultEntry("v4", "Mercy General Hospital", ["Mercy General"], "org", false, "my employer"),
  vaultEntry("v6", "राहुल वर्मा", [], "person", false, "my cousin"),
  vaultEntry("v7", "Zoë Müller", [], "person", false, "my doctor"),
];
const V = { vault: VAULT, items: [] };
const RAJESH = { items: [{ text: "Rajesh Kumar", type: "PERSON", confidence: "high" }] };

describe("PR-03 a name on its own or in another case", () => {
  cases([
    ["PR-03 user surname alone (Ms Chen)", "Regards, M. Chen / Ms Chen", ["Chen"], V],
    ["PR-03 Vault surname alone (Ms Sharma)", "Ms Sharma called.", ["Sharma"], V],
    ["PR-03 initials (P. Sharma)", "P. Sharma and M. Chen met.", ["Sharma", "Chen"], V],
    ["PR-03 Vault surname with title (Mr. García)", "Mr. García raised the rent.", ["García"], V],
    ["PR-03 Vault first name without alias (José)", "José raised the rent.", ["José"], V],
    ["PR-03 plural possessive (the Sharmas')", "the Sharmas' house", ["Sharma"], V],
    ["PR-03 detected surname lower-case (kumar)", "Rajesh Kumar hit me. later kumar denied it.", ["kumar"], RAJESH],
    ["PR-03 detected surname upper-case (KUMAR)", "Rajesh Kumar hit me. Signed: KUMAR", ["KUMAR"], RAJESH],
    ["PR-03 detected first name lower-case (rajesh)", "Rajesh Kumar hit me. then rajesh ran.", ["rajesh"], RAJESH],
    ["PR-03 name in a filename (rajesh_kumar.pdf)", "Rajesh Kumar hit me. See rajesh_kumar.pdf", ["rajesh_kumar"], RAJESH],
    ["PR-03 two-letter surname (Li)", "Li Wei called. Then Li left.", [" Li left"], { items: [{ text: "Li Wei", type: "PERSON", confidence: "high" }] }],
  ]);

  it.fails("PR-03 follow-up turn: lower-case first name from the thread", async () => {
    const first = await seal("Rajesh Kumar hit me in Jodhpur.", RAJESH);
    const r = await seal("what do i tell rajesh now?", { items: [], existing: first.res.draft.entities as EntityMap });
    expect(leaks(r, ["rajesh"])).toEqual([]);
  });

  it("PR-03 holds: title-case partial after a detected name is blocked", async () => {
    const r = await seal("Rajesh Kumar hit me. Mr Kumar denied it.", RAJESH);
    expect(leaks(r, ["Kumar"])).toEqual([]);
  });
});

describe("PR-04 Indic scripts", () => {
  cases([
    ["PR-04 Devanagari Vault name", "कल राहुल वर्मा आया था।", ["राहुल", "वर्मा"], V],
    ["PR-04 Devanagari model name, later parts", "प्रिया शर्मा मेरी बहन है। शर्मा जी नाराज़ हैं। प्रिया ने कहा।", ["शर्मा", "प्रिया"], { items: [{ text: "प्रिया शर्मा", type: "PERSON", confidence: "high" }] }],
  ]);
});

describe("PR-05 imperfect model spans", () => {
  // Safe = sealed, or the pipeline asks for review because the model's output couldn't be used.
  const imperfect: [string, string, string, string][] = [
    ["PR-05 title in the model's span", "Rajesh Kumar hit me.", "Mr. Rajesh Kumar", "Rajesh"],
    ["PR-05 name across a line break", "I met Rajesh\nKumar yesterday.", "Rajesh Kumar", "Rajesh"],
    ["PR-05 double space in the model's span", "I met Rajesh Kumar yesterday.", "Rajesh  Kumar", "Rajesh"],
    ["PR-05 diacritics dropped by the model", "I met José García yesterday.", "Jose Garcia", "José"],
  ];
  for (const [id, raw, said, needle] of imperfect) {
    it.fails(id, async () => {
      const r = await seal(raw, { items: [{ text: said, type: "PERSON", confidence: "high" }] });
      expect(leaks(r, [needle]).length === 0 || r.reasons.includes("modelUnclear")).toBe(true);
    });
  }
  it.fails("PR-05 unknown type label (FULL_NAME)", async () => {
    const r = await seal("Rajesh Kumar hit me.", { items: [{ text: "Rajesh Kumar", type: "FULL_NAME", confidence: "high" }] });
    expect(leaks(r, ["Rajesh"]).length === 0 || r.reasons.includes("modelUnclear")).toBe(true);
  });
});

describe("PR-06 rules must not undo the model", () => {
  cases([["PR-06 date of birth tagged by the model", "Patient, F, 04/03/1989, presents with rash.", ["04/03/1989"], { items: [{ text: "04/03/1989", type: "DOB", confidence: "high" }] }]]);
});

describe("PR-07 role hints", () => {
  it.fails("PR-07 free-text role reaches the legend", async () => {
    const r = await seal("Dr Mehta treats me.", { items: [{ text: "Dr Mehta", type: "PERSON", role: "the writer's oncologist at Tata Memorial Mumbai", confidence: "high" }] });
    expect(leaks(r, ["Tata Memorial", "oncologist"])).toEqual([]);
  });
  it.fails("PR-07 Vault role hint with a place reaches the legend", async () => {
    const r = await seal("Dr Shah called me.", { vault: [vaultEntry("d", "Dr Shah", [], "person", false, "my cardiologist at AIIMS Jodhpur")], items: [] });
    expect(leaks(r, ["AIIMS", "Jodhpur"])).toEqual([]);
  });
});

describe("PR-08 identifier formats", () => {
  cases([
    ["PR-08 card repeated with dots", "Card 4111 1111 1111 1111. Typed again: 4111.1111.1111.1111", ["4111.1111"]],
    ["PR-08 spelled-out email", "Email bob.smith@example.com (bob dot smith at example dot com)", ["bob dot smith"]],
    ["PR-08 SSN with en dashes", "SSN 123-45-6789, also written 123–45–6789", ["123–45–6789"]],
    ["PR-08 lower-case IBAN", "IBAN GB82 WEST 1234 5698 7654 32 = gb82west12345698765432", ["gb82west"]],
    ["PR-08 Devanagari digits phone", "मेरा नंबर ९८७६५४३२१० है", ["९८७६५४३२१०"]],
    ["PR-08 UPI ID", "Pay to rahul.verma@okhdfcbank today", ["rahul.verma@okhdfcbank"]],
    ["PR-08 URL without scheme", "see linkedin.com/in/rahul-verma-8823", ["rahul-verma"]],
    ["PR-08 lower-case PAN", "pan abcpe1234f", ["abcpe1234f"]],
    ["PR-08 Indian PIN code", "I live in Jodhpur 342001", ["342001"]],
    ["PR-08 date of birth in words", "I was born on 4th of March 1989", ["1989"]],
    ["PR-08 OTP without a trigger word", "Use 482913 to log in to my SBI account", ["482913"]],
    ["PR-08 password after 'pass is'", "my wifi pass is Tr0ub4dor&3", ["Tr0ub4dor&3"]],
    ["PR-08 JWT header", "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlLXZhbHVlLWhlcmU", ["eyJhbGciOiJIUzI1NiJ9"]],
  ]);
  it("PR-08 holds: spaced Indian mobile is sealed", () => expectSealed(["", "My number is +91 98765 43210, call after 6.", ["98765"]]));
});

describe("PR-09 partial seals", () => {
  cases([
    ["PR-09 accented email local part", "Write to josé.garcía@example.com", ["josé.garcí"]],
    ["PR-09 URL userinfo password", "ftp://rahul:hunter2@files.example.com/home/rahul", ["rahul:"]],
    ["PR-09 Vault name in a URL slug", "see https://example.com/team/priya-sharma", ["-sharma"], V],
  ]);
});

describe("PR-10 natural variants of Vault names", () => {
  cases([
    ["PR-10 hyphen written as a space", "Anne Marie O'Brien said no.", ["Anne Marie"], V],
    ["PR-10 German umlaut transliterated", "Dr Zoe Mueller saw me.", ["Mueller"], V],
    ["PR-10 hashtag joined name", "#PriyaSharma", ["PriyaSharma"], V],
  ]);
  it("PR-10 holds: diacritics stripped still match", () => expectSealed(["", "Jose Garcia raised the rent.", ["Jose", "Garcia"], V]));
});

describe("PR-13 restore", () => {
  it.fails("PR-13 bare tokens are not restored", async () => {
    const r = await seal("Raj Patel (raj.patel@example.com) is my landlord.", { items: [{ text: "Raj Patel", type: "PERSON", confidence: "high" }] });
    const shown = restore("set CONTACT_1=x; file PERSON_1.txt", { entities: r.res.draft.entities, userFirstName: "Maya", writingAsUser: false }).text;
    expect(shown).not.toContain("raj.patel@example.com");
  });
  it.fails("PR-13 contact legend says which kind of contact", async () => {
    const r = await seal("Mail raj.patel@example.com or call +91 98765 43210.", { items: [] });
    expect(r.outbound).toMatch(/email address/);
    expect(r.outbound).toMatch(/phone number/);
  });
  it("PR-13 holds: a guessed real name is flagged by the fidelity check", async () => {
    const r = await seal("Raj Patel is my landlord.", { items: [{ text: "Raj Patel", type: "PERSON", confidence: "high" }] });
    expect(fidelityCheck("I think this is Raj Patel.", { entities: r.res.draft.entities, userFirstName: "Maya", writingAsUser: false }).isClean).toBe(false);
  });
});

describe("PR-14 remaining gate gaps", () => {
  it.fails("PR-14 a fake placeholder hides a detected name", async () => {
    const r = await seal("Rajesh Kumar hit me. See [[KUMAR_1]] and [[RAJESH_2]].", RAJESH);
    expect(leaks(r, ["KUMAR_1", "RAJESH_2"])).toEqual([]);
  });
  cases([["PR-14 dotless i look-alike", "I met Prıya.", ["Prıya"], V]]);
});

describe("UX-13 inputs that trap the user", () => {
  it.fails("UX-13 a password followed by an ordinary word can be sent", async () => {
    const r = await seal("My password is hunter2 which I set last week.", { items: [] });
    expect(r.blocked).toBe(false);
    expect(r.outbound).not.toContain("hunter2");
  });
  it.fails("UX-13 a postal code is a place, not a secret", async () => {
    const r = await seal("PIN code 342001", { items: [] });
    expect(r.outbound).not.toMatch(/SECRET_/);
  });
});

describe("PR-02 Proof sends nothing before the user confirms", () => {
  it.fails("PR-02 claims reach the web check only after confirmation", async () => {
    const message = "This is Inspector Rajesh Kumar, Jodhpur Kotwali police. Your son Arjun Rathore was arrested this morning near Sardarpura. Pay Rs 50,000 bail today by UPI to rajeshk@okhdfcbank or he goes to jail. Do not tell anyone.";
    const tactics = JSON.stringify({
      tactics: [{ tactic: "urgency", quote: "today" }, { tactic: "secrecy", quote: "Do not tell anyone" }],
      claims: ["Inspector Rajesh Kumar of Jodhpur Kotwali police says Arjun Rathore was arrested near Sardarpura", "Bail of Rs 50,000 must be paid today by UPI to rajeshk@okhdfcbank"],
    });
    const phone = new MockPhoneEngine((id) => (id === "tactics.v1" ? tactics : id === "detect.v1" ? JSON.stringify({ items: [{ text: "Arjun Rathore", type: "PERSON", confidence: "high" }] }) : '{"guesses":[]}'), "available");
    const claimCheck = new MockClaimCheckEngine(() => ({ text: "VERDICT: unsupported\nWHY: none", sources: [], supports: [], webSearchQueries: [] }));
    await runProof(message, { phone, claimCheck, patterns, vault: [], prompts, config: new AppConfig(), online: true });
    expect(claimCheck.received).toHaveLength(0);
  });
});
