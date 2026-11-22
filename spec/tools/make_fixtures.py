#!/usr/bin/env python3
"""Generates spec/fixtures/*.json — the cross-platform conformance suite.

Expected values that involve arithmetic (check digits, IBAN mod-97, SHA-256
hash chain) are computed here, independently of the Swift/TypeScript/Kotlin
engines, so every engine is tested against a second implementation.
All fixture data is fictional. Run: python3 -I spec/tools/make_fixtures.py
"""
import hashlib, json, os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "fixtures")

# ---------- independent reference implementations ----------
def luhn_ok(s):
    d = [int(c) for c in s if c.isdigit()]
    tot = 0
    for i, x in enumerate(reversed(d)):
        if i % 2: x = x * 2 - 9 if x * 2 > 9 else x * 2
        tot += x
    return tot % 10 == 0

def iban_ok(s):
    s = s.replace(" ", "").upper()
    r = s[4:] + s[:4]
    return int("".join(str(int(c, 36)) for c in r)) % 97 == 1

D = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]]
P = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]]
INV = [0,4,3,2,1,5,6,7,8,9]
def verhoeff_digit(num):
    c = 0
    for i, ch in enumerate(reversed(num)):
        c = D[c][P[(i + 1) % 8][int(ch)]]
    return str(INV[c])
def verhoeff_ok(num):
    c = 0
    for i, ch in enumerate(reversed(num)):
        c = D[c][P[i % 8][int(ch)]]
    return c == 0

aadhaar = "23412341234"; aadhaar += verhoeff_digit(aadhaar)
aadhaar_bad = aadhaar[:-1] + str((int(aadhaar[-1]) + 1) % 10)
assert verhoeff_ok(aadhaar) and not verhoeff_ok(aadhaar_bad)
aadhaar_spaced = f"{aadhaar[:4]} {aadhaar[4:8]} {aadhaar[8:]}"
for c in ["4111111111111111", "5555555555554444", "378282246310005", "6011111111111117"]: assert luhn_ok(c)
for i in ["GB82WEST12345698765432", "DE89370400440532013000", "FR1420041010050500013M02606"]: assert iban_ok(i)
assert not iban_ok("GB82WEST12345698765433")
# Provider-shaped fake secrets are stored ONLY as parts and joined by each test at load time,
# so no complete key-shaped string ever exists in the repo (GitHub secret scanning, lint rule).
TEMPLATES = {
    "FAKE_GOOGLE_API_KEY": ["AIza", "FAKE_TEST_KEY_not_a_real_key_000000"],
    "FAKE_OPENAI_KEY": ["sk-", "proj-FAKE-test-key-0000"],
}
assert len("".join(TEMPLATES["FAKE_GOOGLE_API_KEY"])) == 39
aiza = "{{FAKE_GOOGLE_API_KEY}}"

def w(name, obj):
    with open(os.path.join(OUT, name), "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False); f.write("\n")

# ---------- validators ----------
w("validators.json", {
  "description": "validator name -> cases. Engines expose these by the same names (Validators.named).",
  "card": [{"input": c, "valid": v} for c, v in [("4111111111111111", True), ("5555 5555 5555 4444", True), ("378282246310005", True), ("6011-1111-1111-1117", True), ("4111111111111112", False), ("1111111111111111", False), ("411111111111", False)]],
  "iban": [{"input": c, "valid": v} for c, v in [("GB82WEST12345698765432", True), ("GB82 WEST 1234 5698 7654 32", True), ("DE89370400440532013000", True), ("FR1420041010050500013M02606", True), ("GB82WEST12345698765433", False), ("GB82", False)]],
  "ssn": [{"input": c, "valid": v} for c, v in [("123-45-6789", True), ("000-12-3456", False), ("666-12-3456", False), ("900-12-3456", False), ("123-00-6789", False), ("123-45-0000", False)]],
  "uk_ni": [{"input": c, "valid": v} for c, v in [("AB123456C", True), ("AB 12 34 56 C", True), ("GB123456A", False), ("AO123456A", False)]],
  "aadhaar": [{"input": aadhaar, "valid": True}, {"input": aadhaar_spaced, "valid": True}, {"input": aadhaar_bad, "valid": False}, {"input": "1" + aadhaar[1:], "valid": False}],
  "pan": [{"input": "ABCPE1234F", "valid": True}, {"input": "ABCXE1234F", "valid": False}],
  "phone": [{"input": c, "valid": v} for c, v in [("312-555-0147", True), ("+1 (312) 555-0199", True), ("555-0147", True), ("12345", False), ("2026-11-21", False), ("21/11/2026", False)]],
  "url_identifying": [{"input": c, "valid": v} for c, v in [("https://www.linkedin.com/in/maya-chen-123", True), ("https://bank.example/reset?user=mchen", True), ("https://example.com/orders/8472619305", True), ("https://www.irs.gov/help", False), ("www.example.com", False), ("https://instagram.com/", False)]],
  "entropy_secret": [{"input": "Xk29fQ7vLp3sWm8nZr4tYb6c", "valid": True}, {"input": "aaaaaaaaaaaaaaaaaaaaaaaa1", "valid": False}, {"input": "short1x", "valid": False}],
})

# ---------- normaliser ----------
w("normalise.json", {
  "description": "input -> expected normalised text. Normalisation must be idempotent.",
  "cases": [
    {"name": "zero-width removed", "input": "Hi\u200bRa\u200dj\ufeff", "expected": "HiRaj"},
    {"name": "smart quotes", "input": "\u201cquoted\u201d and \u2018single\u2019", "expected": "\"quoted\" and 'single'"},
    {"name": "full-width NFKC", "input": "\uff32\uff41\uff4a \uff11\uff12\uff13", "expected": "Raj 123"},
    {"name": "ligature NFKC", "input": "\ufb01le", "expected": "file"},
    {"name": "whitespace runs", "input": "a  \t b\u00a0\u00a0c", "expected": "a b c"},
    {"name": "CRLF", "input": "line1\r\nline2\rline3", "expected": "line1\nline2\nline3"},
    {"name": "bidi override removed", "input": "pay\u202eevil", "expected": "payevil"},
  ]})

# ---------- patterns ----------
P_CASES = [
  ("email", "Email me at maya.chen@example.com tomorrow.", [("maya.chen@example.com", "contact", "email")], []),
  ("phones", "Call 312-555-0147 or +1 (312) 555-0199.", [("312-555-0147", "contact", "phone"), ("+1 (312) 555-0199", "contact", "phone")], []),
  ("card spaced", "My card 4111 1111 1111 1111 expires soon.", [("4111 1111 1111 1111", "id", "card")], []),
  ("card invalid luhn", "Number 4111 1111 1111 1112 is wrong.", [], [("4111 1111 1111 1112", "card")]),
  ("iban spaced", "Pay to GB82 WEST 1234 5698 7654 32 today.", [("GB82 WEST 1234 5698 7654 32", "id", "iban")], []),
  ("iban then capital word", "IBAN GB82WEST12345698765432 REF please", [("GB82WEST12345698765432", "id", "iban")], []),
  ("ssn", "SSN 123-45-6789 on file.", [("123-45-6789", "id", "ssn")], []),
  ("uk ni", "My NI number is AB 12 34 56 C.", [("AB 12 34 56 C", "id", "national_id")], []),
  ("passport", "My passport number is 533380006.", [("533380006", "id", "passport")], []),
  ("order ref", "Order #A1B2C3D4 shipped late.", [("#A1B2C3D4", "id", "reference")], []),
  ("otp", "Your verification code is 482913.", [("482913", "secret", "otp")], []),
  ("password", "The wifi password: hunter2!x works.", [("hunter2!x", "secret", "password")], []),
  ("openai-style key", "key {{FAKE_OPENAI_KEY}} leaked", [("{{FAKE_OPENAI_KEY}}", "secret", "api_key")], []),
  ("google api key", f"config {aiza} here", [(aiza, "secret", "api_key")], []),
  ("handle", "DM me @maya_c.design anytime", [("@maya_c.design", "contact", "handle")], []),
  ("email is not handle", "write to a.b@example.org", [("a.b@example.org", "contact", "email")], [("@example.org", "handle")]),
  ("url identifying", "See https://www.linkedin.com/in/maya-chen-123 for more.", [("https://www.linkedin.com/in/maya-chen-123", "contact", "url")], []),
  ("url generic", "Read https://www.irs.gov/help today.", [], [("https://www.irs.gov/help", "url")]),
  ("dob", "I was born on 4 Mar 1989 in a small town.", [("4 Mar 1989", "date", "dob")], []),
  ("other date", "Broken since Oct 28 and still not fixed.", [("Oct 28", "date", "date")], []),
  ("iso date not phone", "Due 2026-11-21 at noon.", [("2026-11-21", "date", "date")], [("2026-11-21", "phone")]),
  ("street address", "The heater at 14 Elm St, Apt 3B has been broken.", [("14 Elm St, Apt 3B", "location", "address")], []),
  ("unit", "Flat 12 is upstairs.", [("Flat 12", "location", "unit")], []),
  ("uk postcode", "Send it to SW1A 1AA please.", [("SW1A 1AA", "location", "postcode")], []),
  ("us zip", "Springfield, IL 62704 is home.", [("IL 62704", "location", "postcode")], []),
  ("aadhaar", f"Aadhaar {aadhaar_spaced} linked.", [(aadhaar_spaced, "id", "national_id")], []),
  ("pan", "PAN ABCPE1234F on the form.", [("ABCPE1234F", "id", "national_id")], []),
  ("licence plate", "My plate is AB12 CDE now.", [("AB12 CDE", "id", "plate")], []),
  ("money kept", "Rent of $1,240 is due on the 1st.", [], [("1,240", None), ("$1,240", None)]),
  ("times kept", "Free 3:00-4:00 pm on Tuesday.", [], [("3:00-4:00", None)]),
]
w("patterns.json", {
  "description": "Pattern detector conformance (regex rules only, NSDataDetector off). 'expect': each item must be found with exactly this text/category/subtype. 'absent': no candidate with this text (and subtype, if given). Other extra candidates are allowed. Before use, replace every {{NAME}} in any string with the concatenation of templates[NAME] (fake secrets are stored in parts so no key-shaped string exists in the repo).",
  "templates": TEMPLATES,
  "cases": [{"name": n, "text": t, "expect": [{"text": a, "category": c, "subtype": s} for a, c, s in e], "absent": [{"text": a, "subtype": s} for a, s in ab]} for n, t, e, ab in P_CASES]})

# ---------- vault ----------
w("vault.json", {
  "entries": [
    {"id": "v-me", "canonical": "Maya Chen", "aliases": ["Maya"], "category": "person", "roleHint": "me", "isUser": True},
    {"id": "v-raj", "canonical": "Raj Patel", "aliases": ["Raj", "Mr. Patel"], "category": "person", "roleHint": "my landlord", "isUser": False},
    {"id": "v-org", "canonical": "Mercy General Hospital", "aliases": ["Mercy General"], "category": "org", "roleHint": "my employer", "isUser": False},
    {"id": "v-jose", "canonical": "José Álvarez", "aliases": [], "category": "person", "roleHint": "my neighbour", "isUser": False},
  ],
  "cases": [
    {"name": "names", "text": "Raj said Maya Chen owes rent.", "expect": [{"text": "Raj", "entryId": "v-raj"}, {"text": "Maya Chen", "entryId": "v-me"}], "absent": []},
    {"name": "possessive and boundary", "text": "Rajesh is not Raj's brother.", "expect": [{"text": "Raj", "entryId": "v-raj"}], "absent": ["Rajesh"]},
    {"name": "upper case", "text": "RAJ PATEL called twice.", "expect": [{"text": "RAJ PATEL", "entryId": "v-raj"}], "absent": []},
    {"name": "diacritics", "text": "Jose Alvarez emailed me.", "expect": [{"text": "Jose Alvarez", "entryId": "v-jose"}], "absent": []},
    {"name": "longest term wins", "text": "I work at Mercy General Hospital nights.", "expect": [{"text": "Mercy General Hospital", "entryId": "v-org"}], "absent": ["Mercy General"]},
    {"name": "title alias", "text": "Mr. Patel never replied.", "expect": [{"text": "Mr. Patel", "entryId": "v-raj"}], "absent": []},
    {"name": "no partial word", "text": "Mayan ruins are old.", "expect": [], "absent": ["Maya"]},
  ]})

# ---------- placeholders ----------
w("placeholders.json", {
  "known": ["PERSON_1", "PERSON_2", "ORG_1", "LOC_1", "SECRET_1"],
  "cases": [
    {"text": "Hi [[PERSON_1]],", "expect": [{"original": "[[PERSON_1]]", "id": "PERSON_1", "canonical": True}]},
    {"text": "Hi [PERSON_1],", "expect": [{"original": "[PERSON_1]", "id": "PERSON_1", "canonical": False}]},
    {"text": "PERSON_1 said no", "expect": [{"original": "PERSON_1", "id": "PERSON_1", "canonical": False}]},
    {"text": "ask [[ PERSON_2 ]] now", "expect": [{"original": "[[ PERSON_2 ]]", "id": "PERSON_2", "canonical": False}]},
    {"text": "at [[Org_1]]", "expect": [{"original": "[[Org_1]]", "id": "ORG_1", "canonical": False}]},
    {"text": "at [[LOC 1]]", "expect": [{"original": "[[LOC 1]]", "id": "LOC_1", "canonical": False}]},
    {"text": "to \u3010PERSON_1\u3011", "expect": [{"original": "\u3010PERSON_1\u3011", "id": "PERSON_1", "canonical": False}]},
    {"text": "and [[PERSON_ME]] too", "expect": [{"original": "[[PERSON_ME]]", "id": "PERSON_ME", "canonical": True}]},
    {"text": "who is [[PERSON_9]]?", "expect": [{"original": "[[PERSON_9]]", "id": "PERSON_9", "canonical": True}]},
    {"text": "who is [PERSON_9]?", "expect": []},
    {"text": "PERSON_12 and MYPERSON_1 and PERSON_1x", "expect": []},
    {"text": "[[ORG_ME]] is invalid", "expect": []},
  ]})

# ---------- restore ----------
ent_single = [
  {"id": "PERSON_1", "category": "person", "canonical": "Raj Patel", "surfaceForms": ["Raj Patel", "Raj"], "action": "placeholder"},
  {"id": "ORG_1", "category": "org", "canonical": "Mercy General Hospital", "surfaceForms": ["Mercy General Hospital"], "action": "placeholder"},
  {"id": "LOC_1", "category": "location", "canonical": "14 Elm St, Apt 3B", "surfaceForms": ["14 Elm St, Apt 3B"], "action": "placeholder"},
  {"id": "SECRET_1", "category": "secret", "canonical": "482913", "surfaceForms": ["482913"], "action": "block"},
]
ent_ambiguous = [
  {"id": "PERSON_1", "category": "person", "canonical": "Raj Patel", "surfaceForms": ["Raj Patel", "Raj", "Patel"], "action": "placeholder"},
  {"id": "PERSON_2", "category": "person", "canonical": "Raj Singh", "surfaceForms": ["Raj Singh", "Singh"], "action": "placeholder"},
]
w("restore.json", {
  "description": "Model output -> restored text. Display rule: first mention canonical; later person mentions use the shortest surface form no other person shares; PERSON_ME -> 'you' (or first name when writing as the user); SECRET never restored; unknown canonical ids left as written.",
  "secretDisplay": "(hidden code)",
  "groups": [
    {"entities": ent_single, "cases": [
      {"name": "first then short", "output": "Tell [[PERSON_1]] that [[PERSON_1]]'s heater at [[LOC_1]] is broken.", "expected": "Tell Raj Patel that Raj's heater at 14 Elm St, Apt 3B is broken."},
      {"name": "org always canonical", "output": "[[ORG_1]] and later [[ORG_1]].", "expected": "Mercy General Hospital and later Mercy General Hospital."},
      {"name": "secret never restored", "output": "Never share [[SECRET_1]] with anyone.", "expected": "Never share (hidden code) with anyone."},
      {"name": "me as you", "output": "[[PERSON_ME]] can ask [[PERSON_1]].", "expected": "you can ask Raj Patel."},
      {"name": "me as signer", "output": "Thanks,\n[[PERSON_ME]]", "writingAsUser": True, "userFirstName": "Maya", "expected": "Thanks,\nMaya"},
      {"name": "unknown id kept", "output": "Ask [[PERSON_9]] instead.", "expected": "Ask [[PERSON_9]] instead.", "unknown": ["PERSON_9"]},
      {"name": "variants", "output": "[Person_1] and PERSON_1 and [[ PERSON_1 ]]", "expected": "Raj Patel and Raj and Raj"},
      {"name": "no placeholders", "output": "Nothing to restore here.", "expected": "Nothing to restore here."},
    ]},
    {"entities": ent_ambiguous, "cases": [
      {"name": "shared first name avoided", "output": "[[PERSON_1]], [[PERSON_2]], [[PERSON_1]], [[PERSON_2]]", "expected": "Raj Patel, Raj Singh, Patel, Singh"},
    ]},
  ]})

# ---------- hash chain ----------
def canon(v): return json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
receipts = []
prev = "0" * 64
base = [
  dict(id="rcpt_0001", seq=1, createdAt="2026-11-21T10:14:03Z", threadId="thr_7f3", route="cloudFirst", modelVersion="gemini-3.8-flash",
       outboundSha256="9c1e" + "0" * 60, outboundChars=1840, counts={"person": 3, "org": 1, "location": 2, "contact": 1, "id": 1, "secret": 0, "generalised": 2, "redteamApplied": 1},
       gate={"passed": True, "checks": ["G1", "G2", "G3", "G4", "G5", "G6", "G7"]}, armor="notConfigured", latencyMs={"seal": 3120, "network": 2050}),
  dict(id="rcpt_0002", seq=2, createdAt="2026-11-21T10:20:41Z", threadId="thr_7f3", route="phoneFirst", modelVersion="gemini-3.5-flash-lite",
       outboundSha256="ab" * 32, outboundChars=212, counts={"person": 1}, gate={"passed": True, "checks": ["G1", "G2", "G3", "G4", "G5", "G6", "G7"]}, armor="pass", latencyMs={"seal": 900, "network": 640}),
  dict(id="rcpt_0003", seq=3, createdAt="2026-11-22T08:00:00Z", threadId="thr_\"quoted\"\\é\n\u0001", route="cloudOnly", modelVersion="gemini-3.8-flash",
       outboundSha256="cd" * 32, outboundChars=99, counts={}, gate={"passed": True, "checks": []}, armor="blocked", latencyMs={}),
]
for r in base:
    r = dict(r, prevHash=prev)
    c = canon(r)
    h = hashlib.sha256((prev + c).encode("utf-8")).hexdigest()
    receipts.append({"receipt": r, "canonical": c, "hash": h})
    prev = h
w("hashchain.json", {
  "description": "hash = sha256_hex(prevHash + canonicalJSON(fields)); fields exclude 'hash' and 'outboundText'; genesis prevHash = 64 zeros. Canonical JSON = sorted keys, no whitespace, minimal escaping (Python json.dumps sort_keys, separators=(',',':'), ensure_ascii=False).",
  "genesis": "0" * 64, "chain": receipts})

# ---------- policy (docs/03-PRIVACY-ENGINE.md §2.1, encoded independently) ----------
DIALS = ["open", "balanced", "strict"]
def gen(level): return f"generalise:{level}"
TABLE = [
  # (category, subtype, extra, {dial: expected})
  ("person", None, {}, {"open": "placeholder", "balanced": "placeholder", "strict": "placeholder"}),
  ("org", None, {}, {"open": "keep", "balanced": gen(2), "strict": gen(3)}),
  ("location", "address", {}, {d: "placeholder" for d in DIALS}),
  ("location", "unit", {}, {d: "placeholder" for d in DIALS}),
  ("location", "postcode", {}, {d: "placeholder" for d in DIALS}),
  ("location", "place", {}, {"open": "keep", "balanced": gen(2), "strict": gen(3)}),
  ("contact", "email", {}, {d: "placeholder" for d in DIALS}),
  ("id", "card", {}, {d: "placeholder" for d in DIALS}),
  ("date", "dob", {}, {"open": gen(2), "balanced": gen(2), "strict": gen(3)}),
  ("date", "date", {}, {"open": "keep", "balanced": "keep", "strict": gen(1)}),
  ("health", None, {}, {"open": "keep", "balanced": "keep", "strict": gen(2)}),
  ("health", None, {"protectHealth": True}, {"open": "keep", "balanced": gen(2), "strict": gen(2)}),
  ("secret", "otp", {}, {d: "block" for d in DIALS}),
  ("org", None, {"vault": True}, {d: "placeholder" for d in DIALS}),
]
policy_cases = []
for cat, sub, extra, exp in TABLE:
    for d in DIALS:
        policy_cases.append({"dial": d, "category": cat, "subtype": sub, "canonical": "Springfield" if cat == "location" else "x",
                             "vault": extra.get("vault", False), "protectHealth": extra.get("protectHealth", False),
                             "override": None, "expected": exp[d]})
# Overrides
policy_cases += [
  {"dial": "balanced", "category": "person", "subtype": None, "canonical": "x", "vault": True, "protectHealth": False,
   "override": {"action": "keep", "revealThisTime": False}, "expected": "placeholder"},
  {"dial": "balanced", "category": "person", "subtype": None, "canonical": "x", "vault": True, "protectHealth": False,
   "override": {"action": "keep", "revealThisTime": True}, "expected": "keep"},
  {"dial": "balanced", "category": "secret", "subtype": "otp", "canonical": "x", "vault": False, "protectHealth": False,
   "override": {"action": "keep", "revealThisTime": True}, "expected": "block"},
  {"dial": "strict", "category": "org", "subtype": None, "canonical": "x", "vault": False, "protectHealth": False,
   "override": {"action": "keep", "revealThisTime": False}, "expected": "keep"},
  {"dial": "balanced", "category": "person", "subtype": None, "canonical": "x", "vault": False, "protectHealth": False,
   "override": {"action": "generalise:2", "revealThisTime": False}, "expected": "placeholder"},
  {"dial": "open", "category": "location", "subtype": "place", "canonical": "Unit 4 Springfield", "vault": False, "protectHealth": False,
   "override": None, "expected": "placeholder"},
]
w("policy.json", {"description": "Policy engine conformance: dial × category/subtype (+settings, overrides) -> action. 'generalise:N' = generalise(level N).",
                  "cases": policy_cases})

# ---------- merge ----------
def span(text, needle, occurrence=0):
    i = -1
    for _ in range(occurrence + 1):
        i = text.index(needle, i + 1)
    return [i, i + len(needle)]   # ASCII fixtures: char index == UTF-16 index
def cand(text, needle, cat, det, occ=0, **kw):
    s0, e0 = span(text, needle, occ)
    d = {"start": s0, "end": e0, "text": needle, "category": cat, "detector": det}
    d.update(kw); return d
VAULT = [
  {"id": "v-me", "canonical": "Maya Chen", "aliases": ["Maya"], "category": "person", "roleHint": "me", "isUser": True},
  {"id": "v-raj", "canonical": "Raj Patel", "aliases": ["Raj"], "category": "person", "roleHint": "my landlord", "isUser": False},
  {"id": "v-org", "canonical": "Mercy General", "aliases": [], "category": "org", "roleHint": "my employer", "isUser": False},
]
t1 = "Dr. Patel called. Patel says Raj Patel will fix it."
t2 = "Sam Lee and Sam Ortiz argued. Sam left."
t3 = "Raj Patel owns my flat."
t4 = "Write to raj.patel@example.com today."
t5 = "Maya Chen here."
t6 = "Raj replied and Lena agreed."
t7 = "I work at Mercy General Hospital."
t8 = "Email maya.chen@example.net, thanks, Maya"
merge_cases = [
  {"name": "coreference by token subset", "text": t1, "vault": [],
   "candidates": [cand(t1, "Dr. Patel", "person", "llm"), cand(t1, "Patel", "person", "llm", 1), cand(t1, "Raj Patel", "person", "llm")],
   "existing": [],
   "expect": {"entities": [{"id": "PERSON_1", "canonical": "Raj Patel", "formsInclude": ["Dr. Patel", "Patel", "Raj Patel"]}],
              "mentions": [["Dr. Patel", "PERSON_1"], ["Patel", "PERSON_1"], ["Raj Patel", "PERSON_1"]], "ambiguous": []}},
  {"name": "ambiguous short name stays separate", "text": t2, "vault": [],
   "candidates": [cand(t2, "Sam Lee", "person", "llm"), cand(t2, "Sam Ortiz", "person", "llm"), cand(t2, "Sam", "person", "llm", 2)],
   "existing": [],
   "expect": {"entities": [{"id": "PERSON_1", "canonical": "Sam Lee"}, {"id": "PERSON_2", "canonical": "Sam Ortiz"}, {"id": "PERSON_3", "canonical": "Sam", "confidence": "medium"}],
              "mentions": [["Sam Lee", "PERSON_1"], ["Sam Ortiz", "PERSON_2"], ["Sam", "PERSON_3"]],
              "ambiguous": [["PERSON_3", "PERSON_1"], ["PERSON_3", "PERSON_2"]]}},
  {"name": "containment extends vault hit", "text": t3, "vault": VAULT,
   "candidates": [cand(t3, "Raj", "person", "vault", vaultEntryId="v-raj"), cand(t3, "Raj Patel", "person", "llm")],
   "existing": [],
   "expect": {"entities": [{"id": "PERSON_1", "canonical": "Raj Patel", "vaultEntryId": "v-raj", "formsInclude": ["Raj", "Raj Patel"]}],
              "mentions": [["Raj Patel", "PERSON_1"]], "ambiguous": []}},
  {"name": "pattern beats llm", "text": t4, "vault": [],
   "candidates": [cand(t4, "raj.patel", "person", "llm"), cand(t4, "raj.patel@example.com", "contact", "pattern", subtype="email")],
   "existing": [],
   "expect": {"entities": [{"id": "CONTACT_1", "canonical": "raj.patel@example.com"}],
              "mentions": [["raj.patel@example.com", "CONTACT_1"]], "ambiguous": []}},
  {"name": "vault user is PERSON_ME", "text": t5, "vault": VAULT,
   "candidates": [cand(t5, "Maya Chen", "person", "vault", vaultEntryId="v-me")], "existing": [],
   "expect": {"entities": [{"id": "PERSON_ME", "canonical": "Maya Chen"}], "mentions": [["Maya Chen", "PERSON_ME"]], "ambiguous": []}},
  {"name": "follow-up reuses ids", "text": t6, "vault": [],
   "candidates": [cand(t6, "Raj", "person", "llm"), cand(t6, "Lena", "person", "llm")],
   "existing": [{"id": "PERSON_1", "category": "person", "canonical": "Raj Patel", "surfaceForms": ["Raj Patel", "Raj"], "action": "placeholder"}],
   "expect": {"entities": [{"id": "PERSON_1", "canonical": "Raj Patel"}, {"id": "PERSON_2", "canonical": "Lena"}],
              "mentions": [["Raj", "PERSON_1"], ["Lena", "PERSON_2"]], "ambiguous": []}},
  {"name": "contact pattern contains a vault name (name inside an email stays part of the address)", "text": t8, "vault": VAULT,
   "candidates": [cand(t8, "maya", "person", "vault", vaultEntryId="v-me"), cand(t8, "maya.chen@example.net", "contact", "pattern", subtype="email"),
                  cand(t8, "Maya", "person", "vault", vaultEntryId="v-me")], "existing": [],
   "expect": {"entities": [{"id": "CONTACT_1", "canonical": "maya.chen@example.net"}, {"id": "PERSON_ME", "canonical": "Maya Chen"}],
              "mentions": [["maya.chen@example.net", "CONTACT_1"], ["Maya", "PERSON_ME"]], "ambiguous": []}},
  {"name": "partial-overlap loser becomes a surface form", "text": t7, "vault": VAULT,
   "candidates": [cand(t7, "Mercy General", "org", "vault", vaultEntryId="v-org"), cand(t7, "General Hospital", "org", "nl")], "existing": [],
   "expect": {"entities": [{"id": "ORG_1", "canonical": "Mercy General", "formsInclude": ["General Hospital"]}],
              "mentions": [["Mercy General", "ORG_1"]], "ambiguous": []}},
]
w("merge.json", {"description": "Merger conformance. Candidate spans are UTF-16 offsets. formsInclude must be a subset of the entity's surfaceForms.",
                 "cases": merge_cases})

# ---------- llm detector (model reply -> candidates; detect.v1 JSON and detect.v2 lines) ----------
d_text = "Hi Raj, I work at Mercy General Hospital near Elm Street. Thanks, Maya"
d_mail = "Hi Raj, mail me at maya@example.com or call 312-555-0147. I work at Mercy General Hospital."
d_unsure = "Dr Wu saw me about my knee."
def mask_cand(text, needle, cat, subtype):
    return cand(text, needle, cat, "pattern", subtype=subtype)
llm_cases = [
  {"name": "v2 lines: people, org and place with general phrases", "promptId": "detect.v2", "text": d_text, "masks": [],
   "modelOutput": "PERSON | Raj | landlord | -\nORG | Mercy General Hospital | employer | a large hospital\nLOCATION | Elm Street | nearby street | a nearby street\nPERSON | Maya | me | -\nEND",
   "expect": [["Raj", "person", "high", "landlord"], ["Mercy General Hospital", "org", "high", "employer"], ["Elm Street", "location", "high", "nearby street"], ["Maya", "person", "high", "me"]],
   "generals": {"org:mercy general hospital": "a large hospital", "location:elm street": "a nearby street"},
   "promptIncludes": ["Hi Raj, I work at Mercy General Hospital near Elm Street. Thanks, Maya\n>>>"], "promptExcludes": [], "hallucinated": 0},
  {"name": "v2: ? means low confidence, - means none, bullets and prose lines are tolerated", "promptId": "detect.v2", "text": d_unsure, "masks": [],
   "modelOutput": "Here you go:\n- ?PERSON | Dr Wu | doctor | -\n? HEALTH | knee | - | -\nEND\nHope that helps",
   "expect": [["Dr Wu", "person", "low", "doctor"], ["knee", "health", "low", None]],
   "generals": {}, "promptIncludes": [], "promptExcludes": [], "hallucinated": 0},
  {"name": "v2: a bare END is a valid empty answer", "promptId": "detect.v2", "text": "The weekly meeting moved upstairs.", "masks": [],
   "modelOutput": "END", "expect": [], "generals": {}, "promptIncludes": [], "promptExcludes": [], "hallucinated": 0},
  {"name": "v2: rule hits are masked in the prompt and an echoed mask is ignored", "promptId": "detect.v2", "text": d_mail,
   "masks": [mask_cand(d_mail, "maya@example.com", "contact", "email"), mask_cand(d_mail, "312-555-0147", "contact", "phone")],
   "modelOutput": "PERSON | Raj | friend | -\nCONTACT | [email] | - | -\nCONTACT | [phone] | - | -\nORG | Mercy General Hospital | employer | a hospital\nEND",
   "expect": [["Raj", "person", "high", "friend"], ["Mercy General Hospital", "org", "high", "employer"]],
   "generals": {"org:mercy general hospital": "a hospital"},
   "promptIncludes": ["mail me at [email] or call [phone]. I work at"], "promptExcludes": ["maya@example.com", "312-555-0147"], "hallucinated": 0},
  {"name": "v2: invented text is dropped and counted; a general is kept only for org, location and health", "promptId": "detect.v2", "text": d_text, "masks": [],
   "modelOutput": "PERSON | Zed | friend | -\nPERSON | Raj | landlord | a tall man\nEND",
   "expect": [["Raj", "person", "high", "landlord"]], "generals": {}, "promptIncludes": [], "promptExcludes": [], "hallucinated": 1},
  {"name": "v2 prompt, v1 JSON reply: still parsed", "promptId": "detect.v2", "text": d_text, "masks": [],
   "modelOutput": '{"items":[{"text":"Raj","type":"PERSON","role":"the writer\'s landlord","confidence":"high"}]}',
   "expect": [["Raj", "person", "high", "the writer's landlord"]], "generals": {}, "promptIncludes": [], "promptExcludes": [], "hallucinated": 0},
  {"name": "v1 prompt is unchanged: no masking, JSON in", "promptId": "detect.v1", "text": d_mail,
   "masks": [mask_cand(d_mail, "maya@example.com", "contact", "email")],
   "modelOutput": '{"items":[{"text":"Raj","type":"PERSON","confidence":"medium"}]}',
   "expect": [["Raj", "person", "medium", None]], "generals": {}, "promptIncludes": ["maya@example.com"], "promptExcludes": ["[email]"], "hallucinated": 0},
]
w("detect.json", {"description": "LLM detector conformance. For each case, run the detector with the given prompt id on `text` (one chunk) with a scripted model that returns modelOutput. 'masks' are rule hits (candidates) to hide in a detect.v2 prompt; they are ignored for detect.v1. 'expect' is [text, category, confidence, roleHint] for every candidate, ordered by span. 'generals' is the detector report's category:lowercased-text -> phrase map. promptIncludes/promptExcludes are substrings of the rendered prompt. 'hallucinated' is the dropped-item count.",
                  "cases": llm_cases})

# ---------- seal (end to end, deterministic: vault + patterns + given LLM candidates) ----------
maya = "Hi Raj, the heater at 14 Elm St, Apt 3B has been broken since Oct 28. I work nights at Mercy General Hospital. Call me on 312-555-0147. Rent is $1,240. Thanks, Maya Chen"
llm_maya = [cand(maya, "Mercy General Hospital", "org", "llm", roleHint="the writer's employer")]
vault_seal = [VAULT[0], VAULT[1]]
town = "I live in Springfield and work at Acme Corp."
llm_town = [cand(town, "Springfield", "location", "llm", subtype="place"), cand(town, "Acme Corp", "org", "llm")]
secret = "My code is 482913, don't share it."
own_email = "Reach me at maya.chen@example.net. Thanks, Maya Chen"
seal_cases = [
  {"name": "own email with a vault name inside", "dial": "balanced", "today": "2026-11-21", "text": own_email, "vault": vault_seal, "llm": [], "overrides": [],
   "expectedText": "Reach me at [[CONTACT_1]]. Thanks, [[PERSON_ME]]",
   "expectedLegend": [["CONTACT_1", "contact details"], ["PERSON_ME", "the user"]]},
  {"name": "balanced landlord", "dial": "balanced", "today": "2026-11-21", "text": maya, "vault": vault_seal, "llm": llm_maya, "overrides": [],
   "expectedText": "Hi [[PERSON_1]], the heater at [[LOC_1]] has been broken since Oct 28. I work nights at an organisation. Call me on [[CONTACT_1]]. Rent is $1,240. Thanks, [[PERSON_ME]]",
   "expectedLegend": [["CONTACT_1", "contact details"], ["PERSON_ME", "the user"], ["PERSON_1", "the user's landlord"], ["LOC_1", "a place mentioned in the message"]]},
  {"name": "strict landlord", "dial": "strict", "today": "2026-11-21", "text": maya, "vault": vault_seal, "llm": llm_maya, "overrides": [],
   "expectedText": "Hi [[PERSON_1]], the heater at [[LOC_1]] has been broken since 3 weeks ago. I work nights at an organisation. Call me on [[CONTACT_1]]. Rent is $1,000–1,500. Thanks, [[PERSON_ME]]",
   "expectedLegend": [["CONTACT_1", "contact details"], ["PERSON_ME", "the user"], ["PERSON_1", "the user's landlord"], ["LOC_1", "a place mentioned in the message"]]},
  {"name": "open keeps town and org", "dial": "open", "today": "2026-11-21", "text": town, "vault": [], "llm": llm_town, "overrides": [],
   "expectedText": town, "expectedLegend": []},
  {"name": "balanced generalises town and org", "dial": "balanced", "today": "2026-11-21", "text": town, "vault": [], "llm": llm_town, "overrides": [],
   "expectedText": "I live in a city and work at an organisation.", "expectedLegend": []},
  {"name": "secret blocked", "dial": "open", "today": "2026-11-21", "text": secret, "vault": [], "llm": [], "overrides": [],
   "expectedText": "My code is [[SECRET_1]], don't share it.", "expectedLegend": [["SECRET_1", "a secret the user should not share"]]},
  {"name": "vault reveal needs explicit flag", "dial": "balanced", "today": "2026-11-21", "text": "Ask Raj about it.", "vault": vault_seal, "llm": [],
   "overrides": [{"id": "PERSON_1", "action": "keep", "revealThisTime": False}],
   "expectedText": "Ask [[PERSON_1]] about it.", "expectedLegend": [["PERSON_1", "the user's landlord"]]},
  {"name": "vault reveal this time", "dial": "balanced", "today": "2026-11-21", "text": "Ask Raj about it.", "vault": vault_seal, "llm": [],
   "overrides": [{"id": "PERSON_1", "action": "keep", "revealThisTime": True}],
   "expectedText": "Ask Raj about it.", "expectedLegend": []},
]
w("seal.json", {"description": "End-to-end deterministic seal: normalise -> vault + pattern detectors (data detectors off) + given LLM candidates -> merge -> policy -> sealer -> gate must pass. Ladder defaults used for generalisation (no model).",
                "cases": seal_cases})

# ---------- gate ----------
E_RAJ = {"id": "PERSON_1", "category": "person", "canonical": "Raj Patel", "surfaceForms": ["Raj Patel", "Raj"], "action": "placeholder"}
E_WILL = {"id": "PERSON_1", "category": "person", "canonical": "Will Smith", "surfaceForms": ["Will Smith"], "action": "placeholder"}
E_ORG = {"id": "ORG_1", "category": "org", "canonical": "Mercy General Hospital", "surfaceForms": ["Mercy General Hospital"], "action": "generalise:2"}
V_MAYA = [VAULT[0]]
L_RAJ = [["PERSON_1", "the user's landlord"]]
def g(name, text, legend=L_RAJ, entities=(E_RAJ,), vault=(), revealed=(), kept=(), pass_=False, include=(), tool=False, maxUTF16=None):
    return {"name": name, "text": text, "legend": legend, "entities": list(entities), "vault": list(vault), "revealed": list(revealed),
            "kept": list(kept), "toolResult": tool, "maxUTF16": maxUTF16, "pass": pass_, "mustInclude": list(include)}
gate_cases = [
  g("clean", "Hi [[PERSON_1]], see you soon.", pass_=True),
  g("first name leak", "Hi [[PERSON_1]], Raj said hi.", include=["G2"]),
  g("surname token leak", "Hi [[PERSON_1]], Mr Patel said hi.", include=["G2"]),
  g("common-word first name not blocked", "[[PERSON_1]] said I will call.", entities=[E_WILL], pass_=True),
  g("generalised org leak", "Hi [[PERSON_1]], I work at Mercy General Hospital.", entities=[E_RAJ, E_ORG], include=["G2"]),
  g("vault alias any case", "Hi [[PERSON_1]], thanks, MAYA", vault=V_MAYA, include=["G1"]),
  g("vault revealed this time", "Hi [[PERSON_1]], thanks, Maya", vault=V_MAYA, revealed=["v-me"], pass_=True),
  g("email pattern", "Hi [[PERSON_1]], mail a.b@example.com", include=["G3"]),
  g("kept helpline allowed", "Hi [[PERSON_1]], call 800-555-0199 today.", kept=["800-555-0199"], pass_=True),
  g("zero width", "Hi [[PERSON_1]], R​aj said hi.", include=["G6"]),
  g("homoglyph mixed script", "Hi [[PERSON_1]], Rаj said hi.", include=["G6", "G2"]),
  g("all-cyrillic lookalike", "Hi [[PERSON_1]], Мауа wrote.", vault=V_MAYA, include=["G1"]),
  g("smart quotes", "Hi [[PERSON_1]], “ok”.", include=["G6"]),
  g("malformed placeholder", "Hi [PERSON_1], ok.", include=["G4"]),
  g("unknown placeholder", "Hi [[PERSON_1]] and [[PERSON_2]].", include=["G4"]),
  g("unused legend line", "Hi [[PERSON_1]].", legend=[["PERSON_1", "the user's landlord"], ["ORG_1", "the user's employer"]], entities=[E_RAJ, E_ORG], include=["G4"]),
  g("legend leak", "Hi [[PERSON_1]].", legend=[["PERSON_1", "Raj, the user's landlord"]], include=["G5"]),
  g("legend pattern", "Hi [[PERSON_1]].", legend=[["PERSON_1", "reachable at a.b@example.com"]], include=["G5"]),
  g("too large", "Hi [[PERSON_1]], this is a long message.", maxUTF16=30, include=["G7"]),
  g("tool result clean", "{\"slots\":[\"Tue 24 Nov, 3:00-4:00 pm\",\"Thu 26 Nov, 10:00-11:00 am\"]}", legend=[], tool=True, pass_=True),
  g("tool result leak", "{\"role\":\"Raj is the landlord\"}", legend=[], tool=True, include=["G2"]),
  g("tool result with known placeholder", "{\"role\":\"[[PERSON_1]] is the landlord\"}", legend=[], tool=True, pass_=True),
]
w("gate.json", {"description": "Egress gate conformance. pass=true -> SealedText; else must block with at least the listed checks. Pattern detector with data detectors off.",
                "cases": gate_cases})

print("fixtures written:", sorted(os.listdir(OUT)))
