// The window-level fault handlers for the console-diagnostics ring.
// A rejection nobody caught, or an uncaught throw, is by definition a console DEFECT rather than an expected
// outcome: it never reached a catch site, so it never reached a toast, so today it dies in a devtools console
// the operator does not have open and the support pack knows nothing about it. These two handlers give that
// class of fault a coarse, closed-class record inside the pack.
//
// NOTHING OF THE ERROR TRAVELS (review B5). The handlers never read error.message / error.name / error.code /
// error.stack, and never the event's own filename/lineno/colno, into a field. They map the thrown value to
// one of the 7 frozen faultClass members through the ring's total pure mapper and record that class alone.
//
// THE NOISE FILTERS ARE THE POINT (review D5). Without them these signals are worthless, because the browser
// generates most of what arrives here:
//   - A NAVIGATION-CANCELLED fetch. A route change or an unmount aborts every request still in flight; the
//     abort surfaces as an AbortError rejection. That is the console working exactly as designed. It is
//     dropped, never recorded, exactly as `aborted` is excluded from the engine-call failing signal.
//   - A CROSS-ORIGIN SCRIPT ERROR. A browser extension's injected script that throws reaches window.onerror
//     as the opaque "Script error." with NO error object, and a failed resource load reaches it with none
//     either. Both are the operator's browser, not Downpipes. An event with no Error object is dropped, so
//     an extension-heavy browser cannot manufacture a phantom console-fault signal.
// storage-blocked and env-capability are deliberately NOT collected at all (D5): they are dominated by
// private-browsing, and the owner's own browser would fire the second.
//
// CSP VIOLATIONS WERE ON THAT LIST TOO, AND THIS TAKES THEM OFF IT. The original reason was sound as far as it
// went (a browser extension that injects a script into the page can fire a violation, and a signal dominated by
// extensions is worthless), but dropping the whole channel threw away the one piece of evidence for two things
// the product has no other witness to: the documented stale-hashed-chunk incident, where the console's own asset
// was silently blocked by its own policy after an update and the page came up broken; and any injection attempt
// at all, which a security team WILL eventually ask about and which today has no answer anywhere. The extension
// noise is not a reason to have no signal, it is a filter to write, and noteCspViolation writes it: a violation
// whose blocked URI carries a BROWSER-EXTENSION scheme is dropped before anything is classified, exactly as an
// opaque cross-origin "Script error." is dropped above.

import { cspBlockedFor, cspDirectiveFor, errorClassForError, faultClassForError, isNavigationCancelled, prepaintRan, recordCspViolation, recordUnhandled } from "./ring.ts";

// noteUnhandledRejection applies the filters and records at most ONE closed-class record. Returns whether it
// recorded, so the validator can assert the filters by their effect rather than by inspecting the ring.
// Exported (rather than inlined into the listener) precisely so the noise filters are testable in Node.
//
// THIS IS THE SEAM THE FROZEN-SKELETON TICKET COMES IN ON. A screen that renders inside a `.then`
// with no `.catch` and throws mid-render rejects HERE, and nowhere else: the promise chain ends, the skeleton
// rows stay up forever, no toast fires and nothing is written anywhere. The row is stamped `unhandled-rejection`
// so the pack can say which of the two symptoms the customer is describing, and with the thrown value's error
// CLASS (a set-membership select over a frozen list, never the message or the stack) so a render throw is not
// one indistinguishable bucket with every other defect on the same screen.
export function noteUnhandledRejection(reason: unknown): boolean {
  // NOISE: a cancelled/aborted request is not a fault. Dropped before anything is classified.
  if (isNavigationCancelled(reason)) return false;
  recordUnhandled(faultClassForError(reason), "unhandled-rejection", errorClassForError(reason));
  return true;
}

// noteWindowError applies the filters to an uncaught throw. `error` is the event's `error` property, which
// is the ONLY thing read: never the message, filename, lineno or colno (a filename is a path, and a
// cross-origin one is not ours to carry).
export function noteWindowError(error: unknown): boolean {
  // NOISE: no Error object means a cross-origin script ("Script error.") or a failed resource load. Neither
  // is a Downpipes fault, and neither is even attributable, so nothing is recorded.
  if (!(error instanceof Error)) return false;
  // NOISE: an abort that reached the error channel is still an abort.
  if (isNavigationCancelled(error)) return false;
  recordUnhandled(faultClassForError(error), "window-error", errorClassForError(error));
  return true;
}

// EXTENSION_SCHEME is the noise filter for CSP reports. A browser extension that injects a script or a
// stylesheet into the page is reported against the PAGE's policy, and it is the operator's browser rather than
// Downpipes: an extension-heavy browser would otherwise manufacture a violation signal on every load and drown
// the two reports that matter. The list is the schemes the major browsers use for extension-origin resources.
const EXTENSION_SCHEME = /^(?:chrome-extension|moz-extension|safari-extension|safari-web-extension|ms-browser-extension|webkit-masked-url):/i;

// noteCspViolation applies the filter and records at most ONE closed-class record. It is exported so the noise
// filter is testable in Node, and it takes the three fields it reads as plain values rather than the event, so a
// test can drive it without a DOM.
//
// NOTHING FROM THE REPORT TRAVELS. The blocked URI, the source file, the line number and the script sample are
// all read only by the two total pure mappers, which compare and return a frozen member and copy nothing. On the
// case this row exists for most, the blocked URI is a string an ATTACKER chose, and it would otherwise be riding
// into a sealed bundle that a support engineer opens.
// An inline block seen HERE is always `unsanctioned`, and the reason is timing, not trust. This listener lives in
// app.js, which is a deferred module: it cannot exist until the document has been parsed. The console's ONE
// sanctioned inline script sits in <head> and runs (or is refused) DURING that parse, so if it were the thing
// blocked, its violation fired before this listener could possibly have been registered. An inline violation that
// reaches this listener is therefore, by construction, not the pre-paint: the pre-paint has already had its one
// chance to be blocked, and notePrepaintBlocked below is what witnesses that. So this is an inline script that is
// not ours, which is what an injection attempt is.
export function noteCspViolation(directive: unknown, blockedUri: unknown, pageOrigin: string): boolean {
  // NOISE: an extension-origin resource is the operator's browser, not Downpipes, and is not attributable to us.
  if (typeof blockedUri === "string" && EXTENSION_SCHEME.test(blockedUri.trim())) return false;
  recordCspViolation(cspDirectiveFor(directive), cspBlockedFor(blockedUri, pageOrigin), "unsanctioned");
  return true;
}

// notePrepaintBlocked witnesses the OTHER inline state, the one no listener can catch: the console's own
// sanctioned pre-paint script being refused by the console's own policy. That is the documented
// incident, where a stale hash silently blocked the pre-paint for every visitor and the page came up with no
// theme and no accessibility attributes before first paint.
//
// It cannot be caught by the securitypolicyviolation listener above, and that is not a detail: the violation
// fires while <head> is being parsed, and app.js is a deferred module that has not run yet. There is no listener
// to hear it. A recorder that relied on the event would have had NO PRODUCER for this class at all, which is the
// state the class exists to name.
//
// So it is not observed as an event, it is observed as a FACT ABOUT THE PAGE: the pre-paint script sets a marker
// as its last act, and by the time app.js runs, the marker is either there (it ran) or it is not (it did not).
// The only way for our own script not to have run is for the policy to have refused it, and the refusal is
// diagnostic of a hash that no longer matches the bytes. Returns whether it recorded, so the validator can drive
// it without a DOM.
export function notePrepaintBlocked(): boolean {
  if (typeof document === "undefined") return false;
  if (prepaintRan()) return false; // it ran: the ordinary state on every healthy load, and it records nothing
  recordCspViolation("script-src", "inline", "sanctioned-prepaint");
  return true;
}

// installWindowFaultHandlers registers the three listeners and takes the one-shot pre-paint reading. It is called
// at MODULE SCOPE from the app entry, before boot() runs, so a fault during boot itself is still seen. The
// listeners are passive: they do not preventDefault, so the browser still reports the fault to the devtools
// console exactly as it does today and nothing about the console's behaviour changes.
export function installWindowFaultHandlers(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("unhandledrejection", (ev: PromiseRejectionEvent) => {
    noteUnhandledRejection(ev.reason);
  });
  window.addEventListener("error", (ev: ErrorEvent) => {
    noteWindowError(ev.error);
  });
  window.addEventListener("securitypolicyviolation", (ev: SecurityPolicyViolationEvent) => {
    noteCspViolation(ev.effectiveDirective || ev.violatedDirective, ev.blockedURI, window.location.origin);
  });
  // The one-shot reading, taken once at boot. The document is parsed by the time this module runs, so the
  // pre-paint has already either executed or been refused; there is nothing to wait for.
  notePrepaintBlocked();
}
