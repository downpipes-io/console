// The plain-words copy for the OPT-IN gradual ramp's TWO PHASES. Split out of ./shared.ts along
// its own seam (that module reached its line budget): this is the only copy specific to the ramp, it is pure
// and DOM-free, and update-ramp.ts (phase 1) and update-pending-body.ts (phase 2) each want only part of it.
// shared.ts and the licence barrel re-export it so existing importers are unchanged.
//
// The ramp is TWO PHASES and every sentence here turns on that. Starting a ramp CANNOT check the slice it is
// creating (that request is still running the pre-ramp code), so a started ramp is serving real customer
// traffic UNVERIFIED, and a genuinely separate request has to confirm it. This is easily confused with the
// atomic apply, which really is a one-shot, self-verifying, auto-rolling-back action; the gap between those
// two descriptions is the gap an operator can fall into.

import type { RampResult, RampSettleResult } from "../../api.ts";

// looksLikePlainVersion is a local mirror of shared.ts's own parseSemverTriple-backed validReleaseVersion:
// shared.ts imports rampOutcomeLine/rampSettleOutcomeLine FROM this file, so importing shared.ts's helper
// back here would cycle. toVersion/fromVersion on every ramp result are Cloudflare deploy ids; recommendedVersion
// is the plain release version, validated with this same rule before it reaches an operator.
function looksLikePlainVersion(v: string): boolean {
  return /^v?\d+\.\d+\.\d+$/.test(v.trim());
}
function plainVersion(v: string): string | null {
  return looksLikePlainVersion(v) ? v : null;
}

// ---------------------------------------------------------------------------
// PHASE 1: starting the ramp (POST /admin/update/ramp).
// ---------------------------------------------------------------------------

// rampOutcomeLine is the plain-words result of the gradual ramp's PHASE 1 (POST /admin/update/ramp,
// which is two-phase). "ramp-pending" states the honest position: the new version is serving N%
// of live traffic and is NOT yet verified (this call structurally cannot canary the slice it just
// created); the verification finishes from the pending panel. "refused"/"no-update" state honestly that
// nothing changed (and why). Pure + DOM-free for the validator.
export function rampOutcomeLine(r: RampResult): string {
  switch (r.outcome) {
    case "ramp-pending": {
      // r.toVersion is the Cloudflare deploy id; r.recommendedVersion (always present) is the plain release
      // version an operator recognises, so it names the release, never the id.
      const version = plainVersion(r.recommendedVersion);
      const lead = version ? `The new version ${version}` : "The new version";
      return `${lead} is now serving ${r.percentage ?? 0}% of live traffic, and is NOT yet verified: a ramp check must run as a separate request to have a chance of landing on the ramped slice. Finish it from the pending panel on this screen (verify the ramp, or roll back); the hourly canary keeps watching in the meantime.`;
    }
    case "no-update":
      return "You are already on the recommended version. Nothing to ramp.";
    case "refused":
      return r.reason ? `This ramp was refused: ${r.reason}. The engine is unchanged.` : "This ramp was refused; the engine is unchanged.";
    default:
      return "The ramp finished.";
  }
}

// ---------------------------------------------------------------------------
// PHASE 2: settling the ramp (POST /admin/update/ramp/settle), whose outcomes the atomic settle simply does
// not have.
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
    case "applied": {
      // r.toVersion is the Cloudflare deploy id; r.recommendedVersion (always present) is the plain release
      // version the ramp is verifying, so it names that instead.
      const version = plainVersion(r.recommendedVersion);
      const which = version ? `The ramped version ${version}` : "The ramped version";
      return `${which} passed its check and stays live at its percentage. Promote it to 100% with Update now when you are confident, or roll it back. The hourly canary keeps watching it.`;
    }
    case "rolled-back":
      // r.fromVersion (the prior version traffic returns to) has no plain-version counterpart on the wire, so
      // the reassurance names the fact, not an id.
      return r.reason
        ? `The ramp was rolled back: ${r.reason}. Nothing was lost, your data and recovery were never affected, and all traffic is back on the prior version.`
        : "The ramp did not pass its check and was rolled back. Nothing was lost, your data and recovery were never affected, and all traffic is back on the prior version.";
    case "inconclusive":
      return r.reason
        ? `This check was inconclusive: ${r.reason}. Traffic is unchanged (still split); verify again, each check has a fresh chance of landing on the ramped slice, or roll back.`
        : "This check was inconclusive: it could not observe the ramped slice (traffic is split, so a check only lands on the new version some of the time). That is not evidence of a problem. Traffic is unchanged; verify again or roll back.";
    case "rollback-failed-still-split":
      return rampStillSplitLine(plainVersion(r.recommendedVersion), r.fromVersion);
    default:
      return "The ramp check finished.";
  }
}

// rampPendingBanner replaces the atomic pending banner's "it is deployed and live" for a RAMPED pending,
// because that sentence is wrong for a ramp in the way that matters most: the new version is live to a SHARE
// of real customer traffic, not all of it, and the operator's decision (finish verifying, or roll back) is
// about that share. It also states the honest quirk of a ramp settle, which the atomic settle never has: a
// verification attempt only tests the new version if it happens to be routed onto the ramped slice, so an
// attempt can come back with nothing decided and simply need pressing again. `version` is the caller's own
// validated plain release version (never the Cloudflare deploy id), or null when the record carries none.
export function rampPendingBanner(version: string | null, percentage: number): string {
  const named = version ?? "the deployed version";
  return `Verification is pending for ${named}: it is serving ${percentage}% of live traffic in a gradual ramp, and its canary check did not finish. Finish it now, verify and keep it at ${percentage}%, or roll back to the prior version in one click. Because only ${percentage}% of traffic reaches the new version, a check can come back with nothing decided; press the button again if it does, each attempt is a fresh chance of landing on the ramped slice. If you leave it, the hourly canary keeps running. A canary run that lands on ${named} and finds it unhealthy raises a critical alert (the engine will not silently auto-deploy a rollback).`;
}

// rampInconclusiveLine is the terminal sentence for the "inconclusive" outcome: the whole retry budget was
// spent and every attempt came back from a healthy engine saying the same true thing. NOTHING was changed, the
// ramp is still serving its configured percentage, and the pending is still armed. This is not a fault, and it
// must never be rendered as the stall line ("could not be read"): the difference between this and a stuck
// engine is the difference between pressing the button again and unpicking a traffic split by hand. `version`
// is the caller's own validated plain release version, or null when the record carries none.
export function rampInconclusiveLine(version: string | null): string {
  const which = version ? `to ${version}` : "to the ramped version";
  return `Nothing was decided and nothing was changed: these checks were routed to the prior version, not ${which}, so they prove nothing about the ramped version. The ramp is untouched and still serving its configured percentage. Verify again, each attempt has a fresh chance of landing on the ramped slice.`;
}

// rampAppliedLine: a KEPT ramp is NOT a finished update. The version is trusted and it stays at its ramped
// percentage; going to 100% is a separate, deliberate act (the normal apply). Saying "is live" here, as the
// atomic settle's line does, would tell the operator the rollout is over when most of their traffic is still
// on the prior version. `version` is the caller's own validated plain release version, or null when the
// record carries none.
export function rampAppliedLine(version: string | null, percentage: number | null): string {
  const at = percentage === null ? "its ramped percentage" : `${percentage}% of live traffic`;
  return version
    ? `Verified on its own code: ${version} is trusted and stays at ${at}. Promote it to 100% with the normal update when you are comfortable, or roll it back at any time.`
    : `Verified on its own code: the ramped version is trusted and stays at ${at}. Promote it to 100% with the normal update when you are comfortable, or roll it back at any time.`;
}

// cfDashboardRedeployTarget is the ONE exception to this family's own rule: everywhere else, the Cloudflare
// deploy id never reaches an operator (the plain release version replaces it, or the sentence names no
// version at all). But a sentence that sends the operator TO the Cloudflare dashboard to act is different:
// the dashboard lists versions by that same id, so here the id is the thing they need, and hiding it would
// leave them unable to find what to redeploy. releaseVersion (when known) leads, cfVersionId (when known)
// follows labelled and in full, never shortened, so it can never be mistaken for a release number.
export function cfDashboardRedeployTarget(releaseVersion: string | null, cfVersionId: string | null): string {
  if (releaseVersion && cfVersionId) return `${releaseVersion} (Cloudflare version id ${cfVersionId})`;
  if (cfVersionId) return `the prior version (Cloudflare version id ${cfVersionId})`;
  return releaseVersion ?? "the prior version";
}

// rampStillSplitLine is the loudest sentence in the update surface, and it is loud because the state is: the
// ramped version FAILED verification and the rollback to 100% prior ALSO failed, so a share of real customer
// traffic is being routed to the suspect version right now. Data and recovery are unaffected (archives are
// immutable and restore is out-of-band), and the sentence says so. `version` is the caller's own validated
// plain release version for the FAILED candidate (never the Cloudflare deploy id), or null when the record
// carries none. `cfVersionId` is the prior version's OWN Cloudflare deploy id: the redeploy instruction sends
// the operator to the Cloudflare dashboard, which lists versions by that id, so it is named here (see
// cfDashboardRedeployTarget) even though nothing else in this family ever shows it.
export function rampStillSplitLine(version: string | null, cfVersionId: string | null): string {
  const named = version ?? "The ramped version";
  const mid = version ?? "it";
  const target = cfDashboardRedeployTarget(null, cfVersionId);
  return `${named} did not pass verification AND the rollback failed: the deployment is STILL SPLIT and a share of live traffic is still reaching ${mid}. Re-deploy ${target} from the Cloudflare dashboard. Your backups and your ability to restore are unaffected.`;
}
