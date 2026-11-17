import { useAirlock, useSession } from "../app/context";
import type { Screen } from "../app/session";
import { Ask } from "./screens/Ask";
import { LedgerScreen } from "./screens/Ledger";
import { Onboarding } from "./screens/Onboarding";
import { ReviewScreen } from "./screens/Review";
import { SettingsScreen } from "./screens/Settings";
import { ThreadScreen } from "./screens/Thread";
import { VaultScreen } from "./screens/Vault";
import { IconAsk, IconLedger, IconSettings, IconVault, Logo } from "./icons";
import type { ReactNode } from "react";

const NAV: { id: Screen; label: string; icon: ReactNode }[] = [
  { id: "ask", label: "Ask", icon: <IconAsk /> },
  { id: "ledger", label: "Ledger", icon: <IconLedger /> },
  { id: "vault", label: "Vault", icon: <IconVault /> },
  { id: "settings", label: "Settings", icon: <IconSettings /> },
];

export function App() {
  const s = useSession();
  const { screen, threads, currentThreadId } = useAirlock();
  if (screen === "onboarding") return <Onboarding />;
  const active: Screen = screen === "review" || screen === "thread" ? "ask" : screen;
  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Main">
        <div className="brand"><Logo size={30} animated />Airlock</div>
        {NAV.map((n) => <button key={n.id} className="nav-btn" aria-current={active === n.id && screen !== "thread" ? "page" : undefined} onClick={() => s.go(n.id)}>{n.icon}{n.label}</button>)}
        {threads.length > 0 && <div className="small" style={{ padding: "14px 12px 4px" }}>Conversations</div>}
        {threads.slice(0, 8).map((t) => <button key={t.id} className="nav-btn small" aria-current={screen === "thread" && currentThreadId === t.id ? "page" : undefined} onClick={() => s.openThread(t.id)}>{t.title}</button>)}
        <div className="sidebar-foot">Private details are sealed on this device before anything reaches Gemini.</div>
      </nav>
      <main className="main">
        {screen === "ask" && <Ask />}
        {screen === "review" && <ReviewScreen />}
        {screen === "thread" && <ThreadScreen />}
        {screen === "ledger" && <LedgerScreen />}
        {screen === "vault" && <VaultScreen />}
        {screen === "settings" && <SettingsScreen />}
      </main>
    </div>
  );
}
