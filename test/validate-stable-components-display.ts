// Group: the display primitives.
//
//   components/code-block.ts  codeBlock literal content + copy; keyField CONCEALMENT (fixed-length
//                             dot run, never the value or its real length) yet copies the REAL value.
//   components/sparkline.ts   sparkline (multi / single / empty point geometry) + miniBars + the
//                             derived text-alternative phrase; every chart carries role=img + caption.
//   components/wizard.ts      stepper status by SHAPE (tick / number / lock) + accessible status word;
//                             a done step is a real button (revisitable); a blocked step is disabled.
//   components/error-view.ts  blockError describe() across every ErrorKind branch (incl. the
//                             health-gated console-origin promotion) + Retry; inlineOutcome reassurance.
//
// Drives the REAL display components under the shared DOM shim; never re-implements them.

import {
  qs,
  qsa,
  textOf,
  classesOf,
  clipboardWrites,
  resetClipboard,
  setClipboardReject,
  flushAsync,
} from "./dom-shim.ts";
import { type Ctx, type Harness, SN, attr, click, findButtonByText } from "./validate-stable-components-shared.ts";

export async function runDisplay(h: Harness, ctx: Ctx): Promise<void> {
  const { codeBlock, keyField, copyButton, sparkline, miniBars, stepper, errorView } = ctx;

  // =========================================================================
  // 9. components/code-block.ts -- literal content + the CONCEALMENT invariant
  // =========================================================================
  console.log("\n-- code-block / keyField concealment --");
  {
    resetClipboard();
    const cmd = "wrangler kv namespace create <your-archive-bucket>";
    const block = codeBlock(cmd);
    const pre = qs(block, "pre")!;
    h.eq(textOf(pre), cmd, "codeBlock content is literal (placeholders render verbatim, not parsed)");
    h.ok("codeBlock has a copy button", qs(block, ".copy-btn") !== null);
    click(qs(block, ".copy-btn"));
    await flushAsync();
    h.ok("codeBlock copy copies the exact command", clipboardWrites.includes(cmd));
    // The "Copied" live region was created and announced.
    const live = qs(document.body, "[role=status]");
    h.ok("a polite live region exists for the Copied announcement", live !== null);
  }
  {
    // keyField: the no-custody concealment invariant. The value is shown as a FIXED-LENGTH dot
    // run (never the value, never its real length), yet copy copies the REAL bytes.
    resetClipboard();
    const secret = "k_super_secret_signer_value_42_chars_long!";
    const field = keyField({ label: "Signer key", value: secret });
    const valueEl = qs(field, ".key-field__value")!;
    const shown = textOf(valueEl);
    h.ok("keyField conceals the value (the value is NOT in the DOM)", !shown.includes(secret));
    h.ok("the concealed run is a fixed-length dot run", /^•+$/.test(shown));
    h.ok("the dot run does NOT leak the real length", shown.length !== secret.length);
    h.eq(shown.length, 24, "the dot run is a fixed 24 dots regardless of the value length");

    // Reveal toggles to the real value and back; aria-pressed + label track state.
    const revealBtn = qsa(field, "button").find((b) => (b.getAttribute("aria-label") ?? "").includes("Reveal"))!;
    h.eq(revealBtn.getAttribute("aria-pressed"), "false", "reveal starts unpressed");
    click(revealBtn);
    h.eq(textOf(valueEl), secret, "reveal shows the real value");
    h.eq(revealBtn.getAttribute("aria-pressed"), "true", "reveal is pressed after revealing");
    h.ok("reveal label switches to Hide", (revealBtn.getAttribute("aria-label") ?? "").includes("Hide"));
    click(revealBtn);
    h.eq(textOf(valueEl), shown, "hide re-conceals to the dot run");

    // Copy copies the REAL value even while concealed.
    const copyBtn = qsa(field, "button").find((b) => (b.getAttribute("aria-label") ?? "").includes("Copy"))!;
    click(copyBtn);
    await flushAsync();
    h.ok("keyField copy copies the REAL value (concealment by construction)", clipboardWrites.includes(secret));
  }
  {
    // copyButton: when the clipboard write rejects (blocked/insecure), it announces honestly and
    // does NOT throw. The reading getter is lazy (read at click time).
    resetClipboard();
    setClipboardReject(true);
    let reads = 0;
    const btn = copyButton("Copy token", () => { reads++; return "TOKEN"; });
    click(btn);
    await flushAsync();
    h.eq(reads, 1, "copyButton reads the getter lazily at click time");
    h.eq(clipboardWrites.length, 0, "a blocked clipboard records no write");
    h.ok("copyButton swallows a clipboard rejection (no throw)", true);
    setClipboardReject(false);
  }

  // =========================================================================
  // 10. components/sparkline.ts -- chart geometry + the text alternative
  // =========================================================================
  console.log("\n-- sparkline / miniBars --");
  {
    // Multi-point line: a path + a last-point dot; role=img with a derived phrase; a caption.
    const sp = sparkline({ values: [10, 20, 15, 40], unitLabel: "records" });
    const svg = qs(sp, "svg")!;
    h.eq(attr(svg, "role"), "img", "sparkline svg is role=img");
    h.ok("aria-label states the latest value and direction", (attr(svg, "aria-label") ?? "").includes("up"));
    h.ok("multi-point sparkline draws a line path", qsa(sp, "path").length >= 1);
    h.ok("multi-point sparkline marks the last point", qs(sp, "circle") !== null);
    h.ok("a visually-hidden caption carries the same phrase as text", qs(sp, ".visually-hidden") !== null);

    // area:true adds a filled area path; markLast:false omits the dot.
    const spArea = sparkline({ values: [1, 2, 3], area: true, markLast: false, tone: "ok" });
    h.ok("area:true adds a second path (the fill)", qsa(spArea, "path").length >= 2);
    h.ok("markLast:false omits the end dot", qs(spArea, "circle") === null);

    // Single point: a flat midline + a dot (still reads as a chart).
    const spOne = sparkline({ values: [42], unitLabel: "records" });
    h.ok("single-point sparkline renders a dot", qs(spOne, "circle") !== null);
    h.ok("single-point phrase notes one data point", (attr(qs(spOne, "svg"), "aria-label") ?? "").includes("one data point"));

    // No data: a dashed baseline + a no-data phrase; withCaption:false omits the caption.
    const spEmpty = sparkline({ values: [], unitLabel: "records", withCaption: false });
    h.ok("empty sparkline still renders an svg baseline", qs(spEmpty, "path") !== null);
    h.ok("empty phrase says no data yet", (attr(qs(spEmpty, "svg"), "aria-label") ?? "").includes("no data"));
    h.ok("withCaption:false omits the visually-hidden caption", qs(spEmpty, ".visually-hidden") === null);

    // A gap (non-finite) in the series is skipped but the x-scale still spans the full series.
    const spGap = sparkline({ values: [1, NaN, 3] });
    h.ok("a series with a gap still renders a line", qsa(spGap, "path").length >= 1);

    // An explicit label overrides the derived phrase.
    const spLabel = sparkline({ values: [1, 2], label: "Custom phrase" });
    h.eq(attr(qs(spLabel, "svg"), "aria-label"), "Custom phrase", "an explicit label overrides the derived phrase");
  }
  {
    // miniBars: one rect per finite value; a per-bar tone override; the text alternative.
    const mb = miniBars({ values: [5, 10, 0, 8], unitLabel: "runs", toneAt: (i) => (i === 1 ? "danger" : undefined) });
    h.eq(qsa(mb, "rect").length, 4, "miniBars renders one rect per value");
    h.eq(attr(qs(mb, "svg"), "role"), "img", "miniBars svg is role=img");
    h.ok("miniBars carries a caption", qs(mb, ".visually-hidden") !== null);

    // A gap renders fewer rects (the non-finite bar is skipped).
    const mbGap = miniBars({ values: [1, NaN, 3] });
    h.eq(qsa(mbGap, "rect").length, 2, "miniBars skips a non-finite bar");

    // Empty miniBars: no rects, but the svg + phrase are still present.
    const mbEmpty = miniBars({ values: [] });
    h.eq(qsa(mbEmpty, "rect").length, 0, "empty miniBars renders no bars");
    h.ok("empty miniBars still has an svg", qs(mbEmpty, "svg") !== null);
  }
  {
    // The derived-phrase seam (pure): direction words for up / down / steady / one / none.
    const sparkMod = await import("../src/components/sparkline.ts");
    h.ok("derivePhrase: up", sparkMod._testDerivePhrase([1, 5], "records").includes("up"));
    h.ok("derivePhrase: down", sparkMod._testDerivePhrase([5, 1], "records").includes("down"));
    h.ok("derivePhrase: steady", sparkMod._testDerivePhrase([3, 3], "records").includes("steady"));
    h.ok("derivePhrase: one point", sparkMod._testDerivePhrase([7], "records").includes("one data point"));
    h.ok("derivePhrase: no data", sparkMod._testDerivePhrase([], "records").includes("no data"));
    // Negative control: an up series must not read "down".
    h.ok("derivePhrase up is not labelled down", !sparkMod._testDerivePhrase([1, 9]).includes("down"));
  }

  // =========================================================================
  // 11. components/wizard.ts -- the stepper (shape + accessible status word)
  // =========================================================================
  console.log("\n-- wizard (stepper) --");
  {
    let jumped = -1;
    const steps = [
      { id: "connect", label: "Connect" },
      { id: "verify", label: "Verify Access" },
      { id: "ceremony", label: "Key ceremony", blockedReason: "connect first" },
    ];
    const ol = stepper({
      steps,
      currentIndex: 1,
      statusOf: (_s, i, cur) => (i === 2 ? "blocked" : i < cur ? "done" : i === cur ? "current" : "upcoming"),
      onJump: (_s, i) => { jumped = i; },
    });
    h.eq(SN(ol).tagName, "OL", "the stepper is an ordered list");
    const items = qsa(ol, ".stepper__item");
    h.eq(items.length, 3, "three steps");
    h.ok("the done step carries the done modifier", classesOf(items[0]).includes("stepper__item--done"));
    h.ok("the current step carries aria-current=step", attr(items[1], "aria-current") === "step");
    h.ok("the done step renders a tick (svg), not a number", qs(items[0], "svg") !== null);
    h.ok("the blocked step renders a lock (svg)", qs(items[2], "svg") !== null);

    // The accessible status word is present (done / current step / locked: reason). The two INTERACTIVE steps
    // (the jumpable done button, the focusable blocked control) carry it in an explicit aria-label so their
    // accessible name is exactly "<label>, <status>": composing that name from a sibling visually-hidden span
    // instead let the accessible-name-from-content algorithm wedge a separator space in ("Choose , done"). The
    // non-interactive current/upcoming row, having no control to name, keeps the inline visually-hidden span.
    const hiddenWords = qsa(ol, ".visually-hidden").map((n) => textOf(n));
    h.ok("done step exposes a 'done' status word", (attr(qs(items[0], "button"), "aria-label") ?? "").includes("done"));
    h.ok("current step exposes a 'current step' status word", hiddenWords.some((w) => w.includes("current step")));
    h.ok("blocked step exposes the lock reason", (attr(qs(items[2], ".stepper__blocked"), "aria-label") ?? "").includes("locked: connect first"));

    // A done step is a real revisitable button that fires onJump.
    const doneBtn = qs(items[0], "button");
    h.ok("the done step is a real button (revisitable)", doneBtn !== null);
    click(doneBtn);
    h.eq(jumped, 0, "clicking a done step fires onJump with its index");

    // A blocked step is a disabled control, focusable, with the reason announced
    // inline, never a hover-only title, NOT a link.
    const blocked = qs(items[2], ".stepper__blocked")!;
    h.eq(attr(blocked, "aria-disabled"), "true", "blocked step is aria-disabled");
    h.eq(attr(blocked, "tabindex"), "0", "blocked step is focusable (discoverable by keyboard)");
    h.ok("blocked step announces the reason via its accessible name", (attr(blocked, "aria-label") ?? "").includes("connect first"));
    h.ok("blocked step has no hover-only title", attr(blocked, "title") === null);
    h.ok("blocked step is NOT a button", qs(items[2], "button") === null);
  }
  {
    // The DEFAULT status resolver (before=done, at=current, after=upcoming) when statusOf is omitted,
    // and onJump omitted makes the stepper purely indicative (a done step is plain, no button).
    const ol = stepper({ steps: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }], currentIndex: 1 });
    const items = qsa(ol, ".stepper__item");
    h.ok("default resolver: step before current is done", classesOf(items[0]).includes("stepper__item--done"));
    h.ok("default resolver: step at current is current", classesOf(items[1]).includes("stepper__item--current"));
    h.ok("default resolver: step after current is upcoming", classesOf(items[2]).includes("stepper__item--upcoming"));
    h.ok("upcoming step renders its number (no svg marker)", qs(items[2], "svg") === null);
    h.ok("without onJump a done step is not a button (purely indicative)", qs(items[0], "button") === null);
  }

  // =========================================================================
  // 12. components/error-view.ts -- blockError describe() branches + inlineOutcome
  // =========================================================================
  console.log("\n-- error-view --");
  {
    // A plain network failure (no health probe): the network block + Retry.
    let retried = 0;
    const netCard = errorView.blockError(new TypeError("Failed to fetch"), () => { retried++; });
    h.eq(attr(netCard, "role"), "alert", "block error is role=alert");
    h.ok("network block heading names an unreachable engine", textOf(qs(netCard, ".block-error__title")).includes("Could not reach the engine"));
    const retryBtn = findButtonByText(netCard, "Retry")!;
    click(retryBtn);
    h.eq(retried, 1, "Retry re-runs the failed load");

    // The console-origin promotion ONLY fires when health is confirmed reachable AND an origin is named.
    const originCard = errorView.blockError(new TypeError("Failed to fetch"), () => {}, { origin: "https://console.test", healthReachable: true });
    h.ok("health-confirmed fetch failure promotes to a console-origin diagnosis", textOf(qs(originCard, ".block-error__title")).includes("CONSOLE_ORIGIN"));
    h.ok("console-origin shows the exact origin to set", textOf(originCard).includes("https://console.test"));

    // A failed health probe (healthReachable:false) stays a plain network error (NOT console-origin).
    const stillNet = errorView.blockError(new TypeError("Failed to fetch"), () => {}, { origin: "https://console.test", healthReachable: false });
    h.ok("a FAILED health probe stays a network error (no false console-origin)", textOf(qs(stillNet, ".block-error__title")).includes("Could not reach the engine"));

    // Every remaining describe() branch, driven via a classifyError-shaped message (errors.ts maps a
    // trailing ": <status>" to a kind; the dual-control reason and the access-redirect marker route
    // to their own kinds). This exercises the full switch without touching any churning screen.
    const headOf = (card: HTMLElement): string => textOf(qs(card, ".block-error__title"));

    // 403 role denial -> "Not permitted" (a capability gate, not an outage).
    const forbidden = errorView.blockError(new Error("list downpipes: 403"), () => {});
    h.ok("a 403 role denial reads as a permission denial", headOf(forbidden).includes("Not permitted"));

    // 403 with the dual-control reason -> "Awaiting approval" (maker != checker), NOT a role gate.
    const unapproved = errorView.blockError(new Error("apply restore: restore not approved: 403"), () => {});
    h.ok("a dual-control 403 reads as awaiting approval (not a role gate)", headOf(unapproved).includes("Awaiting approval"));
    h.ok("the awaiting-approval copy is NOT the permission-denial copy", !headOf(unapproved).includes("Not permitted"));

    // 401 -> "Your session is not valid" (the honest fallback if it lands here, normally routed to signed-out).
    // A 401 comes from any sign-in method (passkey, OIDC, SAML, Access), so the copy must not name Access.
    const unauth = errorView.blockError(new Error("whoami: 401"), () => {});
    h.ok("a 401 reads as an invalid session", headOf(unauth).includes("Your session is not valid"));
    h.ok("a 401 does not assume a Cloudflare Access session", !textOf(unauth).includes("Access"));

    // An Access-redirect body -> the refresh-your-Access-session copy.
    const redirect = errorView.blockError(new Error("list runs: access-redirect"), () => {});
    h.ok("an access-redirect reads as a session-refresh prompt", headOf(redirect).includes("Cloudflare Access session needs refreshing"));

    // A 5xx -> "The engine returned an error" with the status echoed.
    const server = errorView.blockError(new Error("list downpipes: 500"), () => {});
    h.ok("a 5xx reads as an engine error", headOf(server).includes("The engine returned an error"));
    h.ok("the server error echoes the status in its detail", textOf(server).includes("500"));

    // A 2xx whose body could not be read -> the honest "engine answered" copy, never the "could not
    // reach the engine" copy: a malformed-json GET /admin/history response still means the request
    // completed and the engine was reached; only the body was unreadable.
    const answerUnreadable = errorView.blockError(new Error("history: 200"), () => {});
    h.ok("a 2xx with an unreadable body reads as 'the engine answered' (not unreachable)", headOf(answerUnreadable).includes("The engine answered"));
    h.ok("a 2xx with an unreadable body does NOT use the unreachable-engine heading", !headOf(answerUnreadable).includes("Could not reach the engine"));
    h.ok("the answer-unreadable detail echoes the real 2xx status", textOf(answerUnreadable).includes("200"));
    h.ok("the answer-unreadable detail does not send the operator to check reachability", !textOf(answerUnreadable).includes("can reach the engine address"));
    const retryUnreadable = findButtonByText(answerUnreadable, "Retry");
    h.ok("the answer-unreadable card keeps the Retry affordance", retryUnreadable !== null);

    // inlineOutcome: an expected in-flow result (role=status, not alert) with optional reassurance.
    const outcome = errorView.inlineOutcome({ heading: "Nothing matched", reason: "No records under that prefix.", reassurance: "Nothing was written." });
    h.eq(attr(outcome, "role"), "status", "inlineOutcome is role=status (expected result, not a fault)");
    h.eq(textOf(qs(outcome, ".inline-outcome__title")), "Nothing matched", "inlineOutcome heading rendered");
    h.ok("inlineOutcome shows the coarse reason", textOf(outcome).includes("No records under that prefix."));
    h.ok("inlineOutcome shows the reassurance when supplied", textOf(outcome).includes("Nothing was written."));
    // Without reassurance, no extra hint line is emitted.
    const outcomeNoReassure = errorView.inlineOutcome({ heading: "H", reason: "R" });
    h.ok("inlineOutcome without reassurance omits the hint", !textOf(outcomeNoReassure).includes("Nothing was written."));
  }

  // =========================================================================
  // 13. screens/setup/b/page.ts -- the gated-primary re-lock contract
  // =========================================================================
  console.log("\n-- gated primary re-lock (the setup surface's Saved question) --");
  {
    // The setup surface holds its primary with a visible REASON, never a bare dead control: the primary keeps
    // its focus (aria-disabled, not the disabled property) and the reason sits beside it as text. The contract
    // must hold in BOTH directions: meeting the gate removes aria-disabled and hides the reason; un-meeting it
    // restores both, and repeated changes never stack a second reason. Driven through the REAL page at
    // /setup/keys/saved, whose gate is the "I moved identity.key off this computer." tick and CAN re-lock.
    // (This contract was the first-run deck's prereqs card; the deck is retired and the contract moved here.)
    const harness = await import("./setup-surface-harness.ts");
    const { runKeyCeremony } = await import("../src/keygen.ts");
    const { setCeremony } = await import("../src/lib/store.ts");
    const { setupModel } = await import("../src/lib/setup-flow/index.ts");
    const { makeEvent } = await import("./dom-shim-core.ts");
    harness.resetSetupWorld(harness.OWNER);
    setCeremony(await runKeyCeremony({ operational: false }));
    setupModel().update({ started: true, posture: "break-glass-only", postureAcknowledged: true, custody: "password-manager", keysGenerated: true, refusedFiles: [] });
    const host = await harness.renderSetup("/setup/keys/saved");
    const btn = qs(host, ".fb-primary");
    h.ok("the Saved primary renders", btn !== null);
    const reasonText = "Tick the box first.";
    const reasons = () => qsa(host, ".fb-reason").filter((r) => !SN(r).hidden);
    h.ok("first render: the primary is held by aria-disabled, and keeps its focus (no disabled property)", attr(btn, "aria-disabled") === "true" && SN(btn).disabled !== true);
    h.eq(reasons().length, 1, "first render: exactly one visible reason");
    h.ok("first render: the reason says what to do", textOf(reasons()[0]).includes(reasonText));
    const tick = qsa(host, "input").find((i) => attr(i, "type") === "checkbox");
    h.ok("the question renders its tick", tick !== undefined);
    const setTick = (v: boolean): void => {
      SN(tick).checked = v;
      SN(tick).dispatchEvent(makeEvent({ type: "change", bubbles: true }));
    };

    setTick(true);
    h.eq(attr(btn, "aria-disabled"), null, "ticking removes aria-disabled");
    h.eq(reasons().length, 0, "ticking hides the reason");

    setTick(false);
    h.eq(attr(btn, "aria-disabled"), "true", "un-ticking restores aria-disabled");
    h.eq(reasons().length, 1, "un-ticking restores exactly ONE visible reason");
    h.ok("the restored reason says the same thing", textOf(reasons()[0]).includes(reasonText));

    setTick(true);
    h.eq(attr(btn, "aria-disabled"), null, "a second tick still unlocks after the re-lock");
    setTick(false);
    h.eq(reasons().length, 1, "a second re-lock still shows exactly one reason, never an accumulation");
    setCeremony(null);
    setupModel().reset();
  }

  // What Welcome asks the customer to have. downpipes writes to four kinds of store, so nothing on the first
  // view may require R2 or claim the backups are written to R2: a customer archiving to S3, Google Cloud or
  // Azure must be able to read Welcome truthfully. The paid plan is the one account requirement it names.
  console.log("\n-- Welcome's requirements stay true for every destination --");
  {
    const harness = await import("./setup-surface-harness.ts");
    harness.resetSetupWorld(harness.OWNER);
    const welcome = textOf(await harness.renderSetup("/setup/welcome"));
    h.ok("Welcome rendered", welcome.includes("Set up your first backup"));
    h.ok("no requirement asks the customer to turn R2 on", !welcome.includes("R2 object storage is turned on"));
    h.ok("...and none claims the backups are written to R2", !welcome.includes("Your backups are written to R2"));
    h.ok("the one account requirement named is the Workers Paid plan", welcome.includes("Workers Paid plan"));
    const provider = textOf(await harness.renderSetup("/setup/destination/provider"));
    h.ok("the destination question offers every store the product writes to", provider.includes("Cloudflare R2") && provider.includes("S3-compatible") && provider.includes("Google Cloud") && provider.includes("Azure Blob"));
  }
}
