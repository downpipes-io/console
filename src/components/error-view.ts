// The RENDERING half of the two-channel error model (the classification lives in lib/errors.ts).
// Channel two (transport/auth) is rendered here as an inline BLOCK error with Retry that preserves
// operator input; channel one (in-flow ok:false) is rendered by inlineOutcome() as an EXPECTED
// inline result, never an error toast. A 401 is routed to the signed-out screen by the caller (it
// is not a block error). This keeps every screen consistent and stops the channels being conflated.

import { h, svgIcon } from "../lib/dom.ts";
import { ICON_ALERT, ICON_INFO, ICON_REFRESH } from "../lib/icons.ts";
import { classifyError, errText, forbiddenClass, isStepUpRequired, parseRetryAfter, stepUpFailureMessage, takeStepUpFailure, type ErrorKind } from "../lib/errors.ts";
import { recordTransportFault } from "../lib/client-diag/ring.ts";
import { recordNetworkBlock } from "../lib/client-diag/transport-probe.ts";
import type { ClientDiagTransportClass } from "../lib/client-diag/vocab.ts";

// transportClassFor is the TOTAL, pure map from the RESOLVED ErrorKind (the one blockError actually renders,
// after the console-origin promotion) to the closed transport class the pack carries, or null for the two
// kinds that must NOT be recorded (G122/G145/G147).
//
// It reads the kind's TAG only. `kind.message`, `kind.origin`, `kind.status` and `kind.retryAfter` are never
// touched, so no error text, no engine URL and no header value has a path into the ring from here.
//
// The two nulls are noise discipline, and they matter more than the members:
//   unauthorised       a 401 is the ORDINARY LAPSED SESSION. The caller routes it to the sign-in screen, which
//                      is the product working. A fault row here would appear in the pack of every customer who
//                      ever left a tab open over lunch, which is precisely how a signal stops being believed.
//   restore-unapproved an apply awaiting its second approver. Dual control behaving exactly as designed.
//
// `capability` and any future kind fall through to null rather than to a catch-all member: a class that means
// "something else" is not evidence, and inventing one would put a row in the pack that says a transport fault
// occurred and refuses to say which.
//
// `answer-unreadable` (a 2xx whose body could not be read) is deliberately another omitted kind, for a
// different reason: it is already recorded at the THROW site, by client-transport.ts parseJson's own
// recordContractDrift("malformed-body") call. Giving it a transport class here too would double-count the
// same event under two different vocabularies.
export function transportClassFor(kind: ErrorKind): ClientDiagTransportClass | null {
  switch (kind.kind) {
    case "console-origin":
      return "origin-rejected";
    case "access-redirect":
      return "access-redirect";
    case "html-body":
      return "html-not-engine";
    case "engine-binding-absent":
      // G152: the console's OWN worker said it has no ENGINE service binding. It is NOT `html-not-engine`, and
      // the difference is the whole gap: the engine URL is correct, the engine may be perfectly healthy, and the
      // fault is in the console's deploy. Before the worker answered honestly, this state served the SPA shell at
      // a 200 and the console filed it under html-not-engine, so the pack prescribed correcting an address that
      // was right and said nothing about the binding.
      return "engine-binding-absent";
    case "console-origin-fault":
      // G250: the console's OWN worker manufactured the 500. It is NOT `server-error` (the engine never saw the
      // call, and that member sends support to the engine's refusal logs), NOT `engine-unreachable` (something
      // answered: this console did), and NOT `engine-binding-absent` (the binding is there; the dispatch threw, or
      // the binding's fetch rejected because the engine worker is deleted, throwing or over its limits). This seam
      // is a SIBLING PRODUCER of the same false row the feature probe wrote: blockError renders on every screen's
      // failed read, so leaving it to fall through to `server-error` would have kept the fabricated engine fault in
      // the pack by another door.
      return "console-origin-fault";
    case "network":
      return "engine-unreachable";
    case "rate-limited":
      return "rate-limited";
    case "server":
      return "server-error";
    case "forbidden":
      return "forbidden";
    case "console-fault":
      // A THIRD DELIBERATE NULL, and it is named here rather than left to the default so a reader can see it
      // was decided. A throw with no status that does not read as a fetch failure did not establish which
      // transport class it belongs to: the request most likely completed, but this seam did not observe that.
      // Every member of the closed vocabulary would therefore be a guess, and `engine-unreachable` (which this
      // took before the kind existed) is the guess that is wrong most often, since the engine is usually up and
      // answering. The file's own rule above applies: a class that means "something else" is not evidence.
      //
      // It is also why blockError's recordNetworkBlock call stays keyed to `network` alone. That probe resolves
      // to `origin-rejected` whenever health answers, and on this path health answers by construction, so
      // leaving these here would have kept banking a CONSOLE_ORIGIN diagnosis for correctly configured accounts.
      return null;
    default:
      return null;
  }
}

// errorDetail is the ONE-SENTENCE half of blockError's copy, for a caller that needs plain text
// (a toast, a form's inline error line) rather than a full alert card: the same classifyError +
// describe() pipeline blockError uses, so a toast and a block error never give two different
// accounts of the same failure. It exists because a large family of catch blocks across the console
// used to splice errText(err)/err.message straight into a toast -- the engine client's raw
// "<verb>: <status>" throw, e.g. "add operational key: 500" -- which names neither what failed nor
// why, and on a 403 can read as a bare internal token ("forbidden-class=engine-authz: 403"). Every
// kind here is already reviewed customer copy; this only skips the heading and the Retry button.
export function errorDetail(err: unknown): string {
  return describe(classifyError(err)).detail;
}

// engineAnswered reports whether a thrown error carries PROOF THAT SOMETHING ANSWERED, so a catch block can
// stop asserting a reachability it never established. It is the one predicate behind errorDetail's own split,
// exported so the sites that render their OWN sentence (a status line, an inline ceremony banner) reach the
// same verdict blockError does rather than each inventing a status test.
//
// WHY A PREDICATE AND NOT JUST errorDetail. A catch block that has a specific unreachable sentence worth
// keeping ("Could not reach the engine to check presence.") needs to know WHETHER to keep it. Handing it
// errorDetail unconditionally would replace an honest, action-named line on a genuine outage with a generic
// one; handing it nothing leaves the false claim in place. So: ask this, and on true defer to errorDetail's
// reviewed copy, on false keep your own line.
//
// The rule is classifyError's own: `network` is the ONLY kind that means fetch itself threw with no status at
// all, which is the one state where "could not reach the engine" is a fact rather than a guess. Every other
// kind was reached BECAUSE something answered -- a status the engine sent, a Cloudflare Access page, a frozen
// token this console's own worker stamped, or a 2xx whose body would not parse. This is deliberately a
// question about REACHABILITY and not about WHO answered: on `engine-binding-absent` and
// `console-origin-fault` the answerer was the console's own worker and the engine saw nothing, and both of
// those already say exactly that in their reviewed copy, which is precisely why the caller must defer to it
// instead of guessing.
//
// It is the same correction errors.ts made for the malformed 2xx and
// onboarding/steps.ts made for its polling narration, generalised: AN ANSWER MUST NOT READ AS
// UNREACHABILITY, because an operator told the engine is unreachable goes and checks the network, the tunnel
// and DNS, and none of that can fix a status the console had and discarded.
export function engineAnswered(err: unknown): boolean {
  return classifyError(err).kind !== "network";
}

// stepUpAwareText is errorDetail's NARROW sibling, for the catch blocks that deliberately keep the raw
// message because the engine's own refusal reason lives in it -- a 400 the engine explains ("a custom role
// with that name already exists", the last-Owner guard), which classifyError would flatten to a generic
// sentence. Those blocks are right about every state but one.
//
// THE ONE STATE. A cancelled or failed step-up ceremony is not an engine refusal at all: gatedFetch ran the
// re-auth, the operator dismissed the passkey prompt (or has no passkey on this device, or the ceremony
// threw), runStepUp returned null, and the transport surfaced the ORIGINAL 401 (client-transport.ts). The
// raw message for that is "<verb>: stepup-required: 401" -- an internal marker token and a bare status,
// spliced into customer copy, reading as a lapsed session, which is the exact misreading describe()'s
// stepup-required case exists to prevent. The engine did not refuse anything and nothing was written.
//
// So: the classified advice for THAT state, the raw message for every other. Not a blanket swap to
// errorDetail, which would silently discard the engine reasons those sites were written to show.
export function stepUpAwareText(err: unknown): string {
  return isStepUpRequired(err) ? errorDetail(err) : errText(err);
}

// blockError renders a thrown transport/auth error (NOT a 401, which the caller
// routes to signed-out) as an inline block with a specific, actionable message and
// a Retry button. error.message is surfaced before theorising, an Access-redirect
// body is named honestly, and the CONSOLE_ORIGIN diagnostic is a first-class state.
// onRetry re-runs the failed load.
export function blockError(err: unknown, onRetry: () => void, opts: { origin?: string; healthReachable?: boolean } = {}): HTMLElement {
  // classifyError no longer auto-promotes a fetch failure to console-origin from opts.origin alone
  // (C2-2): the two look identical at the transport layer and are only distinguishable by an
  // independent GET /admin/health probe. So the console-origin decision is made HERE, and only when
  // the caller has explicitly confirmed health is reachable (healthReachable === true) AND can name
  // the origin to set. A caller that has NOT probed health (omits healthReachable), or whose health
  // probe failed (healthReachable === false), gets the plain network block error with Retry, which is
  // the correct diagnosis for a genuine outage. The probing callers (onboarding-connect, settings)
  // already pass the right healthReachable, so this preserves their CONSOLE_ORIGIN setup state.
  const classified = classifyError(err, opts.origin !== undefined ? { origin: opts.origin } : {});
  const kind: ErrorKind =
    classified.kind === "network" && opts.healthReachable === true && opts.origin !== undefined
      ? { kind: "console-origin", origin: opts.origin }
      : classified;

  // G122/G145/G147: the classification the console has always computed here, and has always thrown away the moment
  // it finished painting the card. Recording at this seam rather than at the 36 screen catch sites is deliberate,
  // and is the same argument engine-fetch.ts makes for the fetch seam: every screen renders a channel-two error
  // through blockError, so coverage is complete and no screen can forget it.
  //
  // G122/G145: A NETWORK THROW IS THE ONE CLASS THIS SEAM CANNOT RESOLVE ON ITS OWN, so it does not pretend to.
  //
  // Every other kind carries its own answer in its tag and is recorded here and now. A `network` kind does not: a
  // CORS block and a dead engine are the SAME TypeError, and until now both were recorded as engine-unreachable,
  // one coalesced row, the exact pair the class exists to separate. The old promotion to `origin-rejected` depended
  // on a caller passing healthReachable, which 2 of the ~51 blockError sites did -- and even at those two it could
  // not fire in the scenario it was built for, because /admin/health sat behind the same CONSOLE_ORIGIN gate that
  // was blocking everything else, so the probe was blocked too.
  //
  // So: the engine now serves /admin/health with a wildcard origin and no credentials (it is the one
  // unauthenticated route), and the network case is handed to the probe, which asks health itself and records
  // origin-rejected or engine-unreachable when it knows. Fire-and-forget: the card below paints immediately.
  const transportClass = transportClassFor(kind);
  if (kind.kind === "network") void recordNetworkBlock();
  else if (transportClass !== null) recordTransportFault(transportClass);

  const { heading, detail, showOrigin } = describe(kind);

  const card = h("div", { class: "block-error card card--warn measure", role: "alert" });
  card.appendChild(
    h(
      "div",
      { class: "block-error__head" },
      h("span", { class: "block-error__icon" }, svgIcon(ICON_ALERT, { size: 18 })),
      h("h3", { class: "block-error__title" }, heading),
    ),
  );
  card.appendChild(h("p", { class: "block-error__detail" }, detail));

  if (showOrigin && opts.origin) {
    // The exact value the operator must set on the engine, shown literally.
    card.appendChild(
      h(
        "p",
        { class: "field__hint", style: "margin-top:var(--space-2)" },
        "Set the engine's CONSOLE_ORIGIN to: ",
        h("span", { class: "mono" }, opts.origin),
      ),
    );
  }

  card.appendChild(
    h(
      "div",
      { class: "block-error__actions", style: "margin-top:var(--space-4)" },
      h(
        "button",
        { "data-dp": "components-error-view.button.retry", class: "btn btn--secondary btn--sm", type: "button", on: { click: () => onRetry() } },
        svgIcon(ICON_REFRESH, { size: 14 }),
        "Retry",
      ),
    ),
  );
  return card;
}

function describe(kind: ErrorKind): { heading: string; detail: string; showOrigin: boolean } {
  switch (kind.kind) {
    case "forbidden":
      // A 403 IS NOT AN AUTHORITY FACT, and only one of the four refusals the transport tells
      // apart establishes anything about the caller's role. forbiddenCopy reads back the class
      // the transport already folded into the message by shape gate; the reasoning, and what
      // each of the four means, is in the block at the foot of this file.
      return { ...forbiddenCopy(kind.message), showOrigin: false };
    case "stepup-required": {
      // B29: NOT a lapsed session. A step-up identity check for this sensitive action was needed and
      // not completed (the passkey prompt was declined, cancelled or unavailable). The session is
      // still valid, so this must read as "verify and retry", never as a sign-out.
      //
      // WHICH of those happened is not in the error and never can be: gatedFetch surfaces the ORIGINAL
      // 401 when the ceremony hands back no token, so the begin being refused, the prompt being dismissed
      // and the finish being rejected all arrive here identically. The ceremony records what it did as it
      // ends (lib/errors.ts), and this consumes that record. The generic sentence below is the honest
      // answer when there is no record, which is a real state rather than a gap: a token or Access session
      // never runs a ceremony at all, so nothing was dismissed and "approve the prompt" is still the
      // advice. It also said "when it appears" to an operator with no passkey on this device, and the
      // recorded case now says what to do about that instead.
      const reason = takeStepUpFailure();
      return {
        heading: "Verify your identity",
        detail:
          reason === null ?
            "This action needs a fresh identity check that was not completed. Your session is still active. Try again, and approve the passkey prompt when it appears."
          : stepUpFailureMessage(reason),
        showOrigin: false,
      };
    }
    case "restore-unapproved":
      // NOT a role denial: the apply lacks a usable dual-control approval (a distinct approver,
      // maker != checker). The restore screen maps this to an inline awaiting-approval verdict with
      // a link to the inbox; this block-error rendering is the honest fallback for the direct-probe
      // or race case, and it must NOT read as a capability gate.
      return {
        heading: "Awaiting approval",
        detail: "This apply needs a second authorised identity to approve this exact plan first (the approver must differ from you, maker is not checker). Raise or open the approval, then apply once it is approved.",
        showOrigin: false,
      };
    case "console-origin":
      // Reached only when the caller confirmed health is reachable (blockError gates console-origin on
      // healthReachable === true), so the diagnosis is unambiguous: the engine answers but does not
      // allow this console's origin. A failed health probe is a network outage, not this state.
      return {
        heading: "Engine CONSOLE_ORIGIN is not set to this console",
        detail: "The engine is reachable but does not allow this console's origin, so the browser blocks the response. This is a setup step, not an outage.",
        showOrigin: true,
      };
    case "access-redirect":
      return {
        heading: "Your Cloudflare Access session needs refreshing",
        detail: "The engine returned a Cloudflare Access page where data was expected. Re-authenticate via Cloudflare Access and try again.",
        showOrigin: false,
      };
    case "html-body":
      // A web page with NO Access marker answered where engine data was expected: a wrong engine
      // URL, an engine that is not deployed yet, or a proxy/static host in front. Deliberately NOT
      // the re-authenticate prescription: a session refresh cannot fix an address that is not the
      // engine, and sending the operator to re-auth would loop them.
      return {
        heading: "That address answered with a web page, not engine data",
        detail: "Something served a web page where the engine's data was expected. Check the engine URL, and that the engine is deployed and healthy; a proxy or hosting placeholder in front of the engine can also answer like this.",
        showOrigin: false,
      };
    case "engine-binding-absent":
      // G152. The console worker serves this surface and forwards it to the engine over a service binding; the
      // binding is not bound on this deploy. The operator must not be sent to the engine, which is very likely
      // healthy and has not received a single one of these requests, and must not be sent to correct the engine
      // URL, which is this console's own origin and is correct.
      return {
        heading: "This console was deployed without its engine binding",
        detail:
          "The console proxies the engine on its own hostname through a service binding, and this deploy has none, so the engine is receiving nothing at all. Restore the ENGINE service binding in the console's wrangler configuration and redeploy the console. The engine itself is not implicated: it has not seen these requests. A /metrics scraper pointed at this hostname is being refused for the same reason.",
        showOrigin: false,
      };
    case "console-origin-fault":
      // G250. The console's own worker answered this call with a 500 it manufactured: its dispatch threw, or the
      // ENGINE service binding is bound and its fetch REJECTED, which is what a deleted engine worker, an engine
      // throwing on boot, or an engine over its resource limits looks like from here. The binding exists (that is
      // the row above), and the engine did not answer, so the operator must not be sent to read the engine's
      // refusal logs: there is no request in them to find.
      return {
        heading: "The console answered for the engine, and the engine did not",
        detail:
          "This console proxies the engine on its own hostname, and the proxied call failed inside the console itself, so the engine never received it. Check that the engine Worker is deployed, is not throwing on start-up and is within its resource limits, then retry. The engine's own logs will hold no record of this request, because it never arrived.",
        showOrigin: false,
      };
    case "rate-limited":
      // NOT a server fault: the engine's rate limiter answered 429. It is recoverable by waiting and
      // retrying, so name it distinctly (never the generic "engine returned an error") and tell the
      // operator how long to wait when the engine sent an honour-able Retry-After (CON-2).
      return {
        heading: "The engine is rate limiting requests",
        detail:
          kind.retryAfter !== null
            ? `Too many requests reached the engine at once. Nothing was changed. Wait about ${kind.retryAfter}s and try again; bulk actions pace themselves automatically.`
            : "Too many requests reached the engine at once. Nothing was changed. Wait a moment and try again; bulk actions pace themselves automatically.",
        showOrigin: false,
      };
    case "server":
      return {
        heading: "The engine returned an error",
        detail: `The request failed (${kind.message}). Nothing was changed. Retry, and if it persists check the engine logs.`,
        showOrigin: false,
      };
    case "answer-unreadable":
      // (runs + malformed-json on GET /admin/history): a 2xx whose
      // body could not be read used to fall through to the "network" copy below, which asserts the
      // OPPOSITE of what happened -- the request completed and the engine was reached; only the response
      // could not be understood. That sent the operator to check reachability, which cannot fix a
      // malformed response and would waste real troubleshooting time on a dead end.
      return {
        heading: "The engine answered, but the response could not be read",
        detail: `The request reached the engine and completed (status ${kind.status}), but the response body could not be understood, which is not a reachability problem. This usually means a version mismatch between the console and the engine, or a fault on that specific route. Retry, and if it persists, check that the console and engine are on compatible versions.`,
        showOrigin: false,
      };
    case "console-fault":
      // A throw carrying no HTTP status that does not read as a fetch failure either (lib/errors.ts). The
      // request usually completed and the engine usually answered; what failed is the console's own handling
      // of the answer, most often on a build that does not match the engine's.
      //
      // THE COPY ASSERTS ONLY WHAT IS ESTABLISHED, which is the point of splitting this kind out. It does not
      // say the engine is reachable (this seam did not check), and it does not send the operator to DNS or to
      // a custom domain, which is what the `network` copy below did on every one of these and which cannot fix
      // a console that threw on an answer it already had. The remedy it does name, comparing the two builds,
      // is the one that fixes the ordinary cause.
      return {
        heading: "The console could not handle this",
        detail: `The request carries no engine status and does not read as a network failure (${kind.message}), so this is not a reachability problem and checking the engine's address will not fix it. Retry, and if it persists check that the console and engine are on compatible versions.`,
        showOrigin: false,
      };
    case "network":
      return {
        heading: "Could not reach the engine",
        detail: `The request did not complete (${kind.message}). Check the engine is reachable on its custom domain and try again.`,
        showOrigin: false,
      };
    case "unauthorised":
      // Should be routed to signed-out by the caller; render honestly if it lands here.
      return {
        heading: "Your Access session is not valid",
        detail: "Re-authenticate via Cloudflare Access to continue.",
        showOrigin: false,
      };
  }
}

// inlineRetry is the COMPACT channel-two failure for a SUBORDINATE region: a card body, a switch's
// state line, a lazily-loaded drawer section. It is the calm sibling of blockError, and it exists
// because the alternative that had grown up around the console was a bare sentence with nothing to
// press.
//
// The bar it exists to meet, clause by clause, so a caller cannot forget one:
//
//   a named remedy      the Retry control re-runs the region's OWN loader. Without it, a region that
//                       failed its one read stayed failed for the life of the screen, and the only way
//                       back was reloading the tab (or, on a control built once at screen render,
//                       navigating away and returning). That is a dead end, and it was the shape of
//                       every site this replaced.
//   a human sentence    the caller passes prose. These sites used to interpolate errText(err), which
//                       is the engine client's own "<verb>: <status>" throw, so an operator read
//                       "Could not load the policy (get approval policy: 500)." A parenthesised engine
//                       verb is not a remedy and names nothing the operator can act on.
//   contained           it replaces the host it is handed and nothing above it.
//   not colour alone    the state is carried by the sentence; no tint and no tone class decides it.
//
// It is deliberately NOT blockError. blockError is a full alert card with an icon and a heading, which
// is right for the read a screen is ABOUT and wrong for three switches on one screen that all failed
// the same read: three alert cards for one engine fault is exactly what the calm-density budget
// forbids. role="status" for the same reason, where blockError uses role="alert":
// a subordinate region degrading politely announces itself, it does not interrupt.
export function inlineRetry(opts: { message: string; onReload: () => void; retryLabel?: string }): HTMLElement {
  const wrap = h("div", { class: "inline-retry", role: "status", style: "display:flex;gap:var(--space-2);align-items:baseline;flex-wrap:wrap" });
  wrap.appendChild(h("span", { class: "field__hint" }, opts.message));
  wrap.appendChild(
    h(
      "button",
      { "data-dp": "components-error-view.button.reload", class: "btn btn--ghost btn--sm", type: "button", on: { click: () => opts.onReload() } },
      svgIcon(ICON_REFRESH, { size: 13 }),
      opts.retryLabel ?? "Try again",
    ),
  );
  return wrap;
}

// SESSION_ENDED_READ is what a region says when the read behind it stopped on a lapsed session (a 401).
//
// ONE sentence, not seventy. Every screen in this console seeds a skeleton, issues its read and routes to
// sign-in on a 401, so seventy hand-written sentences would be seventy accounts of one event that drift
// apart the first time one of them is reworded.
//
// It is not a decoration on the way out. goSignedOut() is a no-op until app.ts installs the nav bridge
// (lib/nav.ts records the boot class nav-bridge-uninstalled for exactly that state), so without this paint
// the region stays a skeleton the operator keeps looking at, with nothing to read and nothing to press.
export const SESSION_ENDED_READ = "Your session ended before this finished loading, so nothing here was read. Sign in again to see it.";

// sessionEnded is the paint that goes with it. WITH a reload it carries the shared retry control, because a
// session re-established in another tab makes the same read succeed here; without one it is the sentence
// alone, for the regions built once with nothing to re-run.
export function sessionEnded(onReload?: () => void): HTMLElement {
  if (onReload) return inlineRetry({ message: SESSION_ENDED_READ, onReload });
  return h("p", { class: "field__hint", role: "status" }, SESSION_ENDED_READ);
}

// SESSION_ENDED_ACTION is the same fact for an ACTION rather than a read: the operator pressed something,
// the session had lapsed, and the engine did not do it. Distinct from the read sentence because the
// reassurance is different and it is the one that matters: nothing happened.
export const SESSION_ENDED_ACTION = "Your session ended before this finished, so nothing was changed. Sign in again and retry.";

// inlineOutcome renders channel one: an in-flow ok:false result (drill/restore) as
// an EXPECTED inline outcome, not an error toast. The coarse engine reason is shown
// and, for a restore, "Nothing was written." reassurance. tone "info" because it is
// an expected result, not a fault.
export function inlineOutcome(opts: { heading: string; reason: string; reassurance?: string }): HTMLElement {
  const card = h("div", { class: "inline-outcome card card--inset measure", role: "status" });
  card.appendChild(
    h(
      "div",
      { class: "inline-outcome__head" },
      h("span", { class: "inline-outcome__icon" }, svgIcon(ICON_INFO, { size: 18 })),
      h("h3", { class: "inline-outcome__title" }, opts.heading),
    ),
  );
  card.appendChild(h("p", { class: "inline-outcome__detail" }, opts.reason));
  if (opts.reassurance) card.appendChild(h("p", { class: "field__hint", style: "margin-top:var(--space-1)" }, opts.reassurance));
  return card;
}

// ---- the refusal rule: the engine's words may surface, the console's tokens may not -----------
//
// THE CONSOLE'S OWN INTERNAL TOKENS MUST NEVER SURFACE; THE ENGINE'S OWN WORDS MAY. That rule was
// written for the licence and update verbs (screens/licence/shared.ts) and it belongs to every
// screen, because the throw shape it reads is the transport's, not the licence route's: api.ts
// folds a refusal as "<verb>: <reason>: <status>", and the marker gates fold "<verb>: <marker>" or
// "<verb>: <marker>=<value>: <status>" when there is no reason at all. A catch block that renders
// err.message therefore shows a customer either the engine's good sentence with plumbing glued to
// both ends ("add destination: bucket not found.: 400") or, when the engine never explained itself,
// a bare status or an internal class token ("forbidden-class=not-engine-body: 403").
//
// REASON_BEARING_KINDS is an ALLOW-LIST rather than a marker deny-list, and that is the safe
// default: a kind added to ErrorKind later is far likelier to be another marker than another engine
// refusal, so an unlisted kind takes its own reviewed sentence without anyone remembering to extend
// anything. api.ts folds the engine's { error } BEFORE the transport's marker gates run, so any
// status can carry a genuine reason, which is why a 403 sits here beside a 400.
//
// TWO MARKERS RIDE WITH A TRAILING STATUS and would otherwise pass the reason test on an allowed
// kind: "forbidden-class=<class>: 403" and "retry-after=<n>: 429". They are rejected by the
// console's OWN recognisers for them, not by a second pattern written here: a marker recognised in
// two places is a marker that can be recognised inconsistently.
//
// WHAT IS DELIBERATELY NOT CLOSED: the `server`, `network` and `answer-unreadable` sentences
// interpolate the raw message, so a bare fault still shows "(set licence: 503)" inside a sentence
// that says what happened and what to do. The claim is precise: no internal marker token reaches
// the customer, not that no status does.
const REASON_BEARING_KINDS: ReadonlySet<ErrorKind["kind"]> = new Set(["server", "forbidden", "rate-limited", "restore-unapproved"]);

// The transport's own verb prefix, for a caller that does not know which verb threw. It matches one
// leading run of lower-case words before the FIRST colon, which is exactly what api.ts prepends
// ("add destination: ", "discovery token: "); a colon cannot appear inside the run, so an engine
// reason that itself contains a colon keeps every part of itself.
const ANY_VERB_PREFIX = /^[a-z][a-z0-9 -]*:\s*/;

// engineReason returns the ENGINE'S OWN refusal sentence when the throw carries one, and null when
// it does not. The null is what a caller needs rather than an implementation detail: a caller that
// WRAPS the reason in its own sentence ("The engine refused the configuration (...). Adjust and try
// again.") must not wrap a reviewed sentence, or the customer reads one whole sentence nested in
// another with different advice in each half.
//
// verbPrefix is stripped only so a genuine engine reason reads as a sentence rather than a log
// line; pass a verb-specific pattern when the call site knows which verb threw.
export function engineReason(err: unknown, verbPrefix: RegExp = ANY_VERB_PREFIX): string | null {
  const raw = errText(err);
  if (REASON_BEARING_KINDS.has(classifyError(err).kind) && forbiddenClass(err) === null && parseRetryAfter(raw) === null) {
    // The engine's reason is present ONLY when there is something between the verb and the trailing
    // status: the fold shape is "<verb>: <reason>: <status>", and a bare "<verb>: <status>" has no
    // reason at all. Requiring the second colon is what tells them apart.
    const m = /^(.*\S)\s*:\s*\d{3}\s*$/.exec(raw.replace(verbPrefix, ""));
    if (m) return m[1] as string;
  }
  return null;
}

// refusalTextFrom is the whole rule for a caller that shows the refusal ON ITS OWN: the engine's
// sentence when there is one, the reviewed sentence for the classified kind when there is not.
export function refusalTextFrom(err: unknown, verbPrefix: RegExp = ANY_VERB_PREFIX): string {
  return engineReason(err, verbPrefix) ?? errorDetail(err);
}

// refusalText is the one every screen wants: refusalTextFrom over the transport's generic verb.
export function refusalText(err: unknown): string {
  return refusalTextFrom(err);
}

// ---- a 403 is not an authority fact, and this copy is where that stops being asserted ----------
//
// THE DEFECT, driven against the first downpipe a customer creates. An engine 403 that
// the console's OWN transport had already classified as `not-engine-body` (a refusal that did not
// come in the engine's refusal shape at all, so a block page or a proxy made it) reached the editor
// as a role denial, and the editor told an OWNER:
//
//   "The engine refused this save at its role gate. Requires permission to create or edit downpipes;
//    your Owner role does not hold it. An Owner can change this on the Access screen."
//
// Three things wrong in one line, and the first is the worst: the caller's role DID hold it, and the
// same screen proved so by rendering its New downpipe button live. The remedy named a screen where
// there is nothing to change. And the actual cause, something in front of the engine refusing the
// call, went unnamed. This block error carried the same untruth by another door ("Your role does not
// permit this action") for every one of the four 403s.
//
// lib/errors.ts already tells the four apart by a SHAPE GATE over the body and folds the class into
// the throw, and forbiddenClass() reads it back. Only ONE of the four establishes anything about the
// caller: `engine-capability`, where the engine's route gate named the capability it wanted. The DO's
// authz funnel deliberately names nothing and is not always about the caller at all; the CSRF check
// refuses every cookie-borne save in the whole console and its remedy is an engine variable; a block
// page means the engine may never have seen the request. Saying "your role" for those three is an
// assertion this code never established, and it sends a customer to change something that is right.
//
// A NULL class keeps the original sentence, deliberately: an unclassified 403 is one this gate could
// not read (an older throw, a hand-built error), and the role reading is the right default there.
function forbiddenCopy(message: string | undefined): { heading: string; detail: string } {
  switch (forbiddenClass(message ?? "")) {
    case "engine-csrf":
      return {
        heading: "The engine did not accept this console's origin",
        detail:
          "The engine refused the request before it reached the action, because its origin check failed. That is a setting on the engine, not anything about your role or your permissions, and while it is wrong every save in this console is refused the same way. Nothing was changed. An operator needs to set the engine's CONSOLE_ORIGIN to this console's address and redeploy it.",
      };
    case "not-engine-body":
      return {
        heading: "Something in front of the engine refused this",
        detail:
          "The refusal did not arrive in the engine's own form, so it was made by something between this browser and the engine, such as a firewall rule or a proxy. The engine may never have seen the request, so its logs will hold no record of it. Nothing was changed. Retry, and if it persists check the rules in front of the engine's hostname.",
      };
    case "engine-authz":
      return {
        heading: "The engine refused this on authority",
        detail:
          "The engine refused this and deliberately did not say which permission was missing. It is not always about you: an action somebody else proposed is refused this way when THEIR authority changed before it ran. Nothing was changed. The audit log records the refusal; ask an Owner if you expected this to be allowed.",
      };
    default:
      // `engine-capability` (the route gate named the capability THIS caller lacks) and an
      // unclassified 403 both read as the role denial, which is what the sentence has always said.
      return {
        heading: "Not permitted",
        detail: "Your role does not permit this action. The control should be gated before you reach it; if you see this, the engine refused a direct request.",
      };
  }
}
