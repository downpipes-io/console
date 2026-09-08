// Validate the accessible info-tip tooltip (src/components/info-tip.ts): the
// progressive-disclosure primitive the calm ceremony / custody screens use to move
// explanatory prose behind a focusable "(i)" trigger. This RENDERS the REAL component under
// the shared DOM shim (test/dom-shim.ts, the same hand-rolled approach the other component
// validators use) and drives its actual bindings; it never re-implements the behaviour.
//
// Run with `node test/validate-info-tip.ts`.
//
// Coverage (each load-bearing accessibility + safety property of the contract):
//   accessible name:     the trigger is a <button type="button"> with a non-empty aria-label
//                        (default and custom), so AT announces the control.
//   describedby link:    aria-describedby on the trigger equals the popover's id, and the
//                        popover carries role="tooltip" -- the text is associated with the
//                        trigger for assistive tech.
//   textContent safety:  the popover text is set via textContent (NO markup injection): a
//                        string containing "<img ...>" appears verbatim as text and creates
//                        no child element (an innerHTML path would have parsed it).
//   show on click/focus: the popover starts hidden (aria-expanded=false); a click reveals it
//                        (aria-expanded=true, not hidden); a second click toggles it shut;
//                        focusing the trigger reveals it.
//   Escape closes:       a document-level Escape keydown (the handler the component installs)
//                        hides the popover and restores aria-expanded=false.
//   outside dismiss:     a pointerdown OUTSIDE the widget closes an open popover; a
//                        pointerdown INSIDE the widget does NOT.
//
// Every section has a negative control that would fail on a wrong/no-op implementation.

import {
  installDomShim,
  qs,
  textOf,
} from "./dom-shim.ts";

installDomShim();

// Reach the document/window the shim installed. dispatchEvent on a node walks listeners; for
// the document-level capture listeners the component binds (pointerdown / focusin / keydown)
// we fire through the document's own addEventListener record via a small dispatch helper.
const doc = (globalThis as unknown as {
  document: {
    addEventListener: (t: string, fn: (ev: unknown) => void, capture?: boolean) => void;
    dispatchKey: (ev: { type: string; target: unknown; key?: string; stopPropagation(): void; preventDefault(): void; defaultPrevented: boolean }) => void;
    body: unknown;
  };
}).document;

// fireDoc dispatches an event at the document-level listeners (the capture handlers the
// tooltip installs live there). The shim's dispatchKey fans an event of ANY type to the
// document listeners of that type, which is exactly the pointerdown / focusin / keydown path.
function fireDoc(type: string, target: unknown, key?: string): void {
  const ev = {
    type,
    target,
    ...(key !== undefined ? { key } : {}),
    defaultPrevented: false,
    stopPropagation() {},
    preventDefault() {},
  };
  doc.dispatchKey(ev as never);
}

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

async function main(): Promise<void> {
  // Import AFTER the shim is installed (info-tip.ts pulls in lib/dom.ts, which touches
  // document at load).
  const { infoTip } = await import("../src/components/info-tip.ts");

  // ---------------------------------------------------------------------------
  // accessible name + describedby wiring
  // ---------------------------------------------------------------------------
  console.log("\n-- info-tip: accessible name + aria-describedby --");
  {
    const wrap = infoTip("The plain explanatory text.");
    // Mount so the document-level dismiss handlers (which the component only binds while
    // open) operate against a connected tree.
    (doc.body as { appendChild(n: unknown): void }).appendChild(wrap);
    const trigger = qs(wrap, ".info-tip")!;
    const pop = qs(wrap, ".info-tip__pop")!;

    ok("trigger is a BUTTON element", (trigger as unknown as { tagName: string }).tagName === "BUTTON");
    ok("trigger is type=button (never submits a form)", trigger.getAttribute("type") === "button");
    const aria = trigger.getAttribute("aria-label") ?? "";
    ok("trigger carries a non-empty aria-label (accessible name)", aria.length > 0);
    // Negative control: a default-labelled trigger is not left nameless.
    ok("default aria-label is the documented 'More information'", aria === "More information");

    const describedby = trigger.getAttribute("aria-describedby") ?? "";
    const popId = pop.getAttribute("id") ?? "";
    ok("popover has an id", popId.length > 0);
    ok("aria-describedby links the trigger to the popover id", describedby === popId);
    ok("popover carries role=tooltip", pop.getAttribute("role") === "tooltip");
    // Negative control: the link is a REAL match, not a vacuous empty==empty.
    ok("negative: describedby is not the empty string", describedby !== "");
  }

  // Custom label.
  {
    const wrap = infoTip("x", { label: "About the operational key" });
    const trigger = qs(wrap, ".info-tip")!;
    ok("a custom label is used as the accessible name", trigger.getAttribute("aria-label") === "About the operational key");
  }

  // ---------------------------------------------------------------------------
  // textContent safety (no markup injection)
  // ---------------------------------------------------------------------------
  console.log("\n-- info-tip: popover text is textContent, never parsed markup --");
  {
    const hostile = 'before <img src=x onerror=alert(1)> after &amp; <b>bold</b>';
    const wrap = infoTip(hostile);
    const pop = qs(wrap, ".info-tip__pop")!;
    // The text round-trips verbatim as text content.
    ok("popover textContent is the literal string (verbatim)", textOf(pop) === hostile);
    // The angle brackets are present literally in the text (proof it was not parsed away).
    ok("the literal '<img' substring is present as text", textOf(pop).includes("<img"));
    // CRITICAL no-injection control: setting via textContent creates NO child elements; an
    // innerHTML path would have parsed <img>/<b> into element children.
    ok(
      "no child ELEMENTS were created from the markup (textContent, not innerHTML)",
      (pop as unknown as { childElementCount: number }).childElementCount === 0,
    );
  }

  // ---------------------------------------------------------------------------
  // show on click / focus + toggle
  // ---------------------------------------------------------------------------
  console.log("\n-- info-tip: reveal on click + focus, toggle, hidden by default --");
  {
    const wrap = infoTip("Toggle me.");
    (doc.body as { appendChild(n: unknown): void }).appendChild(wrap);
    const trigger = qs(wrap, ".info-tip")!;
    const pop = qs(wrap, ".info-tip__pop")!;

    // Starts closed.
    ok("popover starts hidden", (pop as unknown as { hidden: boolean }).hidden === true);
    ok("trigger starts aria-expanded=false", trigger.getAttribute("aria-expanded") === "false");

    // Click opens.
    (trigger as unknown as { click(): void }).click();
    ok("after a click the popover is shown", (pop as unknown as { hidden: boolean }).hidden === false);
    ok("after a click aria-expanded is true", trigger.getAttribute("aria-expanded") === "true");

    // A second click toggles it shut (true toggle, not open-only).
    (trigger as unknown as { click(): void }).click();
    ok("a second click closes the popover (toggle)", (pop as unknown as { hidden: boolean }).hidden === true);
    ok("a second click restores aria-expanded=false", trigger.getAttribute("aria-expanded") === "false");

    // Focus opens.
    (trigger as unknown as { dispatchEvent(ev: unknown): void }).dispatchEvent({
      type: "focus", target: trigger, defaultPrevented: false, stopPropagation() {}, preventDefault() {},
    });
    ok("focusing the trigger reveals the popover", (pop as unknown as { hidden: boolean }).hidden === false);
  }

  // ---------------------------------------------------------------------------
  // Escape closes (and the document key handler is what does it)
  // ---------------------------------------------------------------------------
  console.log("\n-- info-tip: Escape closes the open popover --");
  {
    const wrap = infoTip("Press escape.");
    (doc.body as { appendChild(n: unknown): void }).appendChild(wrap);
    const trigger = qs(wrap, ".info-tip")!;
    const pop = qs(wrap, ".info-tip__pop")!;

    (trigger as unknown as { click(): void }).click();
    ok("precondition: popover is open before Escape", (pop as unknown as { hidden: boolean }).hidden === false);

    // The component installs a document-level keydown handler while open; fire Escape there.
    fireDoc("keydown", trigger, "Escape");
    ok("Escape hides the popover", (pop as unknown as { hidden: boolean }).hidden === true);
    ok("Escape restores aria-expanded=false", trigger.getAttribute("aria-expanded") === "false");
    // Negative control: a non-Escape key does NOT close it.
    (trigger as unknown as { click(): void }).click(); // reopen
    fireDoc("keydown", trigger, "a");
    ok("negative: a non-Escape key leaves the popover open", (pop as unknown as { hidden: boolean }).hidden === false);
  }

  // ---------------------------------------------------------------------------
  // outside-click dismiss (and inside-click does NOT dismiss)
  // ---------------------------------------------------------------------------
  console.log("\n-- info-tip: a pointerdown outside dismisses; inside does not --");
  {
    const wrap = infoTip("Click away.");
    (doc.body as { appendChild(n: unknown): void }).appendChild(wrap);
    const trigger = qs(wrap, ".info-tip")!;
    const pop = qs(wrap, ".info-tip__pop")!;

    (trigger as unknown as { click(): void }).click();
    ok("precondition: popover is open", (pop as unknown as { hidden: boolean }).hidden === false);

    // A pointerdown INSIDE the widget (on the popover itself) must NOT close it.
    fireDoc("pointerdown", pop);
    ok("a pointerdown inside the widget keeps it open", (pop as unknown as { hidden: boolean }).hidden === false);

    // A pointerdown OUTSIDE the widget closes it.
    fireDoc("pointerdown", doc.body);
    ok("a pointerdown outside the widget closes it", (pop as unknown as { hidden: boolean }).hidden === true);
    ok("aria-expanded is false after the outside dismiss", trigger.getAttribute("aria-expanded") === "false");
  }

  console.log(failures === 0 ? "\nINFO-TIP VALIDATORS PASS" : `\n${failures} FAILURE(S)`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
