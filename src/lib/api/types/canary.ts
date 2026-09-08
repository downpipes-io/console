// Canary backup mirror types, split out of ../types.ts (move-only). See ../types.ts for the barrel.

// ---- Canary backup (mirrors the engine's src/canary/types.ts) ---------------------------------
// The console reads these redaction-safe shapes; it never sees a value, a key or a real hash, only
// the bird's liveness, the per-flight aspect outcomes, and counts.
export type CanaryLiveness = "alive" | "dead" | "ailing" | "pending" | "disabled";
export type CanaryAspectKey =
  | "write-probe"
  | "delete-probe"
  | "seal"
  | "read-signature"
  | "runlog-freshness"
  | "decrypt-integrity"
  | "restore"
  | "restore-verify";
export type CanaryAspectOutcome = "pass" | "fail" | "skip" | "note";
export interface CanaryAspectResult {
  readonly key: CanaryAspectKey;
  readonly outcome: CanaryAspectOutcome;
  readonly detail: string;
}
// CanaryAilingCause mirrors the engine's closed enum exactly (the wire contract): "unreachable" and
// "other" are genuine check problems. Optional: a record from before this field existed, or a dead/alive
// result, reads as absent. "no-read-back-key" was removed alongside the engine's copy once a
// break-glass-only flight stopped ailing by posture, because the state it described no longer occurs.
export type CanaryAilingCause = "unreachable" | "other";
export interface CanaryCheck {
  readonly at: string;
  readonly ok: boolean;
  readonly status: CanaryLiveness;
  readonly durationMs: number;
  readonly destinationId: string | null;
  readonly runSeq: number;
  readonly aspects: CanaryAspectResult[];
  readonly byteDelta: number | null;
  readonly deadReason: string | null;
  readonly ailingCause?: CanaryAilingCause;
}
// CanaryFlight is one whole flight: the per-destination results plus the aggregate status.
export interface CanaryFlight {
  readonly at: string;
  readonly runSeq: number;
  readonly status: CanaryLiveness; // aggregate (dead if any destination died)
  readonly results: CanaryCheck[]; // one per destination flown
}
// CanaryDestView is one destination the canary flies to: its label, liveness, and latest result.
export interface CanaryDestView {
  readonly destinationId: string | null;
  readonly label: string;
  readonly isDefault: boolean;
  readonly status: CanaryLiveness;
  readonly lastRunAt: string | null;
  readonly deadSince: string | null;
  readonly lastCheck: CanaryCheck | null;
}
export interface CanaryConfig {
  readonly enabled: boolean;
  readonly destinationIds: string[] | null; // null = all destinations (auto-including new ones); array = pinned subset
  readonly intervalSeconds: number;
}
export interface CanaryView {
  readonly config: CanaryConfig;
  readonly status: CanaryLiveness; // aggregate (worst across destinations)
  readonly lastRunAt: string | null;
  readonly nextRunAt: number | null;
  readonly inFlight: boolean;
  readonly runSeq: number;
  readonly dests: CanaryDestView[]; // the destinations the canary currently flies to, with per-destination state
  readonly history: CanaryFlight[];
  readonly allDestinations: Array<{ readonly id: string; readonly label: string; readonly isDefault: boolean }>; // the whole collection (for the picker)
  readonly destinationCount: number;
  readonly flyingToAll: boolean; // true when config.destinationIds is null
  // danglingPins are PINNED destination ids that no longer name a destination in the collection: the
  // engine refuses an unknown pin at save time, so one can only go dangling later, when the destination
  // it named is deleted. The engine then drops it from the flight silently and correctly (it must still
  // fly somewhere), which is why it has to be surfaced HERE: the pin renders no checkbox in the picker,
  // because the picker is built from allDestinations, so without this field the operator's chosen
  // destination stops being proven with nothing on screen to say so.
  //
  // Optional because an older engine does not send it; absent and empty both mean "nothing to warn about".
  readonly danglingPins?: readonly string[];
}
export interface CanaryConfigPatch {
  readonly enabled?: boolean;
  readonly destinationIds?: string[] | null;
  readonly intervalSeconds?: number;
}
