// Airlock's own icon set: 24px grid, 1.8px round strokes, currentColor. Drawn for this app (no icon fonts,
// no system emoji), so every platform renders the same. Decorative by default (aria-hidden); labels live
// on the element that carries meaning.
import type { ReactNode, SVGProps } from "react";
import type { PrivacyCategory } from "../engine/types";

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 18, children, ...rest }: P & { children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
      {children}
    </svg>
  );
}

export const IconAsk = (p: P) => <Svg {...p}><path d="M4 18.5V6.5a2.5 2.5 0 0 1 2.5-2.5h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H9l-5 2.5Z" /><path d="M9 9.5h6M9 12.5h3.5" /></Svg>;
export const IconLedger = (p: P) => <Svg {...p}><path d="M6 3.5h12v17l-2-1.3-2 1.3-2-1.3-2 1.3-2-1.3-2 1.3Z" /><path d="M9 8h6M9 11.5h6M9 15h3" /></Svg>;
export const IconVault = (p: P) => <Svg {...p}><path d="M12 3 5 6v5.5c0 4.2 2.9 7.8 7 9.5 4.1-1.7 7-5.3 7-9.5V6Z" /><rect x="9" y="10.5" width="6" height="5" rx="1.2" /><path d="M10.3 10.5V9a1.7 1.7 0 0 1 3.4 0v1.5" /></Svg>;
export const IconSettings = (p: P) => <Svg {...p}><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></Svg>;
export const IconPerson = (p: P) => <Svg {...p}><circle cx="12" cy="8.5" r="3.5" /><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5" /></Svg>;
export const IconOrg = (p: P) => <Svg {...p}><path d="M4 20.5h16M6 20.5V5.5l7-2v17M13 8.5l5 1.5v10.5" /><path d="M9 8h1M9 11.5h1M9 15h1M16 13h.5M16 16.5h.5" /></Svg>;
export const IconPlace = (p: P) => <Svg {...p}><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0C18.5 15.4 12 21 12 21Z" /><circle cx="12" cy="10" r="2.3" /></Svg>;
export const IconContact = (p: P) => <Svg {...p}><rect x="3.5" y="5.5" width="17" height="13" rx="2.5" /><path d="m4.5 7 7.5 5.5L19.5 7" /></Svg>;
export const IconId = (p: P) => <Svg {...p}><rect x="3.5" y="5.5" width="17" height="13" rx="2.5" /><path d="M9.5 9.5 8.5 15M14 9.5 13 15M7.5 11h8M7 13.5h8" /></Svg>;
export const IconDate = (p: P) => <Svg {...p}><rect x="4" y="5.5" width="16" height="14.5" rx="2.5" /><path d="M4 10h16M8.5 3.5v3.5M15.5 3.5v3.5" /></Svg>;
export const IconHealth = (p: P) => <Svg {...p}><path d="M12 20s-7.5-4.4-7.5-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.5 10c0 5.6-7.5 10-7.5 10Z" /><path d="M8 12.5h2l1.2-2 1.6 4 1.2-2h2" /></Svg>;
export const IconSecret = (p: P) => <Svg {...p}><circle cx="8" cy="14" r="3.5" /><path d="m10.5 11.5 8-8M15.5 6.5l2 2M13.5 8.5l1.5 1.5" /></Svg>;
export const IconSparkle = (p: P) => <Svg {...p}><path d="M12 3.5c.6 4.2 2.3 5.9 6.5 6.5-4.2.6-5.9 2.3-6.5 6.5-.6-4.2-2.3-5.9-6.5-6.5 4.2-.6 5.9-2.3 6.5-6.5Z" /><path d="M18.5 16v4M16.5 18h4" /></Svg>;
export const IconDevice = (p: P) => <Svg {...p}><rect x="4" y="4.5" width="16" height="11" rx="2" /><path d="M2.5 19.5h19M9.5 15.5l-.5 4M14.5 15.5l.5 4" /></Svg>;
export const IconCloud = (p: P) => <Svg {...p}><path d="M7 18.5a4.5 4.5 0 0 1-.4-9 6 6 0 0 1 11.3 1.6A3.8 3.8 0 0 1 17.5 18.5Z" /></Svg>;
export const IconCheck = (p: P) => <Svg {...p}><path d="m5 12.5 4.5 4.5L19 7.5" /></Svg>;
export const IconShield = (p: P) => <Svg {...p}><path d="M12 3 5 6v5.5c0 4.2 2.9 7.8 7 9.5 4.1-1.7 7-5.3 7-9.5V6Z" /><path d="m9 12 2 2 4-4" /></Svg>;
export const IconEye = (p: P) => <Svg {...p}><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="2.8" /></Svg>;
export const IconTrash = (p: P) => <Svg {...p}><path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10 11v5.5M14 11v5.5" /></Svg>;
export const IconPlus = (p: P) => <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>;
export const IconArrow = (p: P) => <Svg {...p}><path d="M5 12h14M13 6l6 6-6 6" /></Svg>;
export const IconLink = (p: P) => <Svg {...p}><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></Svg>;
export const IconAlert = (p: P) => <Svg {...p}><path d="M12 4 2.8 19.5h18.4Z" /><path d="M12 10v4.5M12 17v.2" /></Svg>;
export const IconQuestion = (p: P) => <Svg {...p}><circle cx="12" cy="12" r="8.5" /><path d="M9.6 9.6a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.4M12 16.8v.2" /></Svg>;

export const CATEGORY_ICON: Record<PrivacyCategory, (p: P) => ReactNode> = {
  person: IconPerson, org: IconOrg, location: IconPlace, contact: IconContact, id: IconId, date: IconDate, health: IconHealth, secret: IconSecret, quasi: IconSparkle,
};

/**
 * The Airlock mark: two nested arcs (the doors) over a sill. `animated` draws the arcs on and lets the
 * inner door breathe — used in the sidebar, onboarding and the seal transition.
 */
export function Logo({ size = 28, animated = false }: { size?: number; animated?: boolean }) {
  return (
    <svg className={`logo${animated ? " animated" : ""}`} width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <path className="arc outer" d="M12 42a20 20 0 0 1 40 0" pathLength={1} />
      <path className="arc inner" d="M21 42a11 11 0 0 1 22 0" pathLength={1} />
      <path className="sill" d="M10 50h44" pathLength={1} />
    </svg>
  );
}
