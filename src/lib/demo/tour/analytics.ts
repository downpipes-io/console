// The tour's lightweight, self-hosted funnel analytics. For a solo operator, knowing which proof-point converts WITHOUT a single sales call is the
// whole point, so the tour emits a small, fixed set of events (tour started, persona chosen, per-step
// reached, the step the visitor dropped on, and which ending CTA they clicked) to the owner's OWN
// infrastructure (Cloudflare Workers Analytics Engine), with NO third-party tracker and no cross-site
// identifier. This is on-ethos: the brand sells "we hold nothing", and the funnel is counted on the owner's
// own Worker, never a marketing SaaS.
//
// THE TRANSPORT (and why it is shaped this way). Workers Analytics Engine is written through a Worker
// BINDING (env.<dataset>.writeDataPoint), which only runs server-side; a browser cannot call it directly.
// So this module POSTs each event as small JSON to a SAME-ORIGIN ingest path (TOUR_EVENT_PATH), which the
// public-tour Worker forwards to Analytics Engine. Same-origin keeps it inside the console's strict
// Content-Security-Policy (connect-src 'self'), so no policy relaxation is needed and nothing leaves the
// origin. It is best-effort and fire-and-forget: navigator.sendBeacon when present (it survives the page
// unload, which is exactly what the drop-step event needs), else a fetch with keepalive; either way a
// failure is swallowed so analytics can NEVER block, slow, or break the tour. It carries NO personal data:
// only the persona, the step index, the route, a coarse reason, and (on the start and CTA events alone) the
// shape-gated campaign label the visitor arrived with; every value is one this code owns or admits by shape.
//
// It is additive and lives entirely behind the tour/demo flag: nothing here is imported by the genuine
// console (only the tour modules import it), and emit() is a no-op unless analytics are enabled (the tour
// entry enables them). House rules: Australian English, precise claims.

// TOUR_EVENT_PATH is the SAME-ORIGIN path the events POST to. It is deliberately NOT under /admin/* (the
// faked-engine fetch shim owns /admin/* and answers it in the browser, so an /admin/* beacon would never
// reach the Worker, and thus never reach Analytics Engine). This path falls through the shim to the real
// fetch and so reaches the public-tour Worker, which forwards it to the AE dataset. The Worker route +
// the AE dataset binding (wrangler.public-demo.toml) are the server half; this is the browser half.
export const TOUR_EVENT_PATH = "/tour/event";

// TourEventName is the closed set of funnel events DESIGN names. Typing it shut means a caller cannot emit
// an ad-hoc event the dashboard does not expect, and a renamed event is a `tsc` error at the call site.
//   - tour_started:   the welcome card was shown (the visitor reached the tour's first interaction).
//   - persona_chosen: the visitor engaged with the welcome fork; carries the welcome choice: a walk persona
//                     ("cto" | "engineer"), or "explore" for a dismissal to free-explore (the Free Explore
//                     control or Escape). "explore" is a coarse choice label only, never a TourPersona (no
//                     script exists for it, and choose() never accepts it).
//   - step_reached:   the director painted a step (one per step, with its index + route).
//   - drop_step:      the visitor left the tour (Exit, or the page unloaded) on this step (the funnel leak).
//   - cta_clicked:    the visitor clicked an ending CTA (deploy free, or talk about support) - the conversion.
//   - demo_drift:     (G337) the faked route table outgrew the console: an unmodelled route, an unknown id, a
//                     fabricated success. Carries the closed drift kind + the normalised /admin route pattern.
//   - tour_degraded:  (G338) the guided session itself degraded: the honesty chrome did not install, a chapter
//                     narrated over a blank screen, a spotlight anchored to nothing. Carries the closed stage,
//                     the chapter id and the anchor id.
//
// The two new events are DIAGNOSTIC, not funnel: they exist because a demo that lies (a delete that
// "succeeded", a recoverability proof that "passed" for a run that does not exist) is worse than a demo that
// admits it cannot do something, and today nothing anywhere can tell that the tour has started lying.
export const TOUR_EVENT_NAMES = [
  "tour_started",
  "persona_chosen",
  "step_reached",
  "drop_step",
  "cta_clicked",
  "demo_drift",
  "tour_degraded",
] as const;
export type TourEventName = (typeof TOUR_EVENT_NAMES)[number];

// A TourEvent is the small, PII-free payload one event sends. Every field is optional except the name, so a
// bare "tour_started" carries only its name and the page context the sink adds. persona/stepIndex/route/
// detail are present where the event has them (a step_reached carries its index + route; a cta_clicked
// carries which CTA in `detail`). The values are all enums/indices this code owns, never visitor input.
export interface TourEvent {
  name: TourEventName;
  // The welcome choice, carried by persona_chosen: a walk persona ("cto" | "engineer"), or "explore" when
  // the visitor dismissed the welcome to free-explore. Absent on every other event.
  persona?: string;
  // The 0-based step index the event is about (step_reached / drop_step). Absent for the others.
  stepIndex?: number;
  // The SPA route the event is about (the step's route, or the funnel route for a CTA). Absent where N/A.
  route?: string;
  // A coarse, fixed descriptor: which CTA (cta_clicked: "deploy" | "support"), why a drop happened
  // (drop_step: "exit" | "unload"), the closed drift kind (demo_drift) or the closed degradation stage
  // (tour_degraded). Never free text; one of a small set the caller passes.
  detail?: string;
  // The tour ANCHOR id a degradation happened on (tour_degraded only): the data-tour-id the spotlight could not
  // find, or the chrome component that would not install. Fixed script vocabulary written by the tour scripts,
  // never anything a visitor typed. Absent on every other event.
  anchor?: string;
  // The campaign source label the visitor arrived with (?src= on the tour URL, emitted by the website's tour
  // links and the /go/ campaign redirects). Attached by emit() itself, to tour_started and cta_clicked ONLY,
  // and only after readTourAttribution has admitted the value through its conservative shape gate below, so
  // free text a visitor types into the URL never rides an event. It is a shared campaign label ("site-header",
  // "202608-launch"), not an identifier. The gate bounds format, not cardinality: what keeps src
  // non-identifying is that our own links mint shared per-channel labels, never per-visitor values.
  src?: string;
}

// enabled gates the whole module: emit() is a no-op until enableTourAnalytics() turns it on (the tour
// entry does, behind the demo flag), so importing this module has no effect on a normal page and a test that
// does not opt in observes no beacons. setEndpoint lets a test point the beacon at an observable path; in
// production it is the same-origin TOUR_EVENT_PATH.
let enabled = false;
let endpoint = TOUR_EVENT_PATH;

// TOUR_SRC_PARAM is the URL query parameter the website's tour links carry (?src=site-header and the campaign
// codes the /go/ redirects append). TOUR_SRC_RE is the client-side shape gate: lower-case letters, digits and
// hyphens, 1 to 32 characters, starting alphanumeric. It is deliberately NARROWER than the server's
// tourValueOk (no dots, no slashes, no colons): a campaign label needs none of those, and the tighter shape
// keeps anything a visitor hand-types into the URL from riding an event unless it already looks like a label
// this codebase could have minted. The server re-gates the value independently (worker.ts tourValueOk), so
// this gate is the first fence, not the only one.
const TOUR_SRC_PARAM = "src";
const TOUR_SRC_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

// attributionSrc is the admitted campaign label for THIS page load, or "" when none arrived (or the arrival
// failed the shape gate). Module state, set once at tour entry by readTourAttribution: the tour is a single
// page load, so one read at boot covers every event the visit emits.
let attributionSrc = "";

// readTourAttribution reads the ?src= campaign label off the entry URL and stores it for emit() to attach.
// Called once by the tour entry (startDemo, beside enableTourAnalytics); a test passes a fake location. A
// missing, oversized or off-shape value stores "" (no src field is emitted at all), the same drop-not-clamp
// posture the server's gate takes: a value that is not the label shape is dropped whole, never truncated.
// A parse fault also stores "", so a malformed URL can never throw into the tour boot.
export function readTourAttribution(loc: Location = location): void {
  try {
    const raw = new URLSearchParams(loc.search).get(TOUR_SRC_PARAM) ?? "";
    attributionSrc = TOUR_SRC_RE.test(raw) ? raw : "";
  } catch {
    attributionSrc = "";
  }
}

// enableTourAnalytics turns emission on. The tour entry calls it once at boot (behind the tour/demo flag),
// so the funnel is counted for a real visitor but never for the genuine console. Idempotent.
export function enableTourAnalytics(): void {
  enabled = true;
}

// disableTourAnalytics turns emission off again (a test teardown, or a deliberate opt-out). After this,
// emit() is a no-op until re-enabled.
export function disableTourAnalytics(): void {
  enabled = false;
}

// setTourAnalyticsEndpoint overrides the POST target. Production uses the same-origin TOUR_EVENT_PATH; a
// test points it at an observable path so the emitted body can be asserted without a network. Resetting to
// TOUR_EVENT_PATH restores the default.
export function setTourAnalyticsEndpoint(path: string): void {
  endpoint = path;
}

// sendVia attempts a beacon and reports whether it was handed off. It prefers navigator.sendBeacon (which
// survives the page unload, so the drop-step event on a real close still lands), and falls back to fetch
// with keepalive (same unload-survival intent) where sendBeacon is absent (the headless test DOM, or an
// older engine). Either path is wrapped so a throw NEVER escapes: analytics must not be able to break the
// tour. It returns true only when a transport accepted the payload, so emit() can record that for a test.
function sendVia(body: string): boolean {
  // navigator.sendBeacon: the right tool for fire-and-forget telemetry, especially on unload. Guarded
  // because the property may be absent (no navigator, or no sendBeacon) and because a Blob constructor may
  // be absent in a non-browser host; any absence falls through to the fetch path below.
  try {
    const nav = (globalThis as { navigator?: { sendBeacon?: (url: string, data?: BodyInit) => boolean } }).navigator;
    if (nav && typeof nav.sendBeacon === "function" && typeof Blob === "function") {
      // A typed Blob so the sink reads it as JSON (sendBeacon sends text/plain by default otherwise). A truthy
      // return means the agent queued the beacon, so we are done; a FALSE return (a payload-size cap, the
      // user-agent declining) means it was NOT queued, so fall through to the keepalive-fetch fallback below
      // rather than silently dropping the event.
      if (nav.sendBeacon(endpoint, new Blob([body], { type: "application/json" })) === true) return true;
    }
  } catch {
    // sendBeacon threw (a disallowed URL, a Blob construction fault): fall through to the fetch path.
  }
  // Fallback: a keepalive POST. keepalive lets the request outlive the page (the same unload-survival
  // property sendBeacon has), and credentials:"omit" + no custom headers keep it a simple, same-origin,
  // non-preflighted request under the strict CSP. A throw (or a rejected promise) is swallowed.
  try {
    const f = (globalThis as { fetch?: typeof fetch }).fetch;
    if (typeof f === "function") {
      void f(endpoint, { method: "POST", body, keepalive: true, credentials: "omit" }).catch(() => {
        // A network failure is non-fatal: analytics are best-effort and never surface to the visitor.
      });
      return true;
    }
  } catch {
    // No fetch, or it threw synchronously: give up silently. The tour is unaffected.
  }
  return false;
}

// emit sends ONE funnel event, best-effort. It is a no-op unless analytics are enabled (so the genuine
// console and a non-opted-in test never beacon), and it never throws: serialising or sending a malformed
// event is swallowed, because a telemetry hiccup must not break the tour the visitor is taking. Returns true
// only when an event was actually handed to a transport (enabled AND a transport accepted it), so a test can
// assert an event fired without coupling to the wire. The page context (the host, the path) is added
// server-side by the sink; the body carries only the small, PII-free fields above.
export function emit(event: TourEvent): boolean {
  if (!enabled) return false;
  try {
    // The campaign label rides ONLY the two events the funnel attributes: the start (which arrival converted
    // into a tour) and the ending CTA (which arrival converted into a click-through). Attaching it here, in
    // the one place every emit passes through, means no call site carries attribution plumbing and no other
    // event can grow the field by accident. An event that already carries src (a test fixture) keeps its own.
    const attributed =
      attributionSrc !== "" && event.src === undefined && (event.name === "tour_started" || event.name === "cta_clicked")
        ? { ...event, src: attributionSrc }
        : event;
    const body = JSON.stringify(attributed);
    return sendVia(body);
  } catch {
    // A non-serialisable event (it never is, the shape is plain data) must not throw into the caller.
    return false;
  }
}
