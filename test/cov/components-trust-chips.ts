// Coverage for src/components/trust-chips.ts: the honest trust telemetry chips. The sibling validator
// test/validate-components.ts already drives the pure accessVerdictFromCaller state machine and
// the _testChipTone tone mirror, so this file does not re-do those tables; it renders the REAL
// DOM-producing functions (accessChip and noCustodyChip) under the shared DOM shim (no jsdom, no
// network) so every assertion exercises production code rather than re-implementing it. It also
// reaches the one accessVerdictFromCaller arm the maths-only validator omits (the passkey method).
//
// The crux these chips must honour is the F7 rule: only the verified and passkey-verified states
// are teal (the trust family); every cautious state degrades to amber (warn) and the unreachable
// engine degrades to neutral, and no chip is ever a bare permanent green. accessChip routes each
// AccessVerdict through the private present() switch, so rendering one chip per state proves the
// tone, glyph and label that arm produced.
//
// Run with: node test/cov/components-trust-chips.ts
//
// Surfaces driven (and the contract each asserts):
//   accessChip           the span.trust-chip with one trust-chip--<tone> class per AccessVerdict
//                        state; the shield-check glyph on the two teal states, the alert glyph on
//                        the two amber error states, the info glyph on session-present and unknown;
//                        the email-bearing and email-absent labels (both ternary legs); the verified
//                        title with and without an identity provider; and that the title copy
//                        observes only what the JWT proves (never "second factor").
//   noCustodyChip        the constant true teal statement; the lock glyph, the by-construction
//                        label, and the never-transmitted title. It reads no verdict, so it is the
//                        same chip every time.
//   accessVerdictFromCaller  the passkey-method arm (state "passkey-verified"), which the
//                        DOM-free validator does not cover, plus its honesty contract that a passkey
//                        is never slandered as the shared-token fallback.

import { readFileSync } from "node:fs";
import { installDomShim, qs, textOf, classesOf, type ShimNode } from "../dom-shim.ts";
import {
  ICON_SHIELD_CHECK,
  ICON_LOCK,
  ICON_INFO,
  ICON_ALERT,
} from "../../src/lib/icons.ts";

// Install the shim BEFORE importing the component (lib/dom.ts and several components create
// elements at load time).
installDomShim();

const chips = await import("../../src/components/trust-chips.ts");
const { accessChip, noCustodyChip, accessVerdictFromCaller } = chips;

type AccessVerdict = import("../../src/components/trust-chips.ts").AccessVerdict;
type Caller = import("../../src/api.ts").Caller;

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

// A glyph fingerprint helper: svgIcon sets the path markup verbatim as the SVG element's innerHTML,
// so the rendered chip's icon carries the exact ICON_* string for the glyph that arm chose. The
// icon SVG lives inside the .trust-chip__icon span; the shim stores per-node innerHTML, so read it
// off the svg child. This lets a test assert WHICH glyph a state resolved to, not merely that an
// icon exists.
function glyphPresent(root: ShimNode, iconMarkup: string): boolean {
  const span = qs(root, ".trust-chip__icon");
  if (span === null) return false;
  const svg = span.querySelector("svg") ?? span.children[0] ?? null;
  return svg?.innerHTML.includes(iconMarkup) ?? false;
}

// labelOf reads the rendered chip label text (the .trust-chip__label span).
function labelOf(root: ShimNode): string {
  const span = qs(root, ".trust-chip__label");
  return span === null ? "" : textOf(span);
}

// titleOf reads the chip's hover title attribute (the honest explanation each arm carries).
function titleOf(root: ShimNode): string {
  return root.getAttribute("title") ?? "";
}

// ---- 1. accessChip: verified (teal/trust), with an email and an identity provider --------------

{
  // The verified state with both an email and an identity provider: teal trust tone, the
  // shield-check glyph, the email in the label, and the IdP named in the title (the title ternary's
  // identityProvider leg). This is the only family allowed to be green; the test pins that it is the
  // trust tone, not warn or neutral.
  const chip = accessChip({
    state: "verified",
    email: "tim@example.com",
    identityProvider: "Okta",
  }) as unknown as ShimNode;

  ok("verified chip carries the trust tone class", classesOf(chip).includes("trust-chip--trust"));
  ok("verified chip is not amber or neutral (F7: only verified is teal)", !classesOf(chip).includes("trust-chip--warn") && !classesOf(chip).includes("trust-chip--neutral"));
  ok("verified chip uses the shield-check glyph", glyphPresent(chip, ICON_SHIELD_CHECK));
  ok("verified chip names the verified email in the label", labelOf(chip) === "Access verified: tim@example.com");
  ok("verified chip title names the identity provider", titleOf(chip).includes("Okta"));
  ok("verified chip title states the engine reports Access-verified", titleOf(chip).includes("Access-verified"));
  // Honesty: the chip observes "passed Access policy", never a second-factor claim the JWT can't prove.
  ok("verified chip never claims a second factor", !titleOf(chip).toLowerCase().includes("second factor") && !titleOf(chip).toLowerCase().includes("two-factor"));
}

{
  // Verified WITHOUT an email and WITHOUT an identity provider: the label falls back to the plain
  // "Access verified" (the email ternary's else leg) and the title to the no-IdP wording (the title
  // ternary's else leg). email: null is a valid verified shape (whoami succeeded with no email).
  const chip = accessChip({ state: "verified", email: null }) as unknown as ShimNode;
  ok("emailless verified chip uses the plain verified label", labelOf(chip) === "Access verified");
  ok("IdP-less verified chip title omits a 'via' provider clause", !titleOf(chip).includes(" via "));
  ok("IdP-less verified chip still states it passed Access policy", titleOf(chip).includes("passed Access policy"));
  ok("emailless verified chip is still teal", classesOf(chip).includes("trust-chip--trust"));
}

// ---- 2. accessChip: passkey-verified (the second teal/trust state) -----------------------------

{
  // A passkey session is verified and attributable, so it is teal with its OWN copy: not Cloudflare
  // Access, not the shared token. Named-email leg of the label ternary.
  const named = accessChip({ state: "passkey-verified", email: "ops@example.com" }) as unknown as ShimNode;
  ok("passkey chip carries the trust tone class", classesOf(named).includes("trust-chip--trust"));
  ok("passkey chip uses the shield-check glyph", glyphPresent(named, ICON_SHIELD_CHECK));
  ok("passkey chip names the email in the label", labelOf(named) === "Passkey verified: ops@example.com");
  ok("passkey chip title states it is independent of Cloudflare Access", titleOf(named).includes("independent of Cloudflare Access"));
  ok("passkey chip title states no password or key was sent", titleOf(named).includes("No password or key was sent"));

  // Passkey WITHOUT an email exercises the label ternary's else leg.
  const anon = accessChip({ state: "passkey-verified", email: null }) as unknown as ShimNode;
  ok("emailless passkey chip uses the plain passkey label", labelOf(anon) === "Passkey verified");
  ok("emailless passkey chip is still teal", classesOf(anon).includes("trust-chip--trust"));
}

// ---- 3. accessChip: token-fallback (amber) ------------------------------------------------------

{
  // The shared-token break-glass: amber, the alert glyph, and copy that warns anyone with the URL
  // and token can administer it. This must NEVER be teal (it would slander the break-glass as a
  // verified identity).
  const chip = accessChip({ state: "token-fallback" }) as unknown as ShimNode;
  ok("token-fallback chip carries the warn tone class", classesOf(chip).includes("trust-chip--warn"));
  ok("token-fallback chip is not teal (F7)", !classesOf(chip).includes("trust-chip--trust"));
  ok("token-fallback chip uses the alert glyph", glyphPresent(chip, ICON_ALERT));
  ok("token-fallback chip label says the fallback is in use", labelOf(chip) === "Token fallback in use");
  ok("token-fallback chip title warns anyone with the URL and token can administer", titleOf(chip).includes("anyone with this URL and the shared token"));
}

// ---- 4. accessChip: session-present (amber, info glyph) -----------------------------------------

{
  // A 200 with whoami not yet resolved (D1 pending): authenticated, method unknown. Amber so it is
  // not mistaken for verified, but the info (not alert) glyph because nothing is wrong yet.
  const chip = accessChip({ state: "session-present" }) as unknown as ShimNode;
  ok("session-present chip carries the warn tone class", classesOf(chip).includes("trust-chip--warn"));
  ok("session-present chip uses the info glyph (not the alert glyph)", glyphPresent(chip, ICON_INFO) && !glyphPresent(chip, ICON_ALERT));
  ok("session-present chip label notes the method is unknown", labelOf(chip) === "Session present (method unknown)");
  ok("session-present chip title says whoami is pending", titleOf(chip).includes("whoami pending"));
}

// ---- 5. accessChip: unverified (amber, alert glyph) --------------------------------------------

{
  // A 401: the Access session is not valid. Amber and the alert glyph, with re-authenticate copy.
  const chip = accessChip({ state: "unverified" }) as unknown as ShimNode;
  ok("unverified chip carries the warn tone class", classesOf(chip).includes("trust-chip--warn"));
  ok("unverified chip uses the alert glyph", glyphPresent(chip, ICON_ALERT));
  ok("unverified chip label says the Access session is not valid", labelOf(chip) === "Access session not valid");
  ok("unverified chip title states the engine returned 401", titleOf(chip).includes("401"));
}

// ---- 6. accessChip: unknown (neutral, info glyph) ----------------------------------------------

{
  // The engine could not be reached: honest unknown, neutral (never a stale green). The info glyph
  // and copy that explicitly disavows a stale green.
  const chip = accessChip({ state: "unknown" }) as unknown as ShimNode;
  ok("unknown chip carries the neutral tone class", classesOf(chip).includes("trust-chip--neutral"));
  ok("unknown chip is neither teal nor amber", !classesOf(chip).includes("trust-chip--trust") && !classesOf(chip).includes("trust-chip--warn"));
  ok("unknown chip uses the info glyph", glyphPresent(chip, ICON_INFO));
  ok("unknown chip label says the Access status is unknown", labelOf(chip) === "Access status unknown");
  ok("unknown chip title disavows a stale green", titleOf(chip).includes("never a stale green"));
}

// ---- 7. accessChip structure: every chip is one span with exactly the icon and label children --

{
  // Structural invariant across states: the outer node is a <span> carrying the base trust-chip
  // class, with exactly two element children (the icon span and the label span). Asserted on a
  // representative teal and a representative neutral chip so a future refactor that drops a child
  // or changes the wrapper tag fails here.
  const teal = accessChip({ state: "verified", email: null }) as unknown as ShimNode;
  ok("the chip wrapper is a span", teal.tagName === "SPAN");
  ok("the chip carries the base trust-chip class", classesOf(teal).includes("trust-chip"));
  ok("the chip has an icon span and a label span", qs(teal, ".trust-chip__icon") !== null && qs(teal, ".trust-chip__label") !== null);
  ok("the chip wrapper has exactly two element children", teal.childElementCount === 2);
}

// ---- 8. noCustodyChip: the constant true teal statement ----------------------------------------

{
  // noCustodyChip reads no verdict; it is a by-construction guarantee. Teal, the lock glyph, the
  // never-sent-to-us label (precise: the key IS downloaded to the owner, so the honest claim is
  // custody, not physical browser containment), and the never-transmitted title.
  const chip = noCustodyChip() as unknown as ShimNode;
  ok("no-custody chip carries the trust tone class", classesOf(chip).includes("trust-chip--trust"));
  ok("no-custody chip uses the lock glyph", glyphPresent(chip, ICON_LOCK));
  ok("no-custody chip label states the key is never sent to us", labelOf(chip) === "No-custody: your key is never sent to us");
  ok("no-custody chip label does NOT claim the key never left the browser (it is downloaded)", !labelOf(chip).toLowerCase().includes("never left this browser"));
  ok("no-custody chip title states the key is never transmitted", titleOf(chip).includes("never transmitted to the engine or to us"));
  ok("no-custody chip is a span with the base trust-chip class", chip.tagName === "SPAN" && classesOf(chip).includes("trust-chip"));

  // It is a constant: a second call renders the same tone, glyph and label (no hidden verdict).
  const again = noCustodyChip() as unknown as ShimNode;
  ok("no-custody chip is the same constant statement on every call", classesOf(again).includes("trust-chip--trust") && labelOf(again) === labelOf(chip) && titleOf(again) === titleOf(chip));
}

// ---- 9. accessVerdictFromCaller: the passkey-method arm (the verdict-source path) --------------

{
  // The DOM-free validator covers the access / token / null paths; this fills the passkey arm.
  // A whoami with method "passkey" maps to the passkey-verified state, threading the email through,
  // and is NEVER folded into the amber token fallback.
  const caller = { method: "passkey", email: "ops@example.com" } as unknown as Caller;
  const verdict: AccessVerdict = accessVerdictFromCaller(caller, true);
  ok("a passkey caller maps to the passkey-verified state", verdict.state === "passkey-verified");
  ok("the passkey verdict threads the email through", verdict.state === "passkey-verified" && verdict.email === "ops@example.com");
  ok("a passkey caller is never the amber token fallback (honesty)", verdict.state !== "token-fallback");

  // A passkey caller with no email still maps to passkey-verified (email null is valid).
  const anon: AccessVerdict = accessVerdictFromCaller({ method: "passkey", email: null } as unknown as Caller, true);
  ok("an emailless passkey caller still maps to passkey-verified", anon.state === "passkey-verified");

  // F7 guard via the render path: feeding the derived passkey verdict back through accessChip yields
  // a teal chip, so the verdict source and the renderer agree on the trust family.
  const chip = accessChip(verdict) as unknown as ShimNode;
  ok("the derived passkey verdict renders as a teal chip (source<->render agree)", classesOf(chip).includes("trust-chip--trust"));
}

// ---- 10. the no-custody QUALIFICATION is reachable without a mouse ------------------------------

{
  // THE DEFECT THIS PINS. The chip's label is the claim ("your key is never sent to us") and
  // NO_CUSTODY_SCOPE is the qualification that bounds it. That qualification used to live ONLY in
  // the chip's title attribute, and a title is revealed by hover alone: the chip is a plain span
  // with no tabindex, so no keystroke reaches it; a touch device has no hover at all; and a generic
  // span's title is not announced as a description. Every reader who does not use a mouse was left
  // with the UNQUALIFIED label, which is a stronger claim than the product makes.
  // The house rule already forbids this ("triggered on focus as well as hover (never hover-only) ... never the
  // only place essential information lives"). The sibling Access verdict chip complies because
  // components/verdict.ts repeats its explanations as visible prose on the same screens; this chip
  // had no such panel, so the title was genuinely the only carrier.
  //
  // Two things are asserted, and the SECOND is the one that actually stops a regression. The first
  // only proves there is a single constant; the second proves the Overview still pairs it with a
  // focusable info-tip, so deleting the reachable copy reddens here instead of silently returning
  // the console to hover-only.
  const scope = chips.NO_CUSTODY_SCOPE;
  ok("the no-custody scoping is exported as one constant", typeof scope === "string" && scope.length > 0);

  const chip = noCustodyChip() as unknown as ShimNode;
  ok("the chip's title IS that constant (one source of truth, so the two carriers cannot drift)", titleOf(chip) === scope);
  ok("the label alone is still the SHORT claim, not the qualification (the copy is unchanged)", labelOf(chip) === "No-custody: your key is never sent to us" && labelOf(chip) !== scope);

  // The reachable carrier. Read as source text rather than rendered, because trustRow() reaches for
  // live refresh preferences the shim does not stand up; the point being pinned is the wiring, and
  // the wiring is a call site.
  const header = readFileSync(new URL("../../src/screens/overview/header.ts", import.meta.url), "utf8");
  ok("the Overview pairs the chip with a focusable info-tip", /infoTip\(\s*NO_CUSTODY_SCOPE/.test(header));
  ok("the info-tip is given the SAME constant, never a re-typed paraphrase", !/infoTip\(\s*["'`]/.test(header));
}

// ---- summary -----------------------------------------------------------------------------------

if (failures > 0) process.exitCode = 1;

if (failures > 0) {
  console.log(`\nTRUST-CHIPS COVERAGE: ${failures} FAIL`);
  process.exit(1);
}
console.log("\nTRUST-CHIPS COVERAGE PASS");
