import { createContext, useContext, useSyncExternalStore } from "react";
import type { AirlockSession, State } from "./session";

export const SessionContext = createContext<AirlockSession | null>(null);

export function useSession(): AirlockSession {
  const s = useContext(SessionContext);
  if (!s) throw new Error("SessionContext missing");
  return s;
}

/** Subscribes the component to session state. */
export function useAirlock(): State {
  const s = useSession();
  return useSyncExternalStore(s.subscribe, s.getState);
}
