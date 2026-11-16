// Checksum and plausibility validators (port of Validators.swift). Pinned by spec/fixtures/validators.json.

const isDigit = (c: string): boolean => c >= "0" && c <= "9";
const digitsOf = (s: string): string => [...s].filter(isDigit).join("");
const chars = (s: string): string[] => [...s];

export function luhn(s: string): boolean {
  const digits = chars(s).filter(isDigit).map(Number);
  const nonSeparators = chars(s).filter((c) => !/\s/u.test(c) && c !== "-").length;
  if (digits.length < 2 || digits.length !== nonSeparators) return false;
  let sum = 0;
  [...digits].reverse().forEach((d, i) => {
    if (i % 2 === 1) {
      const dd = d * 2;
      sum += dd > 9 ? dd - 9 : dd;
    } else sum += d;
  });
  return sum % 10 === 0;
}

export function card(s: string): boolean {
  const digits = digitsOf(s);
  if (digits.length < 13 || digits.length > 19 || new Set(digits).size <= 1) return false;
  return luhn(s);
}

export function iban(s: string): boolean {
  const compact = s.toUpperCase().replace(/\s/gu, "");
  if (compact.length < 15 || compact.length > 34 || !/^[A-Z0-9]+$/.test(compact)) return false;
  if (!/^[A-Z]{2}[0-9]{2}/.test(compact)) return false;
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const c of rearranged) {
    if (isDigit(c)) remainder = (remainder * 10 + Number(c)) % 97;
    else remainder = (remainder * 100 + (c.charCodeAt(0) - 55)) % 97;
  }
  return remainder === 1;
}

export function ssn(s: string): boolean {
  const parts = s.split("-").filter((p) => p.length > 0);
  if (parts.length !== 3 || parts[0]!.length !== 3 || parts[1]!.length !== 2 || parts[2]!.length !== 4) return false;
  if (!parts.every((p) => /^[0-9]+$/.test(p))) return false;
  const [area, group, serial] = parts.map(Number) as [number, number, number];
  return area !== 0 && area !== 666 && area < 900 && group !== 0 && serial !== 0;
}

export function ukNI(s: string): boolean {
  const compact = s.toUpperCase().replace(/\s/gu, "");
  if (compact.length !== 9) return false;
  const invalid = new Set(["BG", "GB", "NK", "KN", "TN", "NT", "ZZ"]);
  return !invalid.has(compact.slice(0, 2)) && compact[1] !== "O";
}

const VD = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6], [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1], [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4], [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VP = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2], [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1], [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

export function verhoeff(s: string): boolean {
  const digits = chars(s).filter(isDigit).map(Number);
  if (digits.length === 0) return false;
  let c = 0;
  [...digits].reverse().forEach((d, i) => {
    c = VD[c]![VP[i % 8]![d]!]!;
  });
  return c === 0;
}

export function aadhaar(s: string): boolean {
  const digits = digitsOf(s);
  return digits.length === 12 && Number(digits[0]) >= 2 && verhoeff(digits);
}

export const pan = (s: string): boolean => {
  const c = s.toUpperCase();
  return c.length === 10 && "PCHFATBLJG".includes(c[3]!);
};

export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  const cs = chars(s);
  for (const c of cs) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const k of counts.values()) {
    const p = k / cs.length;
    h -= p * Math.log2(p);
  }
  return h;
}

export function phone(s: string): boolean {
  const n = digitsOf(s).length;
  if (n < 7 || n > 15) return false;
  return !(/^\d{4}-\d{2}-\d{2}$/.test(s) || /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/.test(s));
}

export const hasDigit = (s: string): boolean => chars(s).some(isDigit);
export const plate = (s: string): boolean => hasDigit(s) && /\p{L}/u.test(s);
export const entropySecret = (s: string): boolean =>
  chars(s).length >= 24 && /\p{L}/u.test(s) && hasDigit(s) && shannonEntropy(s) >= 3.5;

const PROFILE_HOSTS = [
  "facebook.com", "instagram.com", "linkedin.com", "x.com", "twitter.com", "tiktok.com", "github.com", "youtube.com", "threads.net",
  "reddit.com", "t.me", "wa.me", "venmo.com", "cash.app",
];
const IDENTIFYING = [
  "id=", "uid", "user", "token", "account", "acct", "profile", "member", "session", "invite", "reset", "email=", "phone=", "/u/", "/in/", "/@", "ref=",
];

/** URL that points at a person or carries identifiers; bare domains and generic paths are not identifying. */
export function urlIdentifying(s: string): boolean {
  let rest = s.toLowerCase();
  for (const scheme of ["https://", "http://"]) if (rest.startsWith(scheme)) rest = rest.slice(scheme.length);
  const cut = rest.search(/[/?#]/);
  const host = (cut >= 0 ? rest.slice(0, cut) : rest).replaceAll("www.", "");
  const path = cut >= 0 ? rest.slice(cut) : "";
  const meaningful = path.replace(/^[/?#]+|[/?#]+$/g, "");
  if (PROFILE_HOSTS.some((h) => host === h || host.endsWith("." + h)) && meaningful.length > 0) return true;
  if (IDENTIFYING.some((t) => path.includes(t))) return true;
  return path.split(/[^\p{L}\p{N}]+/u).some((run) => run.length >= 8 && hasDigit(run));
}

export type Validator = (s: string) => boolean;

/** Looks up a validator by the name used in pattern packs and fixtures. */
export function named(name: string): Validator | undefined {
  const table: Record<string, Validator> = {
    luhn, card, iban, ssn, uk_ni: ukNI, verhoeff, aadhaar, pan, phone, has_digit: hasDigit, plate, entropy_secret: entropySecret,
    url_identifying: urlIdentifying,
  };
  return table[name];
}
