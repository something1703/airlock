import { StrictMode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { SessionContext } from "./app/context";
import { createServices } from "./app/services";
import { AirlockSession } from "./app/session";
import { App } from "./ui/App";
import "./ui/styles.css";

async function start(): Promise<void> {
  const root = document.getElementById("root");
  if (!root) return;
  const services = await createServices(location.search);
  const session = new AirlockSession(services);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  session.setTransitionRunner((render) => {
    if (typeof document.startViewTransition !== "function" || reduced.matches) return render();
    document.startViewTransition(() => flushSync(render));
  });
  createRoot(root).render(
    <StrictMode>
      <SessionContext.Provider value={session}>
        <App />
      </SessionContext.Provider>
    </StrictMode>,
  );
  await session.load();
}

void start();
