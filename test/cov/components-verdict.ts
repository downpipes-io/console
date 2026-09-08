// Coverage for src/components/verdict.ts: the expanded TRUST / VERDICT surface. It renders the full Access
// verdict panel (the Access screen's hero), the always-true no-custody companion panel, and the
// generic honest-verdict surface used for results that are NOT the Access verdict (the audit
// chain-verify result, a connection probe). The crux it must honour is the F7 rule: the Access
// panel NEVER fabricates a green and only the verified / passkey-verified states are teal; every
// other state degrades to amber or neutral, and the copy observes only what the JWT proves.
//
// The sibling validator test/validate-components.ts already asserts the verdict<->chip TONE mirror
// via _testPresentAccessTone, so this file does not re-do the tone table; it drives the
// DOM-rendering functions the mirror test cannot reach (accessVerdictPanel, noCustodyPanel,
// genericGlyph, verdictSurface), rendering each REAL component under the shared DOM shim (no jsdom,
// no network) so every assertion exercises production code rather than re-implementing it.
//
// Run with: node test/cov/components-verdict.ts
//
// Surfaces driven (and the contract each asserts):
//   accessVerdictPanel  the role="status" region; one verdict--<tone> class per AccessVerdict state;
//                       the email-bearing and email-absent titles; the verified identityProvider
//                       branch; the always-present caveat line; the "harden this" action on the
//                       token-fallback / session-present states; the re-auth action on the
//                       unverified / unknown states; and that the verified state offers no action.
//   noCustodyPanel      the constant true (role="note") teal statement; it states the private key is
//                       generated in-browser and never transmitted, and reads no value.
//   genericGlyph        every GenericVerdictTone resolves to the documented glyph (via verdictSurface).
//   verdictSurface      the per-tone glyph default and a caller glyph override; a string body, a
//                       numeric body, a Node body, and the no-body / null / false guard; the optional
//                       action button (which fires the caller's onClick); and role status vs alert.

import { installDomShim, qs, qsa, textOf, classesOf, type ShimNode } from "../dom-shim.ts";
import { h } from "../../src/lib/dom.ts";
import {
  ICON_CHECK,
  ICON_X_CIRCLE,
  ICON_ALERT,
  ICON_SHIELD_CHECK,
  ICON_INFO,
} from "../../src/lib/icons.ts";

// Install the shim BEFORE importing the component (lib/dom.ts and several components create
// elements at load time).
installDomShim();

const verdict = await import("../../src/components/verdict.ts");
const { accessVerdictPanel, noCustodyPanel, verdictSurface } = verdict;

type GenericVerdictTone = import("../../src/components/verdict.ts").GenericVerdictTone;

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

// A glyph fingerprint helper: svgIcon sets the path markup verbatim as the SVG element's
// innerHTML, so the rendered verdict's icon carries the exact ICON_* string when that glyph was
// chosen. The icon SVG lives inside the .verdict__icon span; the shim stores per-node innerHTML,
// so read it off the svg child. This lets a test assert WHICH glyph a tone or state resolved to,
// not merely that an icon exists.
function glyphPresent(root: ShimNode, iconMarkup: string): boolean {
  const span = qs(root, ".verdict__icon");
  if (span === null) return false;
  const svg = span.querySelector("svg") ?? span.children[0] ?? null;
  return svg?.innerHTML.includes(iconMarkup) ?? false;
}

// ---- 1. accessVerdictPanel: the verified (teal/trust) state, with and without an email ---------

{
  // Verified with an email AND an identity provider: the teal trust tone, the named title, the
  // shield-check glyph, and the IdP-bearing body. The verified state offers NO action.
  const harden = { called: 0, label: "Harden access", onClick(): void { this.called++; } };
  const reauth = { called: 0, label: "Re-authenticate", onClick(): void { this.called++; } };
  const panel = accessVerdictPanel({
    verdict: { state: "verified", email: "tim@example.com", identityProvider: "Okta" },
    hardenAction: { label: harden.label, onClick: () => void harden.onClick() },
    reauthAction: { label: reauth.label, onClick: () => void reauth.onClick() },
  }) as unknown as ShimNode;

  ok("verified panel is a role=status region", panel.getAttribute("role") === "status");
  ok("verified panel carries the trust tone class", classesOf(panel).includes("verdict--trust"));
  ok("verified panel uses the shield-check glyph", glyphPresent(panel, ICON_SHIELD_CHECK));
  ok("verified panel names the verified email in the title", textOf(qs(panel, ".verdict__title")!).includes("tim@example.com"));
  ok("verified body names the identity provider", textOf(qs(panel, ".verdict__body")!).includes("Okta"));
  ok("verified panel always carries the honest caveat line", qs(panel, ".verdict__caveat") !== null && textOf(qs(panel, ".verdict__caveat")!).length > 0);
  // Despite supplying both actions, the verified state shows neither (there is nothing to fix).
  ok("verified panel offers no action button", qsa(panel, "button").length === 0);
  ok("the supplied actions were not invoked on the verified state", harden.called === 0 && reauth.called === 0);
}

{
  // Verified WITHOUT an email and WITHOUT an identity provider: the title falls back to "Access
  // verified" and the body to the no-IdP wording (the else branches of both ternaries).
  const panel = accessVerdictPanel({ verdict: { state: "verified", email: null } }) as unknown as ShimNode;
  ok("emailless verified panel uses the plain verified title", textOf(qs(panel, ".verdict__title")!).trim() === "Access verified");
  ok("IdP-less verified body omits an 'via' provider clause", !textOf(qs(panel, ".verdict__body")!).includes(" via "));
  ok("emailless verified panel still has no action", qsa(panel, "button").length === 0);
}

// ---- 2. accessVerdictPanel: passkey-verified (the second teal/trust state) ---------------------

{
  // Passkey with an email: trust tone, the passkey title naming the email, and the shield glyph.
  // This is the presentAccess passkey-verified case the tone-mirror test does not render.
  const named = accessVerdictPanel({ verdict: { state: "passkey-verified", email: "ops@example.com" } }) as unknown as ShimNode;
  ok("passkey panel carries the trust tone class", classesOf(named).includes("verdict--trust"));
  ok("passkey panel uses the shield-check glyph", glyphPresent(named, ICON_SHIELD_CHECK));
  ok("passkey panel names the email in the title", textOf(qs(named, ".verdict__title")!).includes("ops@example.com"));
  ok("passkey body states it is checked against the session cookie", textOf(qs(named, ".verdict__body")!).includes("session cookie"));
  ok("passkey panel offers no action button", qsa(named, "button").length === 0);

  // Passkey WITHOUT an email exercises the title else branch.
  const anon = accessVerdictPanel({ verdict: { state: "passkey-verified", email: null } }) as unknown as ShimNode;
  ok("emailless passkey panel uses the plain passkey title", textOf(qs(anon, ".verdict__title")!).trim() === "Passkey session");
}

// ---- 3. accessVerdictPanel: token-fallback (amber) offers the "harden" action ------------------

{
  let hardened = 0;
  let reauthed = 0;
  const panel = accessVerdictPanel({
    verdict: { state: "token-fallback" },
    hardenAction: { label: "Put Access in front", onClick: () => { hardened++; } },
    reauthAction: { label: "Re-authenticate", onClick: () => { reauthed++; } },
  }) as unknown as ShimNode;

  ok("token-fallback panel carries the warn tone class", classesOf(panel).includes("verdict--warn"));
  ok("token-fallback panel uses the alert glyph", glyphPresent(panel, ICON_ALERT));
  ok("token-fallback body names the lower-assurance break-glass path", textOf(qs(panel, ".verdict__body")!).includes("break-glass"));
  // The harden action is shown; the re-auth action is NOT (it is for unverified / unknown only).
  const buttons = qsa(panel, "button");
  ok("token-fallback shows exactly the harden action", buttons.length === 1 && textOf(buttons[0]!) === "Put Access in front");
  buttons[0]!.click();
  ok("clicking the harden action invokes the caller's onClick", hardened === 1);
  ok("the re-auth action was not rendered for token-fallback", reauthed === 0);
}

{
  // token-fallback with NO hardenAction supplied: the harden branch's guard fails, so no action
  // row is appended (childElementCount stays zero, the if-append-actions branch is skipped).
  const panel = accessVerdictPanel({ verdict: { state: "token-fallback" } }) as unknown as ShimNode;
  ok("token-fallback without a harden action renders no button", qsa(panel, "button").length === 0);
  ok("token-fallback without an action appends no actions row", qs(panel, ".verdict__actions") === null);
}

// ---- 4. accessVerdictPanel: session-present (amber) also offers "harden" ------------------------

{
  let hardened = 0;
  const panel = accessVerdictPanel({
    verdict: { state: "session-present" },
    hardenAction: { label: "Harden", onClick: () => { hardened++; } },
  }) as unknown as ShimNode;
  ok("session-present panel carries the warn tone class", classesOf(panel).includes("verdict--warn"));
  ok("session-present panel uses the info glyph", glyphPresent(panel, ICON_INFO));
  ok("session-present body says whoami is pending", textOf(qs(panel, ".verdict__body")!).includes("whoami is pending"));
  const buttons = qsa(panel, "button");
  ok("session-present shows the harden action", buttons.length === 1 && textOf(buttons[0]!) === "Harden");
  buttons[0]!.click();
  ok("clicking session-present harden invokes the caller's onClick", hardened === 1);
}

// ---- 5. accessVerdictPanel: unverified (amber) offers the re-auth action ------------------------

{
  let reauthed = 0;
  let hardened = 0;
  const panel = accessVerdictPanel({
    verdict: { state: "unverified" },
    hardenAction: { label: "Harden", onClick: () => { hardened++; } },
    reauthAction: { label: "Re-authenticate", onClick: () => { reauthed++; } },
  }) as unknown as ShimNode;
  ok("unverified panel carries the warn tone class", classesOf(panel).includes("verdict--warn"));
  ok("unverified panel uses the alert glyph", glyphPresent(panel, ICON_ALERT));
  ok("unverified body states the engine returned 401", textOf(qs(panel, ".verdict__body")!).includes("401"));
  // The re-auth action is shown; the harden action is NOT (unverified is not token-fallback /
  // session-present).
  const buttons = qsa(panel, "button");
  ok("unverified shows exactly the re-auth action", buttons.length === 1 && textOf(buttons[0]!) === "Re-authenticate");
  buttons[0]!.click();
  ok("clicking the re-auth action invokes the caller's onClick", reauthed === 1);
  ok("the harden action was not rendered for unverified", hardened === 0);
}

// ---- 6. accessVerdictPanel: unknown (neutral) offers re-auth, and degrades when none supplied ---

{
  let reauthed = 0;
  const panel = accessVerdictPanel({
    verdict: { state: "unknown" },
    reauthAction: { label: "Re-check", onClick: () => { reauthed++; } },
  }) as unknown as ShimNode;
  ok("unknown panel carries the neutral tone class", classesOf(panel).includes("verdict--neutral"));
  ok("unknown panel uses the info glyph", glyphPresent(panel, ICON_INFO));
  ok("unknown body states the engine could not be reached", textOf(qs(panel, ".verdict__body")!).includes("could not be reached"));
  const buttons = qsa(panel, "button");
  ok("unknown shows the re-auth/retry action", buttons.length === 1 && textOf(buttons[0]!) === "Re-check");
  buttons[0]!.click();
  ok("clicking the unknown retry invokes the caller's onClick", reauthed === 1);

  // unknown with NO reauthAction: the re-auth guard fails, so no button and no actions row.
  const bare = accessVerdictPanel({ verdict: { state: "unknown" } }) as unknown as ShimNode;
  ok("unknown without a re-auth action renders no button", qsa(bare, "button").length === 0);
  ok("unknown without an action appends no actions row", qs(bare, ".verdict__actions") === null);
}

// ---- 7. noCustodyPanel: the constant true (role=note) teal statement ----------------------------

{
  const panel = noCustodyPanel() as unknown as ShimNode;
  ok("no-custody panel is a role=note region (a statement, not a verdict)", panel.getAttribute("role") === "note");
  ok("no-custody panel carries the trust tone class", classesOf(panel).includes("verdict--trust"));
  ok("no-custody title states the by-construction guarantee", textOf(qs(panel, ".verdict__title")!).includes("No-custody, by construction"));
  ok("no-custody body states the private key never leaves the browser", textOf(qs(panel, ".verdict__body")!).includes("never transmitted"));
  ok("no-custody caveat states the recovery sheet carries only public fingerprints", textOf(qs(panel, ".verdict__caveat")!).includes("public fingerprints"));
  // It is a constant statement, so it has no actions at all.
  ok("no-custody panel offers no action button", qsa(panel, "button").length === 0);
}

// ---- 8. genericGlyph (via verdictSurface): every tone resolves to its documented glyph ----------

{
  // verdictSurface uses genericGlyph(tone) when no glyph override is given, so rendering each tone
  // and reading the embedded path proves the genericGlyph switch arm for that tone. The two
  // info/neutral arms share the info glyph (a fall-through), which this asserts too.
  const cases: Array<{ tone: GenericVerdictTone; icon: string; name: string }> = [
    { tone: "ok", icon: ICON_CHECK, name: "ok -> check" },
    { tone: "danger", icon: ICON_X_CIRCLE, name: "danger -> x-circle" },
    { tone: "warn", icon: ICON_ALERT, name: "warn -> alert" },
    { tone: "trust", icon: ICON_SHIELD_CHECK, name: "trust -> shield-check" },
    { tone: "info", icon: ICON_INFO, name: "info -> info" },
    { tone: "neutral", icon: ICON_INFO, name: "neutral -> info (fall-through)" },
  ];
  for (const c of cases) {
    const surface = verdictSurface({ tone: c.tone, title: `tone ${c.tone}` }) as unknown as ShimNode;
    ok(`genericGlyph ${c.name}`, glyphPresent(surface, c.icon));
    ok(`verdictSurface carries the verdict--${c.tone} class`, classesOf(surface).includes(`verdict--${c.tone}`));
  }
}

// ---- 9. verdictSurface: glyph override, body variants, action, and the role status/alert switch -

{
  // A glyph override beats the per-tone default (the ?? falls to the caller's glyph), and the
  // default role is "status" (assertive omitted).
  const overridden = verdictSurface({ tone: "ok", title: "Chain intact", glyph: ICON_ALERT }) as unknown as ShimNode;
  ok("a glyph override replaces the per-tone default glyph", glyphPresent(overridden, ICON_ALERT) && !glyphPresent(overridden, ICON_CHECK));
  ok("verdictSurface defaults to role=status", overridden.getAttribute("role") === "status");
  ok("verdictSurface renders the title", textOf(qs(overridden, ".verdict__title")!) === "Chain intact");
}

{
  // A string body is wrapped in a text node inside .verdict__body.
  const withText = verdictSurface({ tone: "ok", title: "Verified", body: "Intact through entry 42." }) as unknown as ShimNode;
  ok("a string body renders into the body paragraph", qs(withText, ".verdict__body") !== null && textOf(qs(withText, ".verdict__body")!) === "Intact through entry 42.");
}

{
  // A numeric body takes the String(opts.body) text branch (number is the other typeof arm).
  const withNumber = verdictSurface({ tone: "info", title: "Entries", body: 128 }) as unknown as ShimNode;
  ok("a numeric body renders its stringified value", textOf(qs(withNumber, ".verdict__body")!) === "128");
}

{
  // A Node body takes the else branch (appendChild(opts.body as Node)); the supplied element is
  // attached verbatim, with its own marker class so the test can find it.
  const node = h("span", { class: "probe-body-node" }, "latency 12 ms") as unknown as ShimNode;
  const withNode = verdictSurface({ tone: "info", title: "Probe", body: node as unknown as import("../../src/lib/dom.ts").Child }) as unknown as ShimNode;
  const bodyEl = qs(withNode, ".verdict__body");
  ok("a Node body is attached inside the body paragraph", bodyEl !== null && qs(bodyEl, ".probe-body-node") !== null);
  ok("the attached Node body keeps its text", textOf(qs(withNode, ".probe-body-node")!) === "latency 12 ms");
}

{
  // The no-body guard: undefined, null and false each skip the body paragraph entirely (the
  // three legs of the body !== undefined && !== null && !== false condition).
  const noBody = verdictSurface({ tone: "neutral", title: "No detail" }) as unknown as ShimNode;
  ok("an undefined body renders no body paragraph", qs(noBody, ".verdict__body") === null);
  const nullBody = verdictSurface({ tone: "neutral", title: "No detail", body: null as unknown as import("../../src/lib/dom.ts").Child }) as unknown as ShimNode;
  ok("a null body renders no body paragraph", qs(nullBody, ".verdict__body") === null);
  const falseBody = verdictSurface({ tone: "neutral", title: "No detail", body: false as unknown as import("../../src/lib/dom.ts").Child }) as unknown as ShimNode;
  ok("a false body renders no body paragraph", qs(falseBody, ".verdict__body") === null);
}

{
  // The optional action renders a button that fires the caller's onClick; assertive=true makes the
  // region role="alert" (the assertive interrupt branch). Together these cover both legs the
  // earlier cases left: the action if-branch and role=alert.
  let clicked = 0;
  const surface = verdictSurface({
    tone: "danger",
    title: "Break detected at entry 7",
    body: "A tamper-evident chain break, surfaced calmly.",
    action: { label: "View export", onClick: () => { clicked++; } },
    assertive: true,
  }) as unknown as ShimNode;
  ok("an assertive surface is a role=alert region", surface.getAttribute("role") === "alert");
  ok("a danger surface still renders calmly with its body", textOf(qs(surface, ".verdict__body")!).includes("surfaced calmly"));
  const button = qs(surface, ".verdict__actions button");
  ok("the optional action renders a button with the caller's label", button !== null && textOf(button) === "View export");
  button!.click();
  ok("clicking the action invokes the caller's onClick", clicked === 1);
}

{
  // No action supplied: the action if-branch is skipped, so no actions row is rendered (the
  // default-no-action leg complements the action-present case above).
  const surface = verdictSurface({ tone: "ok", title: "Re-verified" }) as unknown as ShimNode;
  ok("a surface without an action renders no actions row", qs(surface, ".verdict__actions") === null);
}

// ---- summary -----------------------------------------------------------------------------------

if (failures > 0) process.exitCode = 1;

if (failures > 0) {
  console.log(`\nVERDICT COVERAGE: ${failures} FAIL`);
  process.exit(1);
}
console.log("\nVERDICT COVERAGE PASS");
