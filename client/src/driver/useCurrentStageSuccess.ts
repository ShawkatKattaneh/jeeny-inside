import { useRef } from "react";
import type { DriverActionState } from "../lib/driverActions";

/**
 * A driver action's success message belongs to the stage it was shown at. Once the trip moves on (for
 * example from "Driving to pickup" to "At pickup"), the old message ("Trip started.") would contradict
 * the next step, so it is no longer shown. The action controller and its state are not changed; this
 * only decides whether the card displays the message.
 */
export function useCurrentStageSuccess(state: DriverActionState, stage: string): boolean {
  const seen = useRef<{ state: DriverActionState; stage: string } | null>(null);
  if (state.status !== "success") {
    seen.current = null;
    return false;
  }
  if (seen.current?.state !== state) seen.current = { state, stage };
  return seen.current.stage === stage;
}
