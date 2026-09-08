// Group: the overlay family.
//
//   components/dialog.ts         the shared overlay engine: dialogSurface ARIA, mount,
//                                background inert, focus-in, Esc + click-out dismiss, the
//                                nested stack inert, Tab trapping, closeAllOverlays.
//   components/drawer.ts         openDrawer composes the engine; drawerSection heading order.
//   components/detail-drawer.ts  subhead, footer grouping and kvRow text-safety; the
//                                danger-grouped footer; a disabled action carries its reason
//                                and no click handler; kvRow text-safety.
//
// Drives the REAL overlay components under the shared DOM shim; never re-implements them.

import {
  activeElement,
  dispatchDocKey,
  flushAsync,
  keydown,
  qs,
  qsa,
  type ShimEvent,
  type ShimNode,
  textOf,
} from "./dom-shim.ts";
import {
  attr,
  type Ctx,
  click,
  findButtonByText,
  type Harness,
  SN,
} from "./validate-stable-components-shared.ts";

export async function runOverlays(h: Harness, ctx: Ctx): Promise<void> {
  const { h: hEl, dialog, openDrawer, drawerSection, detailDrawer } = ctx;

  // =========================================================================
  // 4. components/dialog.ts -- the shared overlay engine
  // =========================================================================
  console.log("\n-- dialog (overlay engine) --");
  {
    // dialogSurface builds the ARIA-correct surface.
    const { surface, titleId } = dialog.dialogSurface({
      variant: "modal",
      title: "Confirm thing",
      body: hEl("p", "body text"),
      footer: hEl("button", { type: "button" }, "OK"),
      onCloseClick: () => {},
    });
    h.eq(attr(surface, "role"), "dialog", "surface role=dialog");
    h.eq(attr(surface, "aria-modal"), "true", "surface aria-modal=true");
    h.eq(attr(surface, "aria-labelledby"), titleId, "surface labelled by the title id");
    h.eq(textOf(qs(surface, ".dialog__title")), "Confirm thing", "title text rendered");
    h.ok("surface has a close button by default", qs(surface, ".dialog__close") !== null);
    h.ok("surface has a footer when footer supplied", qs(surface, ".dialog__footer") !== null);

    // closeButton:false omits the X.
    const { surface: noX } = dialog.dialogSurface({ variant: "modal", title: "No X", body: hEl("p", "b"), closeButton: false });
    h.ok("closeButton:false omits the close X", qs(noX, ".dialog__close") === null);

    // describedById wires aria-describedby (the optional spread branch); a bare surface omits it.
    const { surface: described } = dialog.dialogSurface({ variant: "modal", title: "Desc", body: hEl("p", "b"), describedById: "desc-1" });
    h.eq(attr(described, "aria-describedby"), "desc-1", "describedById sets aria-describedby");
    h.eq(attr(noX, "aria-describedby"), null, "no describedById leaves aria-describedby unset");

    // The close X invokes onCloseClick (the click handler's optional-call branch with a callback).
    let xClicks = 0;
    const { surface: withX } = dialog.dialogSurface({ variant: "modal", title: "X", body: hEl("p", "b"), onCloseClick: () => { xClicks++; } });
    click(qs(withX, ".dialog__close"));
    h.eq(xClicks, 1, "clicking the close X invokes onCloseClick");
    // A close X with no onCloseClick handler is a safe no-op (the undefined optional-call branch).
    const { surface: noHandler } = dialog.dialogSurface({ variant: "modal", title: "X2", body: hEl("p", "b") });
    click(qs(noHandler, ".dialog__close"));
    h.ok("clicking the close X with no handler does not throw", true);
  }
  {
    // Mount via openOverlay: backdrop appended to body, background (#app) inerted,
    // focus moves to the supplied initialFocus, Esc tears down + restores focus.
    const appShell = hEl("div", { id: "app" });
    document.body.appendChild(appShell);
    // An invoking control that focus should return to on close.
    const invoker = hEl("button", { type: "button" }, "Open");
    appShell.appendChild(invoker);
    invoker.focus();
    h.eq(activeElement(), invoker as unknown as ShimNode, "the invoker holds focus before open");

    const cancelBtn = hEl("button", { type: "button" }, "Cancel");
    const { surface } = dialog.dialogSurface({ variant: "modal", title: "M", body: hEl("p", "x"), footer: cancelBtn });
    let closedCount = 0;
    const handle = dialog.openOverlay({
      surface,
      variant: "modal",
      dismissable: true,
      initialFocus: cancelBtn,
      onClose: () => { closedCount++; },
    });
    await flushAsync();
    h.ok("backdrop mounted to body", document.querySelector(".overlay") !== null);
    h.eq(attr(appShell, "inert"), "", "the #app background is made inert while open");
    h.eq(attr(appShell, "aria-hidden"), "true", "aria-hidden fallback set on the background");
    h.eq(activeElement(), cancelBtn as unknown as ShimNode, "focus moved to the supplied Cancel control");

    // Esc closes the topmost overlay (the document-level handler), restoring focus + clearing inert.
    dispatchDocKey(keydown({ key: "Escape" }));
    h.ok("Esc tears down the overlay", document.querySelector(".overlay") === null);
    h.eq(closedCount, 1, "onClose fired exactly once on Esc");
    h.eq(attr(appShell, "inert"), null, "inert cleared after close");
    h.eq(activeElement(), invoker as unknown as ShimNode, "focus returned to the invoker on close");

    // Calling close() again is a no-op (idempotent teardown).
    handle.close();
    h.eq(closedCount, 1, "a second close() does not re-fire onClose");
  }
  {
    // A focusReturn RESOLVER is evaluated at CLOSE time, so a caller whose invoking control is
    // rebuilt (detached + re-created) between open and close returns focus to the CURRENT element,
    // not the stale captured node. This is the downpipe drawer: opened by a route change that
    // re-runs load() and rebuilds every row, detaching the row that held focus at open. The
    // default (no focusReturn) still captures the open-time node, proven by the block above.
    const appShell = document.getElementById("app")!;
    const original = hEl("button", { type: "button", dataset: { key: "dp-1" } }, "row one");
    appShell.appendChild(original);
    original.focus();
    const { surface } = dialog.dialogSurface({ variant: "drawer", title: "D", body: hEl("p", "x") });
    const handle = dialog.openOverlay({
      surface,
      variant: "drawer",
      // Re-find the row by its data-key at close (mirrors openDetail's resolver on the real screen).
      focusReturn: () => qs(appShell, '[data-key="dp-1"]') as unknown as HTMLElement | null,
    });
    await flushAsync();
    // Simulate the route-triggered reload: the original row is detached and a fresh one with the
    // SAME key is built in its place (a new node the captured-at-open approach would have missed).
    original.remove();
    const rebuilt = hEl("button", { type: "button", dataset: { key: "dp-1" } }, "row one (rebuilt)");
    appShell.appendChild(rebuilt);
    handle.close();
    h.eq(activeElement(), rebuilt as unknown as ShimNode, "a resolver focusReturn re-finds the REBUILT row on close, not the detached original");
    h.ok("the detached original is not what holds focus", activeElement() !== (original as unknown as ShimNode));
    rebuilt.remove();
  }
  {
    // Click-out dismiss: a mousedown on the backdrop itself dismisses.
    const appShell = document.getElementById("app")!;
    const { surface } = dialog.dialogSurface({ variant: "modal", title: "Click", body: hEl("p", "x") });
    // On a holder: a `let` written only from inside a callback keeps the narrowing from its
    // initialiser, because the compiler cannot see the callback run, so these reads would be
    // comparisons against a type the value can never hold and would prove nothing.
    const rec = { closed: false };
    dialog.openOverlay({ surface, variant: "modal", dismissable: true, onClose: () => { rec.closed = true; } });
    await flushAsync();
    const backdrop = SN(document.querySelector(".overlay"));
    // mousedown with target === backdrop dismisses; target === surface does not.
    const downOnSurface = { type: "mousedown", target: surface as unknown as ShimNode, currentTarget: backdrop, defaultPrevented: false, bubbles: true, preventDefault() {}, stopPropagation() {} } as ShimEvent;
    backdrop.dispatchEvent(downOnSurface);
    h.ok("mousedown on the surface (not the backdrop) does NOT dismiss", document.querySelector(".overlay") !== null && rec.closed === false);
    const downOnBackdrop = { type: "mousedown", target: backdrop, currentTarget: backdrop, defaultPrevented: false, bubbles: true, preventDefault() {}, stopPropagation() {} } as ShimEvent;
    backdrop.dispatchEvent(downOnBackdrop);
    h.ok("mousedown on the backdrop dismisses", document.querySelector(".overlay") === null && rec.closed === true);
    void appShell;
  }
  {
    // dismissable:false ignores click-out (but the engine still mounts).
    const { surface } = dialog.dialogSurface({ variant: "modal", title: "Locked", body: hEl("p", "x") });
    dialog.openOverlay({ surface, variant: "modal", dismissable: false });
    await flushAsync();
    const backdrop = SN(document.querySelector(".overlay"));
    const down = { type: "mousedown", target: backdrop, currentTarget: backdrop, defaultPrevented: false, bubbles: true, preventDefault() {}, stopPropagation() {} } as ShimEvent;
    backdrop.dispatchEvent(down);
    h.ok("dismissable:false ignores click-out", document.querySelector(".overlay") !== null);
    dialog.closeAllOverlays();
  }
  {
    // Nested stack: opening a second overlay inerts the first surface; closeAllOverlays
    // tears EVERYTHING down WITHOUT firing onClose (the router's navigation path).
    const appShell = document.getElementById("app")!;
    const { surface: s1 } = dialog.dialogSurface({ variant: "drawer", title: "First", body: hEl("p", "1") });
    let c1 = 0;
    dialog.openOverlay({ surface: s1, variant: "drawer", onClose: () => { c1++; } });
    const { surface: s2 } = dialog.dialogSurface({ variant: "modal", title: "Second", body: hEl("p", "2") });
    let c2 = 0;
    dialog.openOverlay({ surface: s2, variant: "modal", onClose: () => { c2++; } });
    await flushAsync();
    h.eq(qsa(document.body, ".overlay").length, 2, "two overlays stacked");
    h.eq(attr(s1, "inert"), "", "the lower surface is inerted while the upper is open");
    dialog.closeAllOverlays();
    h.eq(qsa(document.body, ".overlay").length, 0, "closeAllOverlays removes every overlay");
    h.eq(c1 + c2, 0, "closeAllOverlays does NOT invoke onClose (router-navigation contract)");
    h.eq(attr(appShell, "inert"), null, "background interactivity restored after closeAllOverlays");
    // closeAllOverlays is safe to call when nothing is open.
    dialog.closeAllOverlays();
    h.ok("closeAllOverlays is a no-op when nothing is open", true);
  }
  {
    // Tab trapping (the document-level keydown handler's Tab branch -> trapTab). A surface with
    // more than one focusable wraps at each edge: forward Tab off the LAST control returns to the
    // first; Shift-Tab off the FIRST control wraps to the last. Tab in the middle is left alone.
    const first = hEl("button", { type: "button" }, "First");
    const middle = hEl("button", { type: "button" }, "Middle");
    const last = hEl("button", { type: "button" }, "Last");
    const body = hEl("div");
    body.appendChild(first);
    body.appendChild(middle);
    body.appendChild(last);
    const { surface } = dialog.dialogSurface({ variant: "modal", title: "Trap", body, closeButton: false });
    dialog.openOverlay({ surface, variant: "modal", initialFocus: first });
    await flushAsync();
    h.eq(activeElement(), first as unknown as ShimNode, "focus starts on the first control");

    // Forward Tab while NOT at the last edge: the trap does not move focus (the browser advances).
    const midTab = keydown({ key: "Tab" });
    dispatchDocKey(midTab);
    h.eq(midTab.defaultPrevented, false, "forward Tab in the middle is not intercepted");

    // Forward Tab AT the last control wraps to the first (preventDefault + focus first).
    (last as unknown as ShimNode).focus();
    const wrapForward = keydown({ key: "Tab" });
    dispatchDocKey(wrapForward);
    h.ok("forward Tab off the last control is intercepted", wrapForward.defaultPrevented === true);
    h.eq(activeElement(), first as unknown as ShimNode, "forward Tab off the last control wraps to the first");

    // Shift-Tab AT the first control wraps to the last.
    const wrapBack = keydown({ key: "Tab", shiftKey: true });
    dispatchDocKey(wrapBack);
    h.ok("Shift-Tab off the first control is intercepted", wrapBack.defaultPrevented === true);
    h.eq(activeElement(), last as unknown as ShimNode, "Shift-Tab off the first control wraps to the last");

    // Shift-Tab while NOT at an edge is left alone.
    (middle as unknown as ShimNode).focus();
    const midShift = keydown({ key: "Tab", shiftKey: true });
    dispatchDocKey(midShift);
    h.eq(midShift.defaultPrevented, false, "Shift-Tab in the middle is not intercepted");

    // Shift-Tab when focus sits on the SURFACE itself (the tabindex=-1 panel) also wraps to the last.
    (surface as unknown as ShimNode).focus();
    const surfaceShift = keydown({ key: "Tab", shiftKey: true });
    dispatchDocKey(surfaceShift);
    h.ok("Shift-Tab from the surface is intercepted", surfaceShift.defaultPrevented === true);
    h.eq(activeElement(), last as unknown as ShimNode, "Shift-Tab from the surface wraps to the last control");
    dialog.closeAllOverlays();
  }
  {
    // Tab when the surface has NO focusable controls: the trap holds focus on the surface itself
    // (preventDefault + surface.focus()) rather than letting focus escape to the inert background.
    const { surface } = dialog.dialogSurface({ variant: "modal", title: "Empty", body: hEl("p", "no controls"), closeButton: false });
    dialog.openOverlay({ surface, variant: "modal", initialFocus: surface });
    await flushAsync();
    const emptyTab = keydown({ key: "Tab" });
    dispatchDocKey(emptyTab);
    h.ok("Tab with no focusables is intercepted", emptyTab.defaultPrevented === true);
    h.eq(activeElement(), surface as unknown as ShimNode, "Tab with no focusables holds focus on the surface");
    dialog.closeAllOverlays();
  }
  {
    // A key the handler ignores (not Esc, not Tab) passes straight through, and a keydown with no
    // overlay open is a no-op (the early return when the stack is empty).
    const passThrough = keydown({ key: "a" });
    dispatchDocKey(passThrough);
    h.ok("a non-Esc non-Tab key is ignored by the overlay handler", passThrough.defaultPrevented === false);

    const { surface } = dialog.dialogSurface({ variant: "modal", title: "Other", body: hEl("p", "x"), closeButton: false });
    dialog.openOverlay({ surface, variant: "modal" });
    await flushAsync();
    const otherKey = keydown({ key: "Enter" });
    dispatchDocKey(otherKey);
    h.ok("Enter is left to the focused control, not swallowed by the overlay", otherKey.defaultPrevented === false && document.querySelector(".overlay") !== null);
    dialog.closeAllOverlays();
  }
  {
    // teardown of the TOP of a nested stack (via the returned handle, not closeAllOverlays):
    // closing the upper overlay must clear the inert flag the lower surface picked up, so the
    // lower dialog becomes interactive again. This is the stack.length>0 branch in teardown.
    const { surface: lower } = dialog.dialogSurface({ variant: "modal", title: "Lower", body: hEl("p", "1"), closeButton: false });
    dialog.openOverlay({ surface: lower, variant: "modal" });
    const { surface: upper } = dialog.dialogSurface({ variant: "modal", title: "Upper", body: hEl("p", "2"), closeButton: false });
    const upperHandle = dialog.openOverlay({ surface: upper, variant: "modal" });
    await flushAsync();
    h.eq(attr(lower, "inert"), "", "the lower surface is inerted while the upper is open");
    upperHandle.close();
    h.eq(qsa(document.body, ".overlay").length, 1, "closing the top leaves the lower overlay mounted");
    h.eq(attr(lower, "inert"), null, "closing the top clears the lower surface's inert flag");
    dialog.closeAllOverlays();
  }
  {
    // setBackgroundInert falls back to .shell when there is no #app. Temporarily swap the #app
    // root for a .shell so the fallback selector resolves, then restore #app for the later blocks.
    const appRoot = document.getElementById("app");
    appRoot?.remove();
    const shell = hEl("div", { class: "shell" });
    document.body.appendChild(shell);
    const { surface } = dialog.dialogSurface({ variant: "modal", title: "Shell", body: hEl("p", "x"), closeButton: false });
    dialog.openOverlay({ surface, variant: "modal" });
    await flushAsync();
    h.eq(attr(shell, "inert"), "", "with no #app the .shell becomes the inert background");
    dialog.closeAllOverlays();
    h.eq(attr(shell, "inert"), null, "the .shell inert flag clears on close");
    shell.remove();
    // Restore the #app root that earlier blocks created so anything after sees the same shape.
    if (appRoot) document.body.appendChild(appRoot);
  }
  {
    // openOverlay's KEY guard: app.ts's identity-resolved quiet
    // re-render repaints the current screen via a fresh screen.render() -> a fresh load() -- a
    // path that runs OUTSIDE the router, so installAfterEach's closeAllOverlays never fires for
    // it. A route-driven "open the deep-linked drawer" side effect then re-fires while the first
    // drawer is still mounted. A caller that names a `key` gets an idempotent open: a second call
    // with the SAME key, while the first is still open, is a no-op that hands back the EXISTING
    // overlay's handle instead of stacking a duplicate, visually-covering surface on top of it.
    const { surface: firstSurface } = dialog.dialogSurface({ variant: "drawer", title: "Downpipe A", body: hEl("p", "first open") });
    let firstClosed = 0;
    const firstHandle = dialog.openOverlay({ surface: firstSurface, variant: "drawer", key: "dp-detail:A", onClose: () => { firstClosed++; } });
    await flushAsync();
    h.eq(qsa(document.body, ".overlay--drawer").length, 1, "keyed open: one drawer mounted");

    // The SAME key, opened again (the re-render's second load() calling openDetail a second
    // time), builds a second surface but must NOT stack it.
    const { surface: secondSurface } = dialog.dialogSurface({ variant: "drawer", title: "Downpipe A", body: hEl("p", "second open (stale duplicate)") });
    const secondHandle = dialog.openOverlay({ surface: secondSurface, variant: "drawer", key: "dp-detail:A" });
    await flushAsync();
    h.eq(qsa(document.body, ".overlay--drawer").length, 1, "a duplicate keyed open does NOT stack a second drawer");
    h.ok("the mounted drawer is still the FIRST surface, never the stale duplicate", document.body.contains(firstSurface as unknown as Node) && !document.body.contains(secondSurface as unknown as Node));
    const mounted1 = textOf(qs(document.body, ".overlay--drawer"));
    h.ok("the original content is preserved, not replaced by the duplicate", mounted1.includes("first open") && !mounted1.includes("second open"));

    // The handle returned by the deduped (second) call is wired to the SAME real entry: closing
    // it tears down the one mounted drawer (it is not an inert stub returning a fake success).
    secondHandle.close();
    h.eq(qsa(document.body, ".overlay--drawer").length, 0, "closing the deduped handle closes the real (shared) overlay");
    h.eq(firstClosed, 1, "the original onClose fires exactly once (dedup never registered a second onClose)");
    firstHandle.close();
    h.eq(firstClosed, 1, "closing the already-torn-down first handle is a safe no-op (idempotent teardown)");
  }
  {
    // A DIFFERENT key is never deduped: this is a per-entity guard, never a blanket
    // one-overlay-at-a-time rule (which would also wrongly block two distinct entities).
    const { surface: aSurface } = dialog.dialogSurface({ variant: "drawer", title: "Downpipe A", body: hEl("p", "a") });
    dialog.openOverlay({ surface: aSurface, variant: "drawer", key: "dp-detail:A" });
    const { surface: bSurface } = dialog.dialogSurface({ variant: "drawer", title: "Downpipe B", body: hEl("p", "b") });
    dialog.openOverlay({ surface: bSurface, variant: "drawer", key: "dp-detail:B" });
    await flushAsync();
    h.eq(qsa(document.body, ".overlay--drawer").length, 2, "a different key is NOT deduped: two distinct drawers stack");
    dialog.closeAllOverlays();
  }
  {
    // An UNKEYED confirm raised over a keyed drawer still stacks normally (the confirm-over-drawer
    // case this guard must never break): a confirm never sets a key, so it can never collide.
    const { surface: drawerSurface } = dialog.dialogSurface({ variant: "drawer", title: "Downpipe A", body: hEl("p", "drawer") });
    dialog.openOverlay({ surface: drawerSurface, variant: "drawer", key: "dp-detail:A" });
    const { surface: confirmSurface } = dialog.dialogSurface({ variant: "modal", title: "Delete?", body: hEl("p", "confirm") });
    dialog.openOverlay({ surface: confirmSurface, variant: "modal" }); // no key: an ordinary confirm
    await flushAsync();
    h.eq(qsa(document.body, ".overlay").length, 2, "an unkeyed confirm still stacks over a keyed drawer");
    h.eq(attr(drawerSurface, "inert"), "", "the keyed drawer is inerted under the confirm, same as any nested overlay");
    dialog.closeAllOverlays();

    // Once the drawer has genuinely closed, its key is free again: a later legitimate reopen (a
    // fresh user click, not a stale re-render) mounts normally rather than being blocked forever.
    const { surface: reopenSurface } = dialog.dialogSurface({ variant: "drawer", title: "Downpipe A", body: hEl("p", "reopen") });
    dialog.openOverlay({ surface: reopenSurface, variant: "drawer", key: "dp-detail:A" });
    await flushAsync();
    h.eq(qsa(document.body, ".overlay--drawer").length, 1, "the same key can be reopened once the earlier drawer has actually closed");
    dialog.closeAllOverlays();
  }

  // =========================================================================
  // 5. components/drawer.ts -- openDrawer + drawerSection
  // =========================================================================
  console.log("\n-- drawer --");
  {
    // On a holder: a `let` written only from inside a callback keeps the narrowing from its
    // initialiser, because the compiler cannot see the callback run, so these reads would be
    // comparisons against a type the value can never hold and would prove nothing.
    const rec = { closed: false };
    const handle = openDrawer({
      title: "A downpipe",
      body: drawerSection("Config", hEl("p", "details")),
      footer: hEl("button", { type: "button" }, "Run now"),
      onClose: () => { rec.closed = true; },
    });
    await flushAsync();
    const surface = qs(document.body, ".dialog--drawer")!;
    h.eq(attr(surface, "role"), "dialog", "drawer surface is a dialog");
    h.eq(textOf(qs(surface, ".dialog__title")), "A downpipe", "drawer title rendered");
    const section = qs(surface, ".drawer-section")!;
    h.eq(textOf(qs(section, ".drawer-section__title")), "Config", "drawerSection renders an h3 title");
    h.ok("drawerSection title is an h3 (outline under the dialog h2)", SN(qs(section, ".drawer-section__title")).tagName === "H3");
    // Close via the header X invokes handle.close which fires onClose.
    click(qs(surface, ".dialog__close"));
    h.ok("drawer close X dismisses and fires onClose", rec.closed === true && document.querySelector(".overlay") === null);
    handle.close();
  }

  // =========================================================================
  // 6. components/detail-drawer.ts -- subhead, footer grouping, kvRow
  // =========================================================================
  // The drawer has NO tabset. It shipped one and no caller ever passed
  // `tabs`; it was removed (see the component's own header for the
  // reasoning). The tab assertions that used to live here went with it, and the
  // no-tablist assertion below took their place: it fails if a tabset is reintroduced
  // without a caller, which is the state this deletion was closing.
  console.log("\n-- detail-drawer --");
  {
    // On a holder: a `let` written only from inside a callback keeps the narrowing from its
    // initialiser, because the compiler cannot see the callback run, so these reads would be
    // comparisons against a type the value can never hold and would prove nothing.
    const rec = { runClicked: false, deleteClicked: false };
    const handle = detailDrawer.openDetailDrawer({
      title: "KV_uploads",
      key: "test-detail:rich",
      meta: "KV - daily",
      badges: [hEl("span", { class: "badge" }, "enabled")],
      body: hEl("p", "overview panel"),
      actions: [
        { label: "Run now", variant: "primary", onClick: () => { rec.runClicked = true; } },
        { label: "Edit", onClick: () => {} },
        { label: "Delete", variant: "danger", onClick: () => { rec.deleteClicked = true; } },
        { label: "Restore", variant: "secondary", onClick: () => {}, disabled: true, disabledReason: "Needs approval" },
      ],
    });
    await flushAsync();
    const surface = qs(document.body, ".dialog--drawer")!;

    // Subhead: badges + meta.
    h.eq(textOf(qs(surface, ".detail-drawer__meta")), "KV - daily", "meta line rendered");
    h.ok("badge rendered in the subhead", qs(surface, ".detail-drawer__badges .badge") !== null);

    // No tablist, in either the rich or the plain form: the drawer builds one body node and
    // nothing else. A reintroduced tabset with no call site turns this red.
    h.eq(qsa(surface, "[role=tab]").length, 0, "the drawer builds no tabs");
    h.ok("the drawer builds no tablist", qs(surface, "[role=tablist]") === null);
    h.ok("the drawer builds no tabpanel", qs(surface, "[role=tabpanel]") === null);
    h.ok("the body node is mounted directly under the content root", (textOf(qs(surface, ".detail-drawer__content")) ?? "").includes("overview panel"));

    // Footer: routine actions left, danger grouped right; disabled action carries the reason
    // and has NO click handler.
    const footerBtns = qsa(qs(surface, ".drawer-actions"), "button");
    h.ok("Run now and Edit and Restore and Delete all rendered", footerBtns.length === 4);
    const dangerGroup = qs(surface, ".drawer-actions__danger")!;
    h.ok("the danger action sits in the danger group", findButtonByText(dangerGroup, "Delete") !== undefined);
    h.ok("a routine action is NOT in the danger group", findButtonByText(dangerGroup, "Run now") === undefined);
    click(findButtonByText(surface, "Run now"));
    h.ok("primary action click fires its handler", rec.runClicked === true);
    click(findButtonByText(dangerGroup, "Delete"));
    h.ok("danger action click fires its handler", rec.deleteClicked === true);
    // Disabled-with-reason, focusable: aria-disabled keeps
    // the control discoverable in the tab order; the reason is announced via a
    // visually-hidden description, never a hover-only title.
    const restoreBtn = findButtonByText(surface, "Restore")!;
    h.eq(restoreBtn.getAttribute("aria-disabled"), "true", "disabled action is aria-disabled (focusable)");
    h.ok("disabled action does NOT use the disabled attribute (stays focusable)", restoreBtn.getAttribute("disabled") === null);
    h.ok("disabled action announces the reason inline", (restoreBtn.textContent ?? "").includes("Needs approval"));
    // THE RULE IS "NOT HOVER-ONLY", AND THIS NOW TESTS THE RULE RATHER THAN AN INCIDENTAL. It used to
    // assert `title === null`, which was true only because this component carried its own copy of the
    // refusal idiom. That copy is gone: the drawer action goes through the shared refuseWithReason
    // (lib/dom.ts), which is what fixed this button announcing "Delete downpipe : <reason>" with the
    // separator read aloud, and which sets the title deliberately for a mouse user. The title was never
    // the thing forbidden. lib/dom.ts states the position in its own words and
    // forbids a tooltip being the ONLY place essential information lives, not tooltips; the ~40 controls
    // already refused through that helper have all carried one.
    //
    // So the assertion is now the property that matters: the reason reaches a keyboard and touch user
    // WITHOUT hover, as real DOM text and as the control's accessible description: this button computes
    // name "Delete downpipe" with description "<the reason>".
    h.ok("the refusal reason does not depend on hover: it is real text on the control", (restoreBtn.textContent ?? "").includes("Needs approval"));
    const describedBy = restoreBtn.getAttribute("aria-describedby");
    h.ok("the refusal reason is wired as the control's description", describedBy !== null && describedBy.trim() !== "");
    const reasonEl = describedBy === null ? null : surface.querySelector(`#${describedBy.trim().split(" ").pop()}`);
    h.ok("and that description resolves to the reason", (reasonEl?.textContent ?? "").includes("Needs approval"));

    handle.close();
  }
  {
    // A second body form + kvRow text-safety (a server string is text, not markup).
    const handle = detailDrawer.openDetailDrawer({
      title: "Run RUN-1",
      key: "test-detail:single-body",
      body: hEl("div", detailDrawer.kvRow("Binding", "KV_uploads"), detailDrawer.kvRow("Verified", 12304)),
    });
    await flushAsync();
    const surface = qs(document.body, ".dialog--drawer")!;
    h.ok("the drawer has no tablist", qs(surface, "[role=tablist]") === null);
    const rows = qsa(surface, ".kv-row");
    h.eq(rows.length, 2, "two kv rows");
    h.eq(textOf(qs(rows[0], ".kv-row__label")), "Binding", "kvRow label rendered");
    h.eq(textOf(qs(rows[0], ".kv-row__value")), "KV_uploads", "kvRow string value rendered as text");
    // An injection-shaped value is escaped to text (no element is parsed).
    const inj = detailDrawer.kvRow("Note", "<img src=x onerror=alert(1)>");
    h.eq(qsa(inj, "img").length, 0, "kvRow never parses a server string as markup (no img element)");
    h.eq(textOf(qs(inj, ".kv-row__value")), "<img src=x onerror=alert(1)>", "the raw string is preserved as literal text");
    handle.close();
  }
  {
    // openDetailDrawer's `key` end to end: reproduces the real production shape, not just the raw
    // openOverlay primitive. sources-downpipes.ts's load() calls openDetail (which calls
    // openDetailDrawer with key: `downpipes-detail:${dp.id}`) once on the deep-linked first render,
    // then AGAIN when app.ts's identity-resolved quiet re-render repaints the screen (a second,
    // independent load() that still matches the same /downpipes/:id route). The second call must
    // not stack a second drawer over the first, which would cover the Edit button.
    const firstOpen = detailDrawer.openDetailDrawer({
      title: "KV_uploads",
      body: hEl("p", "first render's drawer"),
      key: "downpipes-detail:dp-1",
    });
    await flushAsync();
    h.eq(qsa(document.body, ".dialog--drawer").length, 1, "deep-link open: one detail drawer mounted");

    // The identity-boot re-render's fresh load() calls openDetail again for the SAME id.
    const secondOpen = detailDrawer.openDetailDrawer({
      title: "KV_uploads",
      body: hEl("p", "re-render's duplicate drawer"),
      key: "downpipes-detail:dp-1",
    });
    await flushAsync();
    h.eq(qsa(document.body, ".dialog--drawer").length, 1, "the re-render's second openDetail does NOT stack a duplicate drawer");
    const mountedText = textOf(qs(document.body, ".overlay--drawer"));
    h.ok("the first render's drawer stays visible, never covered by the re-render's duplicate", mountedText.includes("first render's drawer") && !mountedText.includes("re-render's duplicate"));

    secondOpen.close();
    h.eq(qsa(document.body, ".dialog--drawer").length, 0, "the deduped (second) handle still closes the one real drawer");
    firstOpen.close();
  }
  {
    // A DIFFERENT downpipe id is a different key: two distinct entities' drawers both open (the
    // guard is per-downpipe, never "only one detail drawer ever").
    const dpA = detailDrawer.openDetailDrawer({ title: "KV_uploads", body: hEl("p", "a"), key: "downpipes-detail:dp-1" });
    const dpB = detailDrawer.openDetailDrawer({ title: "R2_media", body: hEl("p", "b"), key: "downpipes-detail:dp-2" });
    await flushAsync();
    h.eq(qsa(document.body, ".dialog--drawer").length, 2, "two distinct downpipe ids both open (no cross-entity dedup)");
    dpA.close();
    dpB.close();
  }
  {
    // A legitimate CONFIRM raised over the keyed detail drawer (e.g. the footer's Delete action)
    // still stacks normally: the confirm carries no key, so it never collides with the drawer's.
    detailDrawer.openDetailDrawer({ title: "KV_uploads", body: hEl("p", "drawer body"), key: "downpipes-detail:dp-1" });
    const { surface: confirmSurface } = dialog.dialogSurface({ variant: "modal", title: "Delete this downpipe?", body: hEl("p", "confirm body") });
    dialog.openOverlay({ surface: confirmSurface, variant: "modal" });
    await flushAsync();
    h.eq(qsa(document.body, ".overlay").length, 2, "a confirm dialog still stacks over the keyed detail drawer");
    dialog.closeAllOverlays();
  }
}
