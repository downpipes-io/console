// Client MIRROR of the engine's Owner-count floor invariant (engine: src/admin/owner-floor.ts). The engine is
// the authority on both refusals; this pre-empts them in the UI so an operator is stopped UPFRONT with a
// helpful message instead of a cryptic 400 after the fact. It keeps the single-owner dual-control DEADLOCK out
// of reach: a lone Owner cannot arm Require Approver, and a live dual-control estate cannot be dropped below
// two Owners. The count is the OWNER role specifically (see activeOwnerCount), matching the engine.
//
// House rules: Australian English, no em dashes, precise claims. Never the boundary: the engine re-checks both.

export const DUAL_CONTROL_MIN_OWNERS = 2;

// ownerFloor mirrors the engine: one Owner while dual control is off, two while it is on.
export function ownerFloor(dualControlOn: boolean): number {
  return dualControlOn ? DUAL_CONTROL_MIN_OWNERS : 1;
}

// removingOwnerWouldStrand answers whether removing or demoting ONE Owner would drop the estate below its
// floor, given the current active-Owner count (the target inclusive) and the live gate state. FAIL-SAFE like
// the engine: an unusable count blocks (the control disables) rather than offering an action the engine will
// refuse. A NaN comparison would otherwise read as "allowed", so the guard is explicit.
export function removingOwnerWouldStrand(ownerCount: number, dualControlOn: boolean): boolean {
  if (!Number.isInteger(ownerCount) || ownerCount < 1) return true;
  return ownerCount - 1 < ownerFloor(dualControlOn);
}

// canRequireDualControl answers whether dual control may be enabled: at least two Owners must exist so a maker
// always has a distinct second Owner to approve them. Mirrors the engine's enable guard.
export function canRequireDualControl(ownerCount: number): boolean {
  return Number.isInteger(ownerCount) && ownerCount >= DUAL_CONTROL_MIN_OWNERS;
}

// The operator-facing reasons the console shows upfront. They speak in the second person and say how to
// proceed; the engine's own sentences (which the toast still surfaces on any refusal that slips through) are
// separate. The engine enforces both server-side regardless.
export const ENABLE_DUAL_CONTROL_NEEDS_TWO_OWNERS =
  "Add a second Owner before you can require dual approval. Dual control needs a second Owner to approve a change; a lone Owner cannot be their own approver.";
export const DUAL_CONTROL_FLOOR_REMOVE_REASON =
  "Dual approval is on, so the estate must keep at least two Owners. Appoint another Owner, or turn off Require Approver, before removing or demoting this one.";
