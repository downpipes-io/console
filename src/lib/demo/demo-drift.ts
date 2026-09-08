// DEMO-vs-CONSOLE DRIFT, and TOUR SESSION DEGRADATION, made visible.
//
// The public tour has no engine behind it: /admin/* is answered in the visitor's own browser by the faked
// route table (demo-routes-read / demo-routes-write). That table is a SECOND implementation of the console's
// API surface, and it rots. A console route the table never grew answers a benign empty 200; an id the seeded
// world does not hold falls back to a substitute; a delete "succeeds" and nothing changes; a drill, a blind
// test or an attestation "passes" for a run that does not exist. Every one of those is a FABRICATED SUCCESS,
// on the one surface whose whole job is to be honest, and no support pack can ever carry it: there is no
// engine to build one. The drift accumulates for weeks and only a human replaying the tour ever sees it.
//
// The tour chrome degrades the same silent way: a renamed data-tour-id leaves the spotlight anchored to
// nothing, a mount that throws drops the DEMO labelling, and the funnel events cannot tell a degraded session
// from a visitor who simply skipped.
//
// So both ride the tour's EXISTING same-origin funnel channel (/tour/event -> the owner's own Workers
// Analytics Engine). This is the tour, not the console: there is no customer, no engine and no support pack
// here, and the visitor is a prospect on a public marketing surface.
//
// NO-CUSTODY STILL BINDS, and it binds harder here because these events leave the browser without anyone
// asking. Every field is a CLOSED PRODUCT CONSTANT: a drift kind, a degradation stage, a chapter id, an
// anchor id, and a route pattern whose every segment is a member of the frozen product word list below.
// A segment that is not a member is replaced by ":id" and DISCARDED, so a path can carry no id, no query,
// no body and nothing the visitor typed.

import { emit } from "./tour/analytics.ts";

// DEMO_DRIFT_KINDS is WHAT the faked engine did instead of answering honestly. Each is a different repair on
// the tour's side, which is why they are separate members and not one "drift" event:
//
//   unmodelled-get         a GET the route table has never heard of, answered with a benign empty 200. The
//                          screen renders BLANK and the visitor is told nothing. The commonest drift there is.
//   unmodelled-post        a POST the table has never heard of, answered with a benign applied/ok. The write
//                          "succeeded" and nothing changed: the fabricated success this file exists to catch.
//   unknown-id-fallback    an id the seeded world does not hold, substituted with a seeded one. The screen
//                          shows a DIFFERENT object than the one the visitor clicked.
//   body-parse-failed      a write body the faked engine could not parse, so it applied its defaults instead
//                          of the visitor's choice.
//   wrong-verb             a PUT/DELETE, which the table does not model at all (an honest 501, but it means a
//                          console screen now issues a verb the tour cannot answer).
//   pdf-unmodelled         a PDF render the tour does not model (an honest 501; recorded so the count of
//                          visitors who hit a download that cannot work is known).
//   approval-hash-miss     a dual-control approval whose plan hash did not match, so the tour could not
//                          demonstrate the approval it was asked to.
//   proof-for-unknown-run  THE WORST ONE, and its own kind for that reason. A drill, a blind
//                          restore test, an attestation or a restore plan answered PASS for a run id the seeded
//                          world does not hold. The tour's four recoverability verbs each build their result
//                          from a run they look up and never check: writeDrill returned
//                          {ok:true, recordsVerified:1, sampleRestored:true} for a ghost run, writeVerifyRestore
//                          returned a clean blind test with no failures, writeAttestRestore returned
//                          signatureValid/complete/notRolledBack, and writeRestore fabricated the SEEDED plan's
//                          record count for it. A fabricated success on any screen is bad; a fabricated
//                          RECOVERABILITY PROOF is the tour telling a prospect their data is provably restorable
//                          when the tour did not look at anything. It is not unknown-id-fallback: that is a
//                          screen showing a stand-in object, which is cosmetic, and this is not.
//   unknown-id-fallback    an id the seeded world does not hold, substituted with a seeded one. The screen
//                          shows a DIFFERENT object than the one the visitor clicked.
//   fallback-substitution  any other seeded-world substitution that made a screen render a stand-in.
export const DEMO_DRIFT_KINDS = [
  "unmodelled-get",
  "unmodelled-post",
  "unknown-id-fallback",
  "proof-for-unknown-run",
  "body-parse-failed",
  "wrong-verb",
  "pdf-unmodelled",
  "approval-hash-miss",
  "fallback-substitution",
] as const;
export type DemoDriftKind = (typeof DEMO_DRIFT_KINDS)[number];

// TOUR_DEGRADE_STAGES is WHERE the guided session broke. Each names a different repair, and the first is the
// one the gap is loudest about: the honesty chrome (the banner, the DEMO marker, the site link, the favicon,
// the pricing pill) used to install under ONE try, so the first failure silently dropped every later one and
// the tour could run with NO demo labelling at all.
// anchor-missing used to be THREE states in one row, and one of the three was not a fault at
// all. beatIntoView's retry closure was shared by the "no element" branch and the "element found, scrolling did
// not frame it" branch, and both exhausted into the same event. So a renamed data-tour-id (repair: restore the
// hook), a drawer that never opened (repair: fix the reveal) and an anchor that simply cannot be framed on a
// short screen against a fixed bottom bar (repair: NONE, it is a legitimate state) all produced a byte-identical
// row, and the third fired on EVERY session of that chapter. The director now classifies what the DOM actually
// said, and each member below names only the fact the code established:
//
//   anchor-missing      querySelector found NO element with the data-tour-id. Established.
//   anchor-not-visible  the element IS in the DOM and its box is 0x0 for the whole 2.5s retry window: it is
//                       hidden or collapsed, so the spotlight is over an invisible thing. A different repair.
//   (unframable)        the element is in the DOM WITH a real box and scrolling could not seat it in the band.
//                       NOT A MEMBER, ON PURPOSE. There is nothing to repair, so a row here would be a wolf cry
//                       on a legitimate state, and the noise would teach a reader to ignore the other two.
export const TOUR_DEGRADE_STAGES = [
  "chrome-install-failed", // one of the honesty-chrome installs threw (the route field names WHICH component)
  "welcome-mount-failed", // the welcome / persona fork never mounted: the tour's first interaction is gone
  "screen-render-timeout", // the step's screen never painted, so a chapter narrates over a blank or wrong screen
  "anchor-missing", // the step's data-tour-id is not in the DOM: a spotlight over nothing (a console rename)
  "anchor-not-visible", // the anchor IS in the DOM and has no box: hidden or collapsed (a reveal that never ran)
  "preaction-failed", // the step's pre-action (open a drawer, seed a filter) threw: the step demonstrates nothing
  "world-transform-failed", // a training chapter's time jump threw: the chapter narrates over an unadvanced world
  "autoplay-click-failed", // an autoplay interaction could not be performed: the demonstration was skipped
  "cta-href-invalid", // the finale CTA would navigate the demo tab to a broken URL
  "double-mount", // the tour mounted twice (a duplicate director): two spotlights, two narrations
] as const;
export type TourDegradeStage = (typeof TOUR_DEGRADE_STAGES)[number];

// TOUR_CHROME_COMPONENTS is the closed set of honesty-chrome components, and it is the `route` field of a
// chrome-install-failed event. It is a union, not a bare string, so no future caller can put prose there.
export const TOUR_CHROME_COMPONENTS = ["tour-banner", "tour-corner-marker", "tour-site-link", "tour-favicon", "tour-pricing-pill"] as const;
export type TourChromeComponent = (typeof TOUR_CHROME_COMPONENTS)[number];
const CHROME_COMPONENT_SET: ReadonlySet<string> = new Set(TOUR_CHROME_COMPONENTS);

// THE CHAPTER / ANCHOR REDACTION GATE. A tour_degraded event's route and anchor are ids written by the tour
// SCRIPT, and every call site passes one. That is a convention, and a convention is not a boundary: nothing
// stopped a later caller from passing a caught exception's message, or a value read off the page, into either.
//
// So the director REGISTERS the vocabulary of the script it is about to run (its chapter routes and its beat
// anchors, which are the only legitimate values these two fields can hold), and noteTourDegraded admits a route
// or an anchor ONLY by set membership against it. A value that is not a member is DROPPED WHOLE -- not clamped,
// not truncated -- so the event still says WHAT degraded and simply cannot say where in a language of its own
// devising. Registration comes from the script, not from an import, so this file stays free of a cycle back
// through the director.
let scriptRoutes: ReadonlySet<string> = new Set();
let scriptAnchors: ReadonlySet<string> = new Set();

export function registerTourVocabulary(routes: readonly string[], anchors: readonly string[]): void {
  scriptRoutes = new Set(routes);
  scriptAnchors = new Set(anchors);
}

// ADMIN_PATH_WORDS is the FROZEN product vocabulary of /admin path segments. It is the redaction boundary of
// the route pattern: a segment IN this set is a product word chosen by our own code, and a segment outside it
// is, by definition, not one, so it is replaced by ":id" and never transmitted. That is a set-membership gate,
// not a length clamp: an id, a bucket name, an email or anything a visitor typed cannot be a member, and so
// cannot ride, no matter how short it is.
const ADMIN_PATH_WORDS: ReadonlySet<string> = new Set([
  "accept", "apply", "approval-policy", "approvals", "approve", "at", "attest", "audit", "auth", "canary",
  "cf-config", "changes", "channels", "config", "connections", "cost", "coverage", "credentials",
  "custom-roles", "default", "delete", "destination", "destinations", "diff", "discover",
  "discovery-accounts", "discovery-status", "discovery-token", "downpipes", "drill", "drill-evidence",
  "email", "enable", "enabled", "estate-size", "evidence-pack", "expiry", "export", "finish", "group-roles",
  "health", "history", "idp", "install", "inventory", "keys", "licence", "metadata", "mode", "notify", "oidc",
  "otlp-push", "owner-actions", "passkey", "policy", "posture", "preflight", "presets", "providers", "push",
  "ramp", "recovery-codes", "rediscover", "regenerate", "register", "reject", "remove", "replication",
  "reports", "request", "restore", "rollback", "roles", "rto", "rules", "run", "runs", "saml", "sessions",
  "settle", "setup-state", "snapshot", "sources", "status", "support", "terminate-all", "terminate-others",
  "terminate-user", "test", "test-saved", "trigger", "unaccept", "update", "updates", "verify", "version",
  "webhook", "whoami",
]);

// MAX_PATTERN_SEGMENTS bounds the pattern so a pathological path cannot produce an unbounded string. It is a
// backstop on SIZE; the membership gate above is what makes the content safe.
const MAX_PATTERN_SEGMENTS = 6;

// normaliseAdminPattern turns a concrete request path into the closed route PATTERN the drift event carries.
// Every segment is either a frozen product word or ":id". The query string is dropped whole (it can carry a
// downpipe id, a framework name, a cursor), and so is anything past the segment bound.
//
// This function is the entire no-custody argument for this event, so it is written to be read: there is no branch
// in it that copies an unrecognised segment anywhere.
export function normaliseAdminPattern(pathname: string): string {
  const parts = pathname.split("/").filter((p) => p !== "");
  const out: string[] = [];
  for (const p of parts.slice(0, MAX_PATTERN_SEGMENTS)) {
    out.push(p === "admin" || ADMIN_PATH_WORDS.has(p) ? p : ":id");
  }
  return `/${out.join("/")}`;
}

// noteDemoDrift emits ONE drift event: the closed kind, and the normalised route pattern it happened on.
// Best-effort and never throwing (emit already swallows its own transport faults): a telemetry hiccup must
// never break the tour a prospect is taking. It is a no-op outside tour mode, because analytics are only ever
// enabled by the tour entry, so nothing here can fire on the genuine console.
export function noteDemoDrift(kind: DemoDriftKind, pathname: string): void {
  try {
    emit({ name: "demo_drift", detail: kind, route: normaliseAdminPattern(pathname) });
  } catch {
    // Unreachable in practice (emit swallows), and belt-and-braces here for the same reason: the tour outranks
    // its own telemetry.
  }
}

// noteTourDegraded emits ONE degradation event: the closed stage, plus the chapter route (or the chrome
// component) and the beat anchor it happened on. Both are admitted ONLY by set membership -- against the closed
// chrome-component union, or against the vocabulary of the script the director registered -- and a value that is
// a member of neither is DROPPED. An absent id is simply omitted, so a chrome install that has no chapter
// carries none rather than a fabricated one.
export function noteTourDegraded(stage: TourDegradeStage, route?: TourChromeComponent | string, anchor?: string): void {
  try {
    const admittedRoute = route !== undefined && (CHROME_COMPONENT_SET.has(route) || scriptRoutes.has(route)) ? route : undefined;
    const admittedAnchor = anchor !== undefined && scriptAnchors.has(anchor) ? anchor : undefined;
    emit({
      name: "tour_degraded",
      detail: stage,
      ...(admittedRoute !== undefined ? { route: admittedRoute } : {}),
      ...(admittedAnchor !== undefined ? { anchor: admittedAnchor } : {}),
    });
  } catch {
    // As above: the tour outranks its own telemetry.
  }
}
