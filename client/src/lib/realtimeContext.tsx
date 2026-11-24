import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { io } from "socket.io-client";
import { createRealtimeStore, type RealtimeState, type RealtimeStore } from "./realtimeStore";

const RealtimeCtx = createContext<RealtimeStore | null>(null);

/**
 * One Socket.IO connection for the whole app. Same origin, default /socket.io path: the demo build
 * serves the socket from the same server, and the Vite dev server proxies /socket.io. The connection
 * opens when the provider mounts and closes when it unmounts. Tests pass their own store.
 */
export function RealtimeProvider({ store: injected, children }: { store?: RealtimeStore; children: ReactNode }) {
  const [store] = useState(() => injected ?? createRealtimeStore({ socket: io({ autoConnect: false }) }));
  useEffect(() => {
    store.start();
    return () => store.stop();
  }, [store]);
  return <RealtimeCtx.Provider value={store}>{children}</RealtimeCtx.Provider>;
}

export function useRealtimeStore(): RealtimeStore {
  const s = useContext(RealtimeCtx);
  if (!s) throw new Error("useRealtimeStore must be used inside RealtimeProvider");
  return s;
}

/** The latest realtime state; re-renders only when it changes. */
export function useRealtime(): RealtimeState {
  const store = useRealtimeStore();
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
