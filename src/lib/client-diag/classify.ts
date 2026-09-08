// classify.ts -- the PURE, TOTAL, VALUE-FREE half of the console-diagnostics ring: the clamps, the monotonic
// clock, the route-template -> screen mapper, and the fault mappers. Split out of ring.ts when that file
// crossed the 800-line budget (the availability-gap wave added six closed vocabularies and five recorders).
//
// The seam is a real one and not a size-driven fiction: everything here is a TOTAL FUNCTION over untrusted
// input with no knowledge of the ring at all. It never pushes a record, never reads one, and holds no state
// except the monotonic origin and the active route template. The ring (ring.ts) is the stateful half: the
// coalescing tuple, the caps, the eviction, the recorders and the payload. The dependency runs one way,
// ring.ts -> classify.ts, so no cycle can form (madge stays clean).
//
// The I2 no-custody guarantee lives HERE, at its sharpest. These mappers are the only code in the console
// that is ever handed a raw thrown value, and NOT ONE OF THEM COPIES A CHARACTER OF IT into a field. They
// read a NUMERIC status; they compare an error's `name` for EQUALITY against a frozen product constant and
// return a member of a closed union. The message and the stack are never read at all. Text may SELECT a
// closed member; it may never pass through.

import { classifyError, errorStatus, type ErrorKind } from "../errors.ts";
import { UPDATE_CHANNEL_FAULT_SET, type UpdateChannelFault } from "../api/types/updates.ts";
import {
  CLIENT_DIAG_COUNT_MAX,
  CLIENT_DIAG_ERROR_CLASS_SET,
  CLIENT_DIAG_MS_MAX,
  type ClientDiagChannelReasonClass,
  type ClientDiagErrorClass,
  type ClientDiagFaultClass,
  type ClientDiagHttpClass,
  type ClientDiagScreen,
} from "./vocab.ts";

// ---- clamps ------------------------------------------------------------------------------------

// clampInt maps ANY input (including NaN, Infinity, a non-number, a fractional value) to a whole number in
// [0, CLIENT_DIAG_MS_MAX]. Total by construction: there is no input for which it returns a non-integer or
// an out-of-range value, so a corrupted clock reading cannot put an arbitrary value on the wire.
export function clampInt(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return 0;
  const i = Math.trunc(n);
  if (i < 0) return 0;
  return i > CLIENT_DIAG_MS_MAX ? CLIENT_DIAG_MS_MAX : i;
}

// clampNonNegInt is the same total clamp for a coalesce COUNT, bounded by CLIENT_DIAG_COUNT_MAX (a
// count is a repeat tally, never a sequence number, an index or an id).
export function clampNonNegInt(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return 0;
  const i = Math.trunc(n);
  if (i < 0) return 0;
  return i > CLIENT_DIAG_COUNT_MAX ? CLIENT_DIAG_COUNT_MAX : i;
}

// ---- the monotonic clock -----------------------------------------------------------------------

// firstMs/lastMs are offsets from the ring's own origin, taken from performance.now() (MONOTONIC), never
// from Date.now() (wall clock). Two consequences the design depends on: a rate is computable from the
// offsets even though the engine does not trust the client's clock, and no absolute time the operator's
// machine asserts ever reaches the pack.
const RING_ORIGIN_MS: number = nowRaw();

function nowRaw(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  return typeof perf?.now === "function" ? perf.now() : 0;
}

// elapsedMs is the clamped monotonic offset since the ring's origin.
// elapsedMs is the ring's monotonic offset from the module origin. Exported for ring.ts (the only caller):
// it is the timestamp source for every record, and it must be the MONOTONIC clock, never the wall clock, so a
// Date.now that jumps backwards cannot reorder the evidence.
export function elapsedMs(): number {
  return clampInt(nowRaw() - RING_ORIGIN_MS);
}

// ---- the active screen -------------------------------------------------------------------------

// The screen a record is attributed to is a COMPILE-TIME LITERAL, never a runtime read of
// location/history/router params. The router hands the ring the resolved route TEMPLATE (for example
// "/downpipes/:id", which carries no id) and screenFromPattern maps it, through a table whose VALUES are
// frozen ClientDiagScreen literals, to one of them. The mapping is TOTAL: any input at all, including a
// concrete path that somehow carried a customer id, yields a frozen member (falling back to
// "unknown-route"), so the id CANNOT survive the mapper. That is the structural guarantee, and it holds
// independently of the router behaving.
let activeScreen: ClientDiagScreen = "boot";

// PATTERN_PREFIXES is an ORDERED table: the first prefix that matches wins, so the more specific route
// ("/access/idp") is listed before the family it sits inside ("/access"). Every VALUE is a literal member
// of the frozen screen union. The console has more screen families than the frozen 16-member vocabulary, so
// each family is placed in its nearest frozen bucket and the remainder falls to "unknown-route"; the
// vocabulary is FROZEN across the two repos and must not be extended here.
const PATTERN_PREFIXES: ReadonlyArray<readonly [string, ClientDiagScreen]> = [
  // THE TWO APPROVAL INBOXES GET THEIR OWN SCREEN, AND THEY GO FIRST. Both used to fall into the `security`
  // bucket ("/config" and "/security" both map there), and a render throw inside a .then with no .catch is nearly
  // always a TypeError, so the config-approvals screen frozen on skeleton rows and the owner-approvals screen
  // frozen on skeleton rows emitted the byte-identical tuple {unhandled, security, other, unhandled-rejection,
  // TypeError} and COALESCED into one row. The ticket names both screens by name and asks support to tell them
  // apart. Listed BEFORE their families, because the first prefix that matches wins.
  ["/config/changes", "config-changes"], // the pending config-change approval inbox, BEFORE /config
  ["/security/owner-actions", "owner-actions"], // the owner-approval inbox, BEFORE /security
  ["/access/idp", "idp"], // the IdP connections family, BEFORE the /access family below
  ["/access", "access"], // enforcement, roles, the role builder, audit, fallback
  ["/downpipes", "downpipes"],
  ["/runs", "downpipes"], // run history is the downpipes domain
  ["/canary", "downpipes"], // the canary is a backup monitor over the downpipes
  ["/destinations", "destinations"],
  ["/sources", "sources"],
  ["/restore", "restore"],
  ["/keys", "keys"],
  ["/notifications", "notifications"],
  ["/integrations", "integrations"],
  ["/security", "security"],
  ["/config", "security"], // change control and config history are governance surfaces
  ["/credentials", "security"], // the credential-expiry registry is a governance surface
  ["/reports", "security"], // evidence packs and compliance reporting
  ["/licence", "updates"], // the licence screen owns the update state
  ["/settings", "settings"],
  ["/onboarding", "boot"], // the guided bring-up, before the engine is fully configured
  ["/passkey", "access"],
  ["/register", "access"],
  ["/signed-out", "access"],
  ["/map", "overview"],
  ["/costs", "overview"],
  ["/command-palette", "overview"],
];

// screenFromPattern is the TOTAL pure mapper from a route TEMPLATE to a frozen screen literal. It never
// echoes its input: the return value is always a member of CLIENT_DIAG_SCREENS. Exported for the validator,
// which proves totality and proves that a pattern carrying a customer id maps to a frozen member with the
// id nowhere in the output.
export function screenFromPattern(pattern: unknown): ClientDiagScreen {
  if (typeof pattern !== "string") return "unknown-route";
  if (pattern === "/") return "overview";
  for (const [prefix, screen] of PATTERN_PREFIXES) {
    if (pattern === prefix || pattern.startsWith(`${prefix}/`)) return screen;
  }
  return "unknown-route";
}

// setActiveScreen is called by the router's afterEach with the resolved route TEMPLATE. The value stored is
// always a frozen literal (screenFromPattern is total), so no runtime string reaches the ring.
export function setActiveScreen(pattern: string): void {
  activeScreen = screenFromPattern(pattern);
}

// currentScreen is the screen an emit site is attributed to. Exported for the validator.
export function currentScreen(): ClientDiagScreen {
  return activeScreen;
}

// ---- the fault mappers (total, pure, value-free) -----------------------------------------------------

// httpClassForStatus maps an HTTP status to its frozen class. Total: any status at all (including a
// nonsense one) yields a member, defaulting to "4xx" only for genuine 4xx and "5xx" for genuine 5xx; a
// status outside both ranges is not a fault and yields null (the caller records nothing).
export function httpClassForStatus(status: number): ClientDiagHttpClass | null {
  if (status >= 500 && status <= 599) return "5xx";
  if (status >= 400 && status <= 499) return "4xx";
  return null;
}

// faultClassForStatus maps an HTTP status to its frozen fault class. TOTAL: every status yields a member,
// with "other" as the catch-all. It reads ONLY the numeric status, never a body, a header or a message.
export function faultClassForStatus(status: number): ClientDiagFaultClass {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not-found";
  if (status === 409 || status === 412 || status === 428) return "conflict";
  if (status === 429) return "rate-limited";
  if (status >= 500 && status <= 599) return "server";
  return "other";
}

// matchesErrorName compares a thrown value's `name` for EQUALITY against ONE frozen product constant and
// returns a BOOLEAN. It is the only place the ring looks at a name at all, and it copies nothing: the name
// is compared, never read out, so a customer value sitting in err.name has no path into a record. It reads
// the property rather than testing `instanceof Error` because a fetch abort rejects with a DOMException,
// whose prototype chain is not guaranteed to reach Error in every runtime; an instanceof test would
// misclassify the single most common benign rejection in the console as a network
// fault.
function matchesErrorName(err: unknown, frozenName: string): boolean {
  if (err === null || typeof err !== "object") return false;
  const name = (err as { name?: unknown }).name;
  return typeof name === "string" && name === frozenName;
}

// isNavigationCancelled is the NOISE FILTER, and the whole reason `aborted` exists as a class. A route
// change or a component unmount aborts every fetch still in flight, and a page teardown rejects them too.
// That is the console working as designed, not a fault, so nothing that matches this may be recorded as
// one: `aborted` is excluded from the failing signal, and an aborted rejection is never recorded as an
// `unhandled` fault at all.
export function isNavigationCancelled(err: unknown): boolean {
  return matchesErrorName(err, "AbortError");
}

// httpClassForRejection maps a THROWN fetch rejection to its frozen class, comparing the name for equality
// against two frozen product constants and copying nothing. Any error whose name is neither is "network".
export function httpClassForRejection(err: unknown): ClientDiagHttpClass {
  if (isNavigationCancelled(err)) return "aborted";
  if (matchesErrorName(err, "TimeoutError")) return "timeout";
  return "network";
}

// FAULT_BY_ERROR_KIND maps the console's own closed error taxonomy (lib/errors.ts ErrorKind, the
// discriminant the whole console already classifies transport faults by) onto the frozen faultClass. It is
// EXHAUSTIVE by type: a new ErrorKind member fails to compile until it is placed here, so the mapper below
// stays total. Only the `.kind` discriminant is ever read; the `message` some ErrorKind members carry is
// never touched.
const FAULT_BY_ERROR_KIND: Readonly<Record<ErrorKind["kind"], ClientDiagFaultClass>> = {
  unauthorised: "auth",
  forbidden: "auth",
  "stepup-required": "auth", // a step-up identity-verification gap, an auth matter (never a transport/server fault)
  "restore-unapproved": "conflict", // a dual-control refusal: the plan awaits a distinct approver
  "console-origin": "transport", // a CORS/CONSOLE_ORIGIN misconfiguration (classifyError never promotes it)
  "access-redirect": "auth", // a lapsed Cloudflare Access session, a session matter
  "html-body": "other", // some web page answered where engine JSON was expected
  // The console's OWN worker has no ENGINE service binding, so the engine never received the request. It is
  // `transport` and not `server`: the engine did not answer this, and a faultClass of `server` would point the
  // reader at engine logs that hold no trace of it. The transportClass member carries the actual diagnosis.
  "engine-binding-absent": "transport",
  // The console's OWN worker manufactured the 500, so the engine never received the request. `transport` for
  // the same reason as the row above and NOT `server`: `server` points the reader at engine logs that hold no
  // trace of the call. The transportClass member carries the actual diagnosis.
  "console-origin-fault": "transport",
  "rate-limited": "rate-limited",
  server: "server",
  // A 2xx whose body could not be read: the engine answered and the
  // request completed, so this is `server`, the same class a 5xx gets, and NOT `transport`/`other` -- the
  // engine is confirmed up and reachable, and the defect (a malformed or unexpected body) is something its
  // own state or logs can explain, exactly as a genuine 5xx is. Filing it as transport/unreachable is the
  // very misdiagnosis this fix exists to stop.
  "answer-unreadable": "server",
  // A throw with NO status is `network` to the console's transport-facing classifier, because that is what a
  // fetch TypeError looks like. At the BOOT and UNHANDLED sites it is far more likely to be a code defect
  // (a null dereference nobody caught), and a genuine fetch failure is ALREADY recorded as engine-call /
  // transport at the one seam every engine call passes through. Calling it `transport` here would inflate
  // the transport picture with console bugs and double-count the real ones, so it maps to `other`.
  network: "other",
  // A throw with no status that does not read as a fetch failure either. `other` for the SAME reason the row
  // above gives and with more of the argument behind it: that comment already observes that a statusless throw
  // "is far more likely to be a code defect (a null dereference nobody caught)" and that a genuine fetch failure
  // is recorded as engine-call/transport at the seam every engine call passes through. This kind is exactly the
  // half of `network` where that is true, so it takes the same class rather than inflating `transport`.
  "console-fault": "other",
};

// faultClassForError is the TOTAL, PURE mapper from any thrown value to a frozen faultClass, used by the
// boot and unhandled-rejection sites. It NEVER copies error.message / error.name / error.code / error.stack
// into a field. It reads the message for exactly one thing: the trailing 3-digit HTTP STATUS the
// engine client folds into its throws (errorStatus), which is a NUMBER, and maps that number through the
// same status mapper the engine-call site uses. When there is no status it falls back to the console's own
// closed error taxonomy and reads only that taxonomy's discriminant. So the output is always one of the 7
// frozen members, and the input text has no path to the wire.
export function faultClassForError(err: unknown): ClientDiagFaultClass {
  const status = errorStatus(err);
  if (status !== null) return faultClassForStatus(status);
  return FAULT_BY_ERROR_KIND[classifyError(err).kind];
}

// errorClassForError is the TOTAL, PURE mapper from any thrown value to a frozen JS error class. It is
// the "text may SELECT a closed member, never pass through" rule in its plainest form: the thrown value's
// `name` is tested for SET MEMBERSHIP against the frozen list of platform error constructors, and the RETURN is
// a member of that list. A name that is not a member (a custom error class, or a name that somehow carried a
// customer value) yields "other" and is copied nowhere. The message, the stack and the code are never read.
//
// The one non-name branch is DOMException, whose `name` is the REASON ("NotAllowedError", "AbortError"), not
// the class, so a browser refusal would otherwise land in "other" alongside every console defect. The reason
// itself is deliberately NOT recorded: it is an open set that grows with the platform, and the refusals that
// matter are already recorded with their own discriminators as capability-fault rows.
export function errorClassForError(err: unknown): ClientDiagErrorClass {
  if (err === null || typeof err !== "object") return "other";
  const name = (err as { name?: unknown }).name;
  if (typeof name === "string" && CLIENT_DIAG_ERROR_CLASS_SET.has(name)) return name as ClientDiagErrorClass;
  const DomException = (globalThis as { DOMException?: unknown }).DOMException;
  type Ctor = new (...args: never[]) => object;
  if (typeof DomException === "function" && err instanceof (DomException as Ctor)) return "DOMException";
  return "other";
}

// classifyChannelReason is the TOTAL, PURE classifier from the engine's update-channel `reason` FREE TEXT
// to a frozen member of ClientDiagChannelReasonClass. It is the last shape of the "text may SELECT a closed
// member, it may never pass through" rule in this file, and it is the one that most needed writing down.
//
// upd.reason is engine prose. It can embed the channel URL, the signer key id, an account id and Cloudflare's own
// error sentence. CLAMPING IT INTO THE PACK WOULD BE A LEAK WITH A LENGTH BOUND ON IT, which is not a redaction:
// that exact mistake shipped once already as updates.last.reason "clamped to 200 chars", carrying a raw deploy
// error. So the text is lowercased, TESTED against frozen substrings, and DISCARDED; the RETURN is a member of the
// closed union and nothing else. A reason the classifier does not recognise (and an absent reason) yields "none",
// which honestly says "unverified, cause unstated" rather than guessing.
//
// The order matters: a signature failure is the six-week silent outage the ticket is about, and it is the member
// checked first so a reason naming both a signature and a fetch cannot be mislabelled as merely unreachable.
export function classifyChannelReason(reason: unknown): ClientDiagChannelReasonClass {
  if (typeof reason !== "string") return "none";
  const t = reason.toLowerCase();
  if (t.includes("signature") || t.includes("signer") || t.includes("unsigned") || t.includes("verify")) return "signature";
  if (t.includes("fetch") || t.includes("unreachable") || t.includes("network") || t.includes("timeout") || t.includes("dns")) return "unreachable";
  if (t.includes("parse") || t.includes("malformed") || t.includes("invalid") || t.includes("shape") || t.includes("json")) return "malformed";
  return "none";
}

// CHANNEL_FAULT_TO_REASON_CLASS maps the ENGINE'S OWN CLOSED channel fault to the pack's closed reason
// class. It is total over UPDATE_CHANNEL_FAULTS, and it is what channelReasonClassFor prefers over the text.
const CHANNEL_FAULT_TO_REASON_CLASS: Readonly<Record<UpdateChannelFault, ClientDiagChannelReasonClass>> = {
  "url-config": "bad-url",
  "key-config": "bad-signer-key",
  "fetch-failed": "unreachable",
  "sig-invalid": "signature",
  "json-parse": "malformed",
  "shape-invalid": "malformed",
};

// channelReasonClassFor is the ONE classifier the update-channel row uses. It reads the engine's CLOSED
// `channelFault` first and falls back to the prose classifier only when the engine sent no fault.
//
// WHY THE ENUM COMES FIRST. The engine has always HELD the closed cause and dropped it at the status projection,
// which forced the console to reconstruct the class by substring-matching a sentence written for a human. That is
// a silent, ungated coupling: reword "could not fetch the update channel" and every row degrades to `none` while
// every test stays green. The sentence is now the fallback, not the source.
//
// channelFault is WIRE DATA, so it is gated against the frozen set rather than trusted: an engine that sends a
// member this console does not know falls back to the text, and the text classifier is total. Nothing is carried
// either way -- the RETURN is a member of the closed union and the reason string never leaves this function.
export function channelReasonClassFor(upd: { channelFault?: unknown; reason?: unknown }): ClientDiagChannelReasonClass {
  if (typeof upd.channelFault === "string" && UPDATE_CHANNEL_FAULT_SET.has(upd.channelFault)) {
    return CHANNEL_FAULT_TO_REASON_CLASS[upd.channelFault as UpdateChannelFault];
  }
  return classifyChannelReason(upd.reason);
}

// httpClassForThrown is the TOTAL mapper a NON-FETCH caller uses to classify a thrown engine error: an error
// the engine client threw with a status folded into its message classifies by that STATUS (a number), and one
// with no status classifies by the same frozen-name compare the fetch seam uses. It exists because the identity
// resolve catches the error rather than seeing the Response, and a status is what separates "the engine
// refused the identity read" from "the engine could not be reached at all".
export function httpClassForThrown(err: unknown): ClientDiagHttpClass {
  const status = errorStatus(err);
  if (status !== null) return httpClassForStatus(status) ?? "network";
  return httpClassForRejection(err);
}
