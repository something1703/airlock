import { StrictMode } from "react";
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
