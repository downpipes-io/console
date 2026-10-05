// THE ONE decision every surface must share when it says the engine can currently open a run with the
// operational key on its own: an unattended restore test, an automated drill, in-account retention
// pruning, or the plain claim that the engine self-decrypts.
//
// operationalConfigured.private is PRESENCE only: the secret is bound. It stays true even after an Owner
// chooses strict break-glass-only and the engine records the OPERATIONAL_RETIRED marker, because the
// engine cannot delete its own secrets, only the Owner's one-shot break-glass-only switch can. While that
// marker is bound the engine seals every new run to the break-glass key alone and opens no run with the
// operational private, so a surface that reads presence alone tells an owner their engine still
// self-tests when it does not. operationalRetired carries that marker; this leaf is the one place the two
// fields are combined, so no surface can drift from another on the same account.
export function engineHoldsUsableOperationalKey(
  status:
    | { operationalConfigured?: { private?: boolean } | null; operationalRetired?: boolean | undefined }
    | null
    | undefined,
): boolean {
  if (status == null) return false;
  const op = status.operationalConfigured;
  if (op == null || op.private !== true) return false;
  return status.operationalRetired !== true;
}

// RecoveryPosture is the tri-state a copy surface can act on: which recovery actions the engine
// currently offers. "unknown" covers both an unreachable engine and a reached one that answered
// without the posture field, because a surface knows exactly as much in both cases and must not
// guess which posture it is showing advice for.
export type RecoveryPosture = "operational" | "break-glass-only" | "unknown";

// readRecoveryPosture wraps engineHoldsUsableOperationalKey with the "could not tell" case a copy
// surface needs: a status that never arrived, or one that arrived without the posture field, reads
// "unknown" rather than being folded into "break-glass-only".
export function readRecoveryPosture(
  status:
    | { operationalConfigured?: { private?: boolean } | null; operationalRetired?: boolean | undefined }
    | null
    | undefined,
): RecoveryPosture {
  if (status == null) return "unknown";
  const op = status.operationalConfigured;
  if (op == null || typeof op !== "object") return "unknown";
  return engineHoldsUsableOperationalKey(status) ? "operational" : "break-glass-only";
}
