/**
 * The realtime contract shared by the server and future clients (Phase 2 Prompt 3).
 * Payload shapes are StateSnapshot and StateUpdate in shared/schemas.ts.
 */

/** Server -> client: the whole ride state at one revision. Sent on every connection and on request. */
export const SNAPSHOT_EVENT = "state:snapshot";
/** Server -> client: one per committed operation, with everything that operation changed. */
export const UPDATE_EVENT = "state:update";
/** Client -> server, with an acknowledgement callback: "send me a fresh snapshot". The only client event. */
export const SNAPSHOT_REQUEST_EVENT = "state:snapshot:request";

/**
 * What a client should do with an update, given the revision it holds:
 * - "apply": the very next revision; apply it and hold the new revision.
 * - "stale": a revision it already has (a duplicate or an old one); ignore it.
 * - "gap":   one or more revisions were missed; do not apply it, ask for a fresh snapshot instead.
 */
export function classifyRevision(heldRevision: number, incomingRevision: number): "apply" | "stale" | "gap" {
  if (incomingRevision <= heldRevision) return "stale";
  return incomingRevision === heldRevision + 1 ? "apply" : "gap";
}
