// transport-probe.ts -- the CORS-versus-outage discriminator, made reachable in the state that needs it.
//
// THE STATE THE PACK COULD NOT DESCRIBE. A customer reports "every screen fails". Two causes, one remedy each:
//
//   the engine's CONSOLE_ORIGIN does not name this console  -> set CONSOLE_ORIGIN on the engine
//   the engine is down                                      -> bring the engine back
//
// A CORS-blocked fetch and a fetch to a dead host are THE SAME TypeError in the browser. The console's answer was
// the `origin-rejected` transport class, promoted from a network throw when the caller ALSO confirmed the
// unauthenticated health probe was reachable. That fingerprint was sound and it was unreachable twice over:
//
//   1. Only 2 of the ~51 blockError call sites ever passed healthReachable. Every other screen (Overview, Runs,
//      Restore, Destinations, Credentials, Notifications, Map, Licence, Security...) omitted it, so on 49 of 51
//      sites a CORS block was recorded as engine-unreachable BY CONSTRUCTION -- the same row a genuine outage
//      writes, coalescing into it on the tuple key.
//   2. Worse, and fatal: /admin/health was behind the SAME origin-equality CORS gate as every data route, so in
//      the CONSOLE_ORIGIN scenario the browser blocked the health probe too. healthReachable was false, the class
//      resolved to engine-unreachable, and `origin-rejected` was produced ONLY by a state (health passes,
//      authenticated calls do not) in which "set CONSOLE_ORIGIN" is the WRONG advice.
//
// THE FIX HAS TWO HALVES AND BOTH ARE REQUIRED. The engine now serves /admin/health with an unconditional
// access-control-allow-origin:* and NO allow-credentials (it is the one unauthenticated route; see HEALTH_CORS in
// engine src/index.ts), so a console blocked by CONSOLE_ORIGIN can still reach it. And this module probes it
// itself, at the ONE render seam every screen's transport error passes through, so the discriminator no longer
// depends on 2 of 51 callers remembering to pass a flag.
//
// NO-CUSTODY. The probe reads ONE boolean out of the response: did it answer at all. The body is never parsed, the
// URL is never recorded, and the only thing that reaches the ring is a frozen member of ClientDiagTransportClass.

import { getEngineUrl } from "../store.ts";
import { recordTransportFault } from "./ring.ts";

// PROBE_TTL_MS bounds the probe rate. A screen that renders several block errors at once (Overview fans out four
// reads) must not fan out four health probes at a host that is already failing, and a verdict seconds old is still
// the right verdict: the two states this separates (a misconfigured origin, a dead engine) do not flip in seconds.
const PROBE_TTL_MS = 5000;

let lastVerdictAt = 0;
let lastVerdict: boolean | null = null;
let inFlight: Promise<boolean> | null = null;

// probeHealth asks the engine's unauthenticated health route whether it is up, WITHOUT credentials.
//
// `credentials: "omit"` is load-bearing and not an oversight. The engine answers this route with a WILDCARD
// allow-origin, and the CORS spec forbids a wildcard from satisfying a credentialed request: probing with
// credentials:"include" would have the browser refuse the response and reproduce exactly the bug this module
// exists to fix. Omitting them is also correct on its own terms -- the route is unauthenticated, so there is no
// session for it to read and none to send.
//
// It returns a BOOLEAN and never throws. `mode` is left at the default so a genuine CORS failure is a rejection
// (a no-cors opaque response would answer "reachable" for a request the browser actually blocked, which would
// invert the very fingerprint being measured).
async function probeHealth(fetchFn: typeof fetch): Promise<boolean> {
  const base = getEngineUrl();
  if (base === null) return false;
  try {
    const r = await fetchFn(`${base}/admin/health`, { credentials: "omit", cache: "no-store" });
    return r.ok;
  } catch {
    return false;
  }
}

// cachedProbe coalesces concurrent probes into one in-flight request and caches its verdict for PROBE_TTL_MS.
async function cachedProbe(fetchFn: typeof fetch, now: number): Promise<boolean> {
  if (lastVerdict !== null && now - lastVerdictAt < PROBE_TTL_MS) return lastVerdict;
  if (inFlight !== null) return inFlight;
  inFlight = probeHealth(fetchFn).then((ok) => {
    lastVerdict = ok;
    lastVerdictAt = Date.now();
    inFlight = null;
    return ok;
  });
  return inFlight;
}

// classifyNetworkBlock is the PURE half, exported so the validator drives both verdicts without a network: given
// whether the unauthenticated health probe answered, which transport class does a data-call network throw resolve
// to?
//
//   health ANSWERED  -> `origin-rejected`. The engine is UP and reachable from this browser, and the data call
//                       still failed with no response. Something is refusing the console's authenticated
//                       cross-origin traffic while the unauthenticated route sails through, which is what a
//                       CONSOLE_ORIGIN mismatch looks like from the outside. "Set CONSOLE_ORIGIN."
//   health SILENT    -> `engine-unreachable`. Nothing on that host answers this browser at all. "The engine is
//                       down."
//
// The engine's own recordCorsRejection counter is the other side of this join: it fires when an Origin was
// PRESENT and did not match, so a pack carrying origin-rejected rows AND a non-zero engine-side CORS-rejection
// count is a confirmed CONSOLE_ORIGIN mismatch from both ends.
export function classifyNetworkBlock(healthAnswered: boolean): "origin-rejected" | "engine-unreachable" {
  return healthAnswered ? "origin-rejected" : "engine-unreachable";
}

// recordNetworkBlock is what blockError calls INSTEAD of recording engine-unreachable straight off a network
// throw. It probes health and records the resolved class when the answer lands.
//
// It is deliberately fire-and-forget: the block-error card renders NOW, synchronously, with the copy it always
// had, and the diagnostic row lands a moment later. The row is what the pack carries; the operator's screen must
// not wait on a probe to paint an error they are already looking at. fetchFn is the validator's seam.
export function recordNetworkBlock(fetchFn: typeof fetch = fetch, now: number = Date.now()): Promise<void> {
  return cachedProbe(fetchFn, now).then((healthAnswered) => {
    recordTransportFault(classifyNetworkBlock(healthAnswered));
  });
}

// resetTransportProbe is the validator's seam (the module caches a verdict across calls, and a validator drives
// both verdicts in one process). Not called by production code.
export function resetTransportProbe(): void {
  lastVerdictAt = 0;
  lastVerdict = null;
  inFlight = null;
}
