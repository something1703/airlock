import { useAirlock, useSession } from "../app/context";
import type { Screen } from "../app/session";
import { Ask } from "./screens/Ask";
import { LedgerScreen } from "./screens/Ledger";
import { Onboarding } from "./screens/Onboarding";
import { ReviewScreen } from "./screens/Review";
import { SettingsScreen } from "./screens/Settings";
import { ThreadScreen } from "./screens/Thread";
import { VaultScreen } from "./screens/Vault";

const NAV: { id: Screen; label: string; icon: string }[] = [
  { id: "ask", label: "Ask", icon: "✎" },
  { id: "ledger", label: "Ledger", icon: "≣" },
  { id: "vault", label: "Vault", icon: "🔒" },
  { id: "settings", label: "Settings", icon: "⚙" },
];

export function App() {
  const s = useSession();
  const { screen, threads, currentThreadId } = useAirlock();
  if (screen === "onboarding") return <Onboarding />;
  const active: Screen = screen === "review" || screen === "thread" ? "ask" : screen;
  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Main">
        <div className="brand"><img src="/favicon.svg" width="28" height="28" alt="" />Airlock</div>
        {NAV.map((n) => <button key={n.id} className="nav-btn" aria-current={active === n.id && screen !== "thread" ? "page" : undefined} onClick={() => s.go(n.id)}><span aria-hidden="true">{n.icon}</span>{n.label}</button>)}
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
