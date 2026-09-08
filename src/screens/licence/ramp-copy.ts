// The plain-words copy for the OPT-IN gradual ramp's TWO PHASES. Split out of ./shared.ts along
// its own seam (that module reached its line budget): this is the only copy specific to the ramp, it is pure
// and DOM-free, and update-ramp.ts (phase 1) and update-pending-body.ts (phase 2) each want only part of it.
// shared.ts and the licence barrel re-export it so existing importers are unchanged.
//
// The ramp is TWO PHASES and every sentence here turns on that. Starting a ramp CANNOT check the slice it is
// creating (that request is still running the pre-ramp code), so a started ramp is serving real customer
// traffic UNVERIFIED, and a genuinely separate request has to confirm it. The console used to describe the
// ramp as a one-shot, self-verifying, auto-rolling-back action, which is what the atomic apply is, and the
// gap between those two descriptions is the gap an operator falls into.
//
// House rules: Australian English, no em dashes, precise claims.

import type { RampResult, RampSettleResult } from "../../api.ts";

// ---------------------------------------------------------------------------
// PHASE 1: starting the ramp (POST /admin/update/ramp).
// ---------------------------------------------------------------------------

// rampOutcomeLine is the plain-words result of the gradual ramp's PHASE 1 (POST /admin/update/ramp).
// "ramp-pending" states the honest position: the new version is serving N%
// of live traffic and is NOT yet verified (this call structurally cannot canary the slice it just
// created); the verification finishes from the pending panel. "refused"/"no-update" state honestly that
// nothing changed (and why). Pure + DOM-free for the validator.
export function rampOutcomeLine(r: RampResult): string {
  switch (r.outcome) {
    case "ramp-pending":
      return `The new version ${r.toVersion ?? r.recommendedVersion} is now serving ${r.percentage ?? 0}% of live traffic, and is NOT yet verified: a ramp check must run as a separate request to have a chance of landing on the ramped slice. Finish it from the pending panel on this screen (verify the ramp, or roll back); the hourly canary keeps watching in the meantime.`;
    case "no-update":
      return "You are already on the recommended version. Nothing to ramp.";
    case "refused":
      return r.reason ? `This ramp was refused: ${r.reason}. The engine is unchanged.` : "This ramp was refused; the engine is unchanged.";
    default:
      return "The ramp finished.";
  }
}

// ---------------------------------------------------------------------------
// PHASE 2: settling the ramp (POST /admin/update/ramp/settle). The route the console had no client for, and
// the outcomes the atomic settle simply does not have.
// ---------------------------------------------------------------------------

// rampSettleOutcomeLine is the plain-words result of the ramp's PHASE 2 (POST /admin/update/ramp/settle),
// the single-line summary rendered as the settle's detail. "applied" keeps the ramp serving (promote to 100%
// with Update now when confident); "rolled-back" is reassuring (nothing lost, all traffic back on the prior
// version); "inconclusive" is honest about the probabilistic routing: the check could not observe the ramped
// slice, that is not evidence of ill health, and verifying again is meaningful.
//
// "rollback-failed-still-split" IS HANDLED EXPLICITLY, and it must be. This engine emits a
// FOURTH outcome, and an unhandled one falls to the default below, which would report the single worst state
// the update surface can be in ("it failed AND the rollback failed, a share of live traffic is still reaching
// the suspect version") as a benign completion, "The ramp check finished." A settle that concluded safely and
// a deployment that is still split are the opposite of each other, and the copy must never confuse them.
// Pure + DOM-free for the validator.
export function rampSettleOutcomeLine(r: RampSettleResult): string {
  switch (r.outcome) {
    case "applied":
      return `The ramped version ${r.toVersion} passed its check and stays live at its percentage. Promote it to 100% with Update now when you are confident, or roll it back. The hourly canary keeps watching it.`;
    case "rolled-back":
      return r.reason
        ? `The ramp was rolled back: ${r.reason}. Nothing was lost, your data and recovery were never affected, and all traffic is back on ${r.fromVersion}.`
        : `The ramp did not pass its check and was rolled back. Nothing was lost, your data and recovery were never affected, and all traffic is back on ${r.fromVersion}.`;
    case "inconclusive":
      return r.reason
        ? `This check was inconclusive: ${r.reason}. Traffic is unchanged (still split); verify again, each check has a fresh chance of landing on the ramped slice, or roll back.`
        : "This check was inconclusive: it could not observe the ramped slice (traffic is split, so a check only lands on the new version some of the time). That is not evidence of a problem. Traffic is unchanged; verify again or roll back.";
    case "rollback-failed-still-split":
      return rampStillSplitLine(r.fromVersion, r.toVersion);
    default:
      return "The ramp check finished.";
  }
}

// rampPendingBanner replaces the atomic pending banner's "it is deployed and live" for a RAMPED pending,
// because that sentence is wrong for a ramp in the way that matters most: the new version is live to a SHARE
// of real customer traffic, not all of it, and the operator's decision (finish verifying, or roll back) is
// about that share. It also states the honest quirk of a ramp settle, which the atomic settle never has: a
// verification attempt only tests the new version if it happens to be routed onto the ramped slice, so an
// attempt can come back with nothing decided and simply need pressing again.
export function rampPendingBanner(toVersion: string, percentage: number): string {
  return `Verification is pending for ${toVersion}: it is serving ${percentage}% of live traffic in a gradual ramp, and its canary check did not finish. Finish it now, verify and keep it at ${percentage}%, or roll back to the prior version in one click. Because only ${percentage}% of traffic reaches the new version, a check can come back with nothing decided; press the button again if it does, each attempt is a fresh chance of landing on the ramped slice. If you leave it, the hourly canary keeps checking ${toVersion} and raises a critical alert if it is unhealthy (the engine will not silently auto-deploy a rollback).`;
}

// rampInconclusiveLine is the terminal sentence for the "inconclusive" outcome: the whole retry budget was
// spent and every attempt came back from a healthy engine saying the same true thing. NOTHING was changed, the
// ramp is still serving its configured percentage, and the pending is still armed. This is not a fault, and it
// must never be rendered as the stall line ("could not be read"): the difference between this and a stuck
// engine is the difference between pressing the button again and unpicking a traffic split by hand.
export function rampInconclusiveLine(toVersion: string): string {
  return `Nothing was decided and nothing was changed: these checks were routed to the prior version, not to ${toVersion}, so they prove nothing about the ramped version. The ramp is untouched and still serving its configured percentage. Verify again, each attempt has a fresh chance of landing on the ramped slice.`;
}

// rampAppliedLine: a KEPT ramp is NOT a finished update. The version is trusted and it stays at its ramped
// percentage; going to 100% is a separate, deliberate act (the normal apply). Saying "is live" here, as the
// atomic settle's line does, would tell the operator the rollout is over when most of their traffic is still
// on the prior version.
export function rampAppliedLine(toVersion: string, percentage: number | null): string {
  const at = percentage === null ? "its ramped percentage" : `${percentage}% of live traffic`;
  return `Verified on its own code: ${toVersion} is trusted and stays at ${at}. Promote it to 100% with the normal update when you are comfortable, or roll it back at any time.`;
}

// rampStillSplitLine (engine G219) is the loudest sentence in the update surface, and it is loud because the
// state is: the ramped version FAILED verification and the rollback to 100% prior ALSO failed, so a share of
// real customer traffic is being routed to the suspect version right now. Data and recovery are unaffected
// (archives are immutable and restore is out-of-band), and the sentence says so, because the operator's next
// move is a Cloudflare-side re-deploy, not a panic about their backups.
export function rampStillSplitLine(fromVersion: string, toVersion: string): string {
  return `${toVersion} did not pass verification AND the rollback failed: the deployment is STILL SPLIT and a share of live traffic is still reaching ${toVersion}. Re-deploy ${fromVersion} from the Cloudflare dashboard. Your backups and your ability to restore are unaffected.`;
}
