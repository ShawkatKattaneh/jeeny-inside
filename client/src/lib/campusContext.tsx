import { createContext, useContext, type ReactNode } from "react";
import type { CampusConfig } from "../../../shared/schemas";
import { fetchCampus } from "./api";
import { useApi } from "./useApi";

const CampusCtx = createContext<CampusConfig | null>(null);
/** Exported so tests can supply a campus without the network. */
export const CampusContext = CampusCtx;

/** Loads the campus once for the whole app. Every screen draws from the same config. */
export function CampusProvider({ children }: { children: ReactNode }) {
  const state = useApi(fetchCampus);
  if (state.status === "loading") return <FullScreenNote text="Loading campus…" />;
  if (state.status === "error")
    return <FullScreenNote text={`Can't reach the Jeeny INSIDE server (${state.message}). Is the laptop running it, and is this phone on the same hotspot?`} />;
  return <CampusCtx.Provider value={state.data}>{children}</CampusCtx.Provider>;
}

export function useCampus(): CampusConfig {
  const c = useContext(CampusCtx);
  if (!c) throw new Error("useCampus must be used inside CampusProvider");
  return c;
}

function FullScreenNote({ text }: { text: string }) {
  return <div className="grid min-h-full place-items-center p-8 text-center text-sm text-muted">{text}</div>;
}
