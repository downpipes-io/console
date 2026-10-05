// Setup's first contact with the engine, shown on Welcome: is the engine there, which version is it, and how
// is this browser signed in to it. It is the retired first-run deck's connect check, headless: the same three
// reads in the same order (GET /admin/health unauthenticated, then the authenticated status, then the sign-in
// verdict), and the same rows in the support ring, because each ending has a different remedy.
//
// A console whose remembered engine address this build cannot use has no engine client at all; the probe
// connects to this origin, which serves the engine's admin API through the console Worker's ENGINE binding,
// exactly as a first load with nothing remembered does (lib/store.ts restoreConnection).

import { accessVerdictFromCaller, type AccessVerdict } from "../../components/trust-chips.ts";
import { recordOnboardingStep } from "../client-diag/ring.ts";
import { isUnauthorised } from "../errors.ts";
import { caller, refreshIdentity, whoamiAvailable } from "../nav.ts";
import { connect, getEngine } from "../store.ts";
import type { EngineClient } from "../../api.ts";

export type EngineProbe =
  // The engine answered health and the authenticated status. `verdict` is null until the sign-in verdict
  // resolves (it may never: the row access-verdict-unresolved says so).
  | { state: "ok"; version: string; verdict: AccessVerdict | null }
  // The engine answered health and reported itself not healthy: reachable, and its logs hold the reason.
  | { state: "engine-not-ok" }
  // Health answered and the authenticated read did not: an Access policy that does not admit this browser,
  // or a CONSOLE_ORIGIN that does not name this console.
  | { state: "health-ok-status-failing"; message: string }
  // No answer from the engine reached the console.
  | { state: "unreachable"; message: string }
  // The session ended: the caller sends the tab to sign-in after it paints.
  | { state: "unauthorised" };

// resolveAccessVerdict reads the honest sign-in verdict. When the shell has already resolved whoami it mirrors
// it (no second round trip); otherwise it asks whoami and refreshes the shared identity, so the shell chip and
// the client gate use the same verdict. A 200 from status with no whoami proves an authenticated session but
// not its method, so that degrades to session-present, never to a claim it cannot back.
export async function resolveAccessVerdict(engine: EngineClient): Promise<AccessVerdict> {
  if (whoamiAvailable() && caller()) return accessVerdictFromCaller(caller(), true);
  try {
    const who = await engine.whoami();
    await refreshIdentity();
    return accessVerdictFromCaller(who, true);
  } catch (err) {
    if (isUnauthorised(err)) throw err;
    await engine.status();
    return { state: "session-present" };
  }
}

// accessSentence is the verdict as one plain sentence, or null for a verified sign-in that needs no remark.
// Honest by construction: it claims no more than the verdict proves.
export function accessSentence(v: AccessVerdict): string | null {
  switch (v.state) {
    case "verified":
    case "passkey-verified":
    case "idp-verified":
    case "session-present":
      return null;
    case "recovery-verified":
      return "You signed in with a recovery code. Use your usual sign-in once you are back in.";
    case "token-fallback":
      return "You signed in with the admin token. Security Centre shows how to retire it.";
    case "unverified":
      return "This session is not verified. Sign in again.";
    default:
      return "The console could not confirm how you signed in.";
  }
}

let probed: Promise<EngineProbe> | null = null;

// probeEngine runs the check once per page load and shares the answer; `again` runs it afresh (Retry).
export function probeEngine(again = false): Promise<EngineProbe> {
  if (probed === null || again) probed = runProbe();
  return probed;
}

async function runProbe(): Promise<EngineProbe> {
  const engine = getEngine() ?? connect(location.origin);
  try {
    const health = await engine.health();
    if (!health.ok) {
      // The engine ANSWERED and reported itself not healthy. It is reachable, so this is not a connect fault.
      recordOnboardingStep("connect", "engine-not-ok");
      return { state: "engine-not-ok" };
    }
  } catch (err) {
    // The health probe did not come back. The engine never saw this request, so no engine-side evidence of
    // it can exist: this row is the only record that a first run could not reach the engine at all.
    recordOnboardingStep("connect", "transport-error");
    return { state: "unreachable", message: err instanceof Error ? err.message : String(err) };
  }
  let version: string;
  try {
    const status = await engine.status();
    version = typeof status.engineVersion === "string" && status.engineVersion !== "" ? status.engineVersion : "not reported";
    recordOnboardingStep("connect", "ok");
  } catch (err) {
    // THE ACCESS SIGNATURE when it is not a clean 401: health passed (it is unauthenticated) and the
    // authenticated read failed. A clean 401 is told apart from it, because separating "you are not signed
    // in" from "you are signed in and the engine will not talk to you" IS the diagnosis.
    if (isUnauthorised(err)) {
      recordOnboardingStep("connect", "unauthorised");
      return { state: "unauthorised" };
    }
    recordOnboardingStep("connect", "health-ok-status-failing");
    return { state: "health-ok-status-failing", message: err instanceof Error ? err.message : String(err) };
  }
  let verdict: AccessVerdict | null = null;
  try {
    verdict = await resolveAccessVerdict(engine);
  } catch {
    // The sign-in verdict never resolved, so Welcome shows none and the operator cannot see how they are
    // signed in; the row says so.
    recordOnboardingStep("connect", "access-verdict-unresolved");
  }
  return { state: "ok", version, verdict };
}
