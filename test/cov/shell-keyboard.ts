// Coverage validator for the shell's keyboard and focus layer (src/shell/keyboard.ts): the roving
// tabindex over the rail (arrows / Home / End move the single tab stop), the Compact slide-over rail
// (open with a minimal focus trap, close with focus restore), and the global key layer ("/" opens the
// palette, "g <letter>" go-to chords, with the typing-target / modifier / single-key-off guards).
//
// The app-shell validator drives a couple of these paths through the public Shell, but it never reaches
// the Compact slide-over branch (matchMedia must report a Compact width), the focus trap (Escape / the
// Tab wrap at both ends), releaseTrap / getFocusable, closeRail's open-to-default body, nor the roving
// rail's arrow handler. This file calls the exported wiring DIRECTLY against hand-built DOM so each
// branch runs end to end and asserts a real outcome (focus moved, a route opened, an attribute flipped).
//
// It renders the real production code under the shared DOM shim (test/dom-shim.ts), exactly as the rail
// and app-shell validators do, and never edits that shared shim. Run with `node test/cov/shell-keyboard.ts`
// (the cov runner also invokes it).

import { installDomShim } from "../dom-shim.ts";

installDomShim();

const g = globalThis as unknown as Record<string, unknown>;

// keyboard.ts guards on `target instanceof HTMLElement`. The shim has a single element class (Node);
// alias HTMLElement to it for this process so the guard resolves as a browser would (a shim element is
// an HTMLElement; null is not). The shared shim file is untouched.
{
  const NodeCtor = (g as { Node: unknown }).Node;
  if (!("HTMLElement" in g)) g.HTMLElement = NodeCtor;
}

// setA11yPref -> applyA11yPrefs calls root.style.removeProperty when the text size is 100 (the default).
// The shared shim's style models setProperty / getPropertyValue but not removeProperty; add the standard
// semantics to the style prototype for this process only (delete the recorded property), so the real
// a11y-prefs path runs. The shared shim file is untouched.
{
  type StyleProto = Record<string, unknown> & { removeProperty?: (p: string) => void };
  const styleProto = Object.getPrototypeOf(
    (g.document as { documentElement: { style: unknown } }).documentElement.style,
  ) as StyleProto;
  if (typeof styleProto.removeProperty !== "function") {
    styleProto.removeProperty = function (this: Record<string, unknown>, prop: string): void {
      delete this[prop];
    };
  }
}

import {
  wireRovingRail,
  wireRailToggle,
  closeRail,
  wireGlobalKeys,
} from "../../src/shell/keyboard.ts";
import { goToShortcuts } from "../../src/shell/registry.ts";
import { setA11yPref } from "../../src/lib/a11y-prefs.ts";
import type { ShellInternals } from "../../src/shell/types.ts";

const doc = g.document as {
  createElement(tag: string): unknown;
  body: { appendChild(n: unknown): unknown; childNodes: unknown[] };
  activeElement: unknown;
};

let failures = 0;
function ok(name: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`);
  if (!cond) failures++;
}

// A narrow view onto a shimmed element, enough for the reads and the event wiring the test does.
type El = {
  tagName: string;
  isContentEditable: boolean;
  getAttribute(k: string): string | null;
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
  appendChild(n: El): El;
  remove(): void;
  focus(): void;
  click(): void;
  querySelector(sel: string): El | null;
  dispatchEvent(ev: KeyEvent): boolean;
  dataset: Record<string, string | undefined>;
  // The shim's layout flag: false makes offsetParent null, so getFocusable's visibility filter drops
  // the control unless it is the active element. The test sets this to reach both filter branches.
  visible_: boolean;
};

function el(tag: string): El {
  return doc.createElement(tag) as unknown as El;
}

// activeEl reads the shim's focus pointer so a test can assert focus actually moved.
function activeEl(): El {
  return doc.activeElement as unknown as El;
}

// A keydown event the handlers read: keydown.ts consults key + the modifier flags + defaultPrevented +
// target. The shim never sets target on a synthetic event, so the test sets every field it needs.
interface KeyEvent {
  type: string;
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
  target: unknown;
  bubbles: boolean;
  currentTarget: unknown;
  preventDefault(): void;
  stopPropagation(): void;
}
function keyEvent(over: Partial<KeyEvent> & { key: string }): KeyEvent {
  return {
    type: "keydown",
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    defaultPrevented: false,
    target: null,
    bubbles: true,
    currentTarget: null,
    preventDefault(): void {
      this.defaultPrevented = true;
    },
    stopPropagation(): void {},
    // `key` is not listed above because `over` carries it (the parameter type requires one) and this
    // spread overwrites an earlier copy anyway. Writing both said the base object had a key of its
    // own, which it never did.
    ...over,
  };
}

// dispatchDocKey fires a key at the document-level keydown listeners (the global layer and the focus
// trap install there). The shim records document listeners and fires every one on dispatchKey.
const dispatchDocKey = (g.document as { dispatchKey(ev: unknown): void }).dispatchKey;

// Single-key shortcuts must be ON for the global layer to act (WCAG 2.1.4 lets the operator turn them
// off). The default is "on", but set it explicitly so this file is order-independent of other cov runs.
setA11yPref("singleKeyShortcuts", "on");

// ---- wireRovingRail: one tab stop, arrows / Home / End move it -------------------------------------
console.log("-- wireRovingRail keeps a single tab stop and moves it with the arrow keys --");
{
  const nav = el("nav");
  const links = new Map<string, El>();
  const order = ["/", "/downpipes", "/runs"];
  for (const route of order) {
    const a = el("a");
    a.setAttribute("href", route);
    nav.appendChild(a);
    links.set(route, a);
  }
  wireRovingRail(nav as unknown as HTMLElement, links as unknown as Map<string, HTMLAnchorElement>);
  ok("only the first link is the tab stop after wiring (the rest are -1)",
    links.get("/")!.getAttribute("tabindex") === "0"
    && links.get("/downpipes")!.getAttribute("tabindex") === "-1"
    && links.get("/runs")!.getAttribute("tabindex") === "-1");

  // With no rail link focused the handler returns early (idx < 0) and changes nothing.
  doc.body.appendChild(el("div")); // ensure activeElement is something outside the rail
  (doc as { activeElement: unknown }).activeElement = el("section");
  nav.dispatchEvent(keyEvent({ key: "ArrowDown" }));
  ok("a key with no rail link focused is ignored (no tab stop moved)",
    links.get("/")!.getAttribute("tabindex") === "0");

  // Focus the first link, then ArrowDown moves the single tab stop forward and focuses it.
  links.get("/")!.focus();
  nav.dispatchEvent(keyEvent({ key: "ArrowDown" }));
  ok("ArrowDown moves the tab stop to the next link and focuses it",
    links.get("/")!.getAttribute("tabindex") === "-1"
    && links.get("/downpipes")!.getAttribute("tabindex") === "0"
    && activeEl() === links.get("/downpipes"));

  // ArrowUp moves it back.
  nav.dispatchEvent(keyEvent({ key: "ArrowUp" }));
  ok("ArrowUp moves the tab stop back one and focuses it",
    links.get("/")!.getAttribute("tabindex") === "0" && activeEl() === links.get("/"));

  // ArrowUp from the first link wraps to the last (the (idx - 1 + len) % len arm).
  nav.dispatchEvent(keyEvent({ key: "ArrowUp" }));
  ok("ArrowUp from the first link wraps to the last", activeEl() === links.get("/runs"));

  // ArrowDown from the last link wraps to the first (the (idx + 1) % len arm).
  nav.dispatchEvent(keyEvent({ key: "ArrowDown" }));
  ok("ArrowDown from the last link wraps to the first", activeEl() === links.get("/"));

  // End jumps to the last, Home back to the first.
  nav.dispatchEvent(keyEvent({ key: "End" }));
  ok("End jumps the tab stop to the last link", activeEl() === links.get("/runs"));
  nav.dispatchEvent(keyEvent({ key: "Home" }));
  ok("Home jumps the tab stop back to the first link", activeEl() === links.get("/"));

  // An unhandled key (with a rail link focused) hits the final `else return` and moves nothing.
  links.get("/downpipes")!.focus();
  links.get("/downpipes")!.setAttribute("tabindex", "0");
  const ev = keyEvent({ key: "x" });
  nav.dispatchEvent(ev);
  ok("an unhandled key leaves the tab stop untouched and is not prevented",
    activeEl() === links.get("/downpipes") && ev.defaultPrevented === false);
}

// ---- wireRailToggle / openRail / closeRail: the Compact slide-over with a focus trap ---------------
//
// makeShell builds the minimal ShellInternals the rail toggle reads: the shell element (carries the
// data-rail state), the toggle button, the nav (holds .nav-item links), and a .rail container with a
// couple of focusable controls for the trap to cycle. The rest are inert placeholders.
function makeShell(): { internals: ShellInternals; shellEl: El; toggle: El; firstNav: El; lastBtn: El } {
  const shellEl = el("div");
  const toggle = el("button");
  const nav = el("nav");
  const rail = el("div");
  rail.setAttribute("class", "rail");
  shellEl.appendChild(rail);
  rail.appendChild(nav);
  // Two focusable controls inside the rail: the first nav link and a trailing button, so the trap has a
  // first and a last to wrap between.
  const firstNav = el("a");
  firstNav.setAttribute("class", "nav-item");
  firstNav.setAttribute("href", "/");
  nav.appendChild(firstNav);
  const lastBtn = el("button");
  rail.appendChild(lastBtn);
  // Connect the tree to the document so getFocusable's offsetParent visibility check passes.
  doc.body.appendChild(shellEl);

  const placeholder = el("div") as unknown as HTMLElement;
  const internals: ShellInternals = {
    navLinks: new Map(),
    mainRegion: placeholder,
    engineChip: placeholder,
    accountSlot: placeholder,
    shellEl: shellEl as unknown as HTMLElement,
    railToggle: toggle as unknown as HTMLButtonElement,
    navEl: nav as unknown as HTMLElement,
    railFooter: placeholder,
    scrim: placeholder,
    caller: null,
    showAll: false,
    activePattern: "",
    navigateFn: () => {},
    setup: null,
    setupStrip: placeholder,
    navCounts: new Map(),
  };
  return { internals, shellEl, toggle, firstNav, lastBtn };
}

console.log("-- wireRailToggle at a Compact width opens a slide-over, traps focus, and restores it --");
{
  // Force matchMedia to report the Compact breakpoint so openRail takes the slide-over branch (it is the
  // only path that focuses the first link and installs the trap). Restored at the end of the block.
  const savedMatchMedia = g.matchMedia;
  g.matchMedia = (query: string) => ({
    media: query,
    matches: query.includes("max-width: 767px"),
    addEventListener(): void {},
    removeEventListener(): void {},
    addListener(): void {},
    removeListener(): void {},
  });

  const { internals, shellEl, toggle, firstNav, lastBtn } = makeShell();
  wireRailToggle(internals);

  // A control outside the rail holds focus before opening, so closing can restore to it.
  const outside = el("button");
  doc.body.appendChild(outside);
  outside.focus();

  // First toggle click opens the slide-over: rail = open, aria flips, the first nav link takes focus.
  toggle.click();
  ok("clicking the toggle at Compact opens the slide-over rail", shellEl.dataset.rail === "open");
  ok("the open toggle is marked expanded with a Close label",
    toggle.getAttribute("aria-expanded") === "true" && toggle.getAttribute("aria-label") === "Close navigation");
  ok("opening focuses the first nav link", activeEl() === firstNav);

  // The focus trap is live on the document. Tab while the LAST focusable is active wraps to the first.
  lastBtn.focus();
  dispatchDocKey(keyEvent({ key: "Tab", target: lastBtn }));
  ok("Tab from the last focusable wraps to the first (forward trap)", activeEl() === firstNav);

  // Shift+Tab while the FIRST focusable is active wraps to the last.
  firstNav.focus();
  dispatchDocKey(keyEvent({ key: "Tab", shiftKey: true, target: firstNav }));
  ok("Shift+Tab from the first focusable wraps to the last (backward trap)", activeEl() === lastBtn);

  // A Tab in the MIDDLE of the set (neither first nor last active) is left to the browser: the trap does
  // not move focus. Insert a control into document order between the first and last so it is a true
  // middle of getFocusable's set (appended to the nav, which precedes the trailing button in the rail).
  const middle = el("input");
  (shellEl.querySelector("nav") as El).appendChild(middle);
  middle.focus();
  const midEv = keyEvent({ key: "Tab", target: middle });
  dispatchDocKey(midEv);
  ok("a Tab in the middle of the set is not hijacked by the trap", activeEl() === middle && midEv.defaultPrevented === false);
  middle.remove();

  // A non-Tab, non-Escape key inside the trap is ignored (the `ev.key !== "Tab"` early return).
  const otherEv = keyEvent({ key: "a", target: firstNav });
  dispatchDocKey(otherEv);
  ok("a non-Tab, non-Escape key is ignored by the trap", otherEv.defaultPrevented === false);

  // Escape inside the trap closes the rail (onEsc -> closeRail): state returns to default, focus restores
  // to the control that was focused before opening, and the trap is released.
  const escEv = keyEvent({ key: "Escape", target: firstNav });
  dispatchDocKey(escEv);
  ok("Escape closes the slide-over and prevents the default", shellEl.dataset.rail === "default" && escEv.defaultPrevented === true);
  ok("closing restores focus to the pre-open control", activeEl() === outside);
  ok("the closed toggle is marked collapsed with an Open label",
    toggle.getAttribute("aria-expanded") === "false" && toggle.getAttribute("aria-label") === "Open navigation");

  // The trap was released on close: a further Tab at an endpoint no longer wraps.
  lastBtn.focus();
  dispatchDocKey(keyEvent({ key: "Tab", target: lastBtn }));
  ok("after close the trap is released (Tab no longer wraps)", activeEl() === lastBtn);

  // A second open then a toggle click CLOSES it again (the toggle's open-branch), exercising openRail ->
  // closeRail through the click path rather than Escape.
  outside.focus();
  toggle.click();
  ok("a second toggle click re-opens the slide-over", shellEl.dataset.rail === "open");
  toggle.click();
  ok("toggling an open slide-over closes it again", shellEl.dataset.rail === "default" && activeEl() === outside);

  g.matchMedia = savedMatchMedia;
}

console.log("-- wireRailToggle at a wide width toggles the collapsed icon-strip instead --");
{
  // matchMedia reports NOT Compact, so openRail takes the wide branch: the toggle flips the strip between
  // default and collapsed and never installs a trap.
  const savedMatchMedia = g.matchMedia;
  g.matchMedia = (query: string) => ({
    media: query,
    matches: false, // never Compact
    addEventListener(): void {},
    removeEventListener(): void {},
    addListener(): void {},
    removeListener(): void {},
  });

  const { internals, shellEl, toggle } = makeShell();
  wireRailToggle(internals);

  // From the default (no data-rail) the first click collapses the strip.
  toggle.click();
  ok("a wide-width toggle collapses the strip", shellEl.dataset.rail === "collapsed");
  ok("the collapsed strip marks the toggle not-expanded", toggle.getAttribute("aria-expanded") === "false");

  // A second click expands it back to default.
  toggle.click();
  ok("a second wide-width toggle expands the strip back to default", shellEl.dataset.rail === "default");
  ok("the expanded strip marks the toggle expanded", toggle.getAttribute("aria-expanded") === "true");

  g.matchMedia = savedMatchMedia;
}

console.log("-- closeRail is a no-op when the rail is not open --");
{
  const { internals, shellEl } = makeShell();
  // Not open: closeRail's guard returns immediately and leaves the state untouched.
  shellEl.dataset.rail = "collapsed";
  // A fresh trap state, which is what the production wiring threads in: it is created per
  // wireRailToggle call rather than held at module scope, so the one-trap-at-a-time constraint stays
  // explicit. This case asserts the guard returns before touching either field.
  closeRail(internals, { focusReturn: null, trapHandler: null });
  ok("closeRail leaves a non-open rail untouched", shellEl.dataset.rail === "collapsed");
}

console.log("-- the focus trap's getFocusable retains the active control even when it is not laid out --");
{
  // getFocusable keeps a control that is the active element even when its offsetParent is null (an
  // off-screen but focused control), and a Tab with NO focusables at all is left alone. Both are inside
  // the trap, so open a Compact slide-over and control the visibility of the rail's focusables.
  const savedMatchMedia = g.matchMedia;
  g.matchMedia = (query: string) => ({
    media: query,
    matches: query.includes("max-width: 767px"),
    addEventListener(): void {},
    removeEventListener(): void {},
    addListener(): void {},
    removeListener(): void {},
  });

  const { internals, toggle, firstNav, lastBtn } = makeShell();
  wireRailToggle(internals);
  toggle.click(); // open the slide-over and install the trap

  // Make BOTH rail focusables not-laid-out, then focus the first one. getFocusable would drop both on
  // the offsetParent check, but the active one is retained by the `|| el === document.activeElement`
  // arm, leaving a single-element set whose first === last. A Tab from it wraps to itself (focus stays)
  // and the default is prevented, which only happens when the set is non-empty.
  firstNav.visible_ = false;
  lastBtn.visible_ = false;
  firstNav.focus();
  const wrapEv = keyEvent({ key: "Tab", target: firstNav });
  dispatchDocKey(wrapEv);
  ok("an off-screen but active control is still trapped (default prevented, focus retained)",
    activeEl() === firstNav && wrapEv.defaultPrevented === true);

  // Now move focus OFF every focusable (to a control outside the rail). getFocusable then returns an
  // empty set and the trap leaves the Tab to the browser (line: focusables.length === 0 return).
  const outside = el("button");
  doc.body.appendChild(outside);
  outside.focus();
  const emptyEv = keyEvent({ key: "Tab", target: outside });
  dispatchDocKey(emptyEv);
  ok("a Tab with no focusables in the trap is left to the browser (not prevented)",
    emptyEv.defaultPrevented === false);

  // Close so the trap is released before the global-key block (a lingering trap listener would also fire
  // on the / and g dispatches there). Escape closes via onEsc -> closeRail.
  firstNav.visible_ = true;
  dispatchDocKey(keyEvent({ key: "Escape", target: outside }));

  g.matchMedia = savedMatchMedia;
}

// ---- wireGlobalKeys: the "/" palette open, the "g <letter>" go-to chords, and the guards -----------
//
// All the global-key assertions share ONE wireGlobalKeys registration. The shim fires every registered
// document keydown listener on a dispatch, and the first listener to call preventDefault() flips the
// shared event's defaultPrevented so a second registration would see the key already claimed; a single
// registration keeps each dispatch reasoning about exactly one handler. The counters are shared, so the
// assertions check deltas. The chord timer is captured (window === globalThis) so the 1200ms reset is
// driven by hand and no real timer is left holding the process open.
console.log("-- wireGlobalKeys opens the palette on /, routes on the g-chords, and honours the guards --");
{
  let paletteOpens = 0;
  const navigated: string[] = [];
  const savedSetTimeout = g.setTimeout;
  const savedClearTimeout = g.clearTimeout;
  let pendingCb: (() => void) | null = null;
  let timerId = 0;
  g.setTimeout = (cb: () => void): number => {
    pendingCb = cb;
    return ++timerId;
  };
  g.clearTimeout = (): void => {
    pendingCb = null;
  };

  setA11yPref("singleKeyShortcuts", "on");
  wireGlobalKeys(() => { paletteOpens++; }, (route) => { navigated.push(route); });

  // A handler that already claimed the key (defaultPrevented) is never re-handled by the global layer.
  const claimed = keyEvent({ key: "/", defaultPrevented: true });
  dispatchDocKey(claimed);
  ok("the global layer never re-handles an already-claimed key", paletteOpens === 0);

  // A modifier-bearing key is ignored (Cmd/Ctrl-K opens the palette through its own binding, not here).
  dispatchDocKey(keyEvent({ key: "/", metaKey: true }));
  ok("the layer ignores a / with a modifier held", paletteOpens === 0);

  // "/" with no field, no modifier opens the palette and prevents the default.
  const slash = keyEvent({ key: "/" });
  dispatchDocKey(slash);
  ok("/ opens the palette and prevents the default", paletteOpens === 1 && slash.defaultPrevented === true);

  // "?" navigates to the command-palette landing (the shortcut cheat sheet) and prevents the
  // default. Shift is naturally held for "?"; it is not in the modifier guard, so this fires.
  const question = keyEvent({ key: "?", shiftKey: true });
  dispatchDocKey(question);
  ok("? routes to the /command-palette cheat sheet and prevents the default",
    navigated[navigated.length - 1] === "/command-palette" && question.defaultPrevented === true && paletteOpens === 1);

  // "g" then a matching letter navigates to the chord's route. Pick a real chord from the registry so
  // the test tracks the source of truth rather than a hard-coded route.
  const chords = goToShortcuts();
  const overview = chords.find((c) => c.chord === "g o")!;
  ok("the registry exposes the g o go-to chord", overview !== undefined && overview.route === "/");
  const navsBeforeChord = navigated.length;
  dispatchDocKey(keyEvent({ key: "g" })); // arm the chord (sets pendingG, schedules the reset)
  ok("the first g of a chord opens no palette and routes nowhere yet", paletteOpens === 1 && navigated.length === navsBeforeChord);
  const second = keyEvent({ key: "o" });
  dispatchDocKey(second); // complete "g o"
  ok("g then o routes to the Overview chord target and prevents the default",
    navigated[navigated.length - 1] === overview.route && second.defaultPrevented === true);

  // "g" then an UNKNOWN letter consumes the pending-g but matches no chord, so it routes nowhere.
  const navsBeforeNoMatch = navigated.length;
  dispatchDocKey(keyEvent({ key: "g" }));
  const noMatch = keyEvent({ key: "z" });
  dispatchDocKey(noMatch);
  ok("g then an unmapped letter routes nowhere and is not prevented",
    navigated.length === navsBeforeNoMatch && noMatch.defaultPrevented === false);

  // The chord arms a 1200ms reset; firing it clears pendingG so a later lone letter is treated as a
  // normal key (not a chord completion). Drive the captured callback rather than waiting on a real timer.
  const navsBeforeLapse = navigated.length;
  dispatchDocKey(keyEvent({ key: "g" })); // arm again
  ok("arming the chord scheduled a reset timer", pendingCb !== null);
  pendingCb!(); // the 1200ms window elapses
  const lateO = keyEvent({ key: "o" });
  dispatchDocKey(lateO);
  ok("a letter after the chord window has lapsed is not treated as a chord completion",
    navigated.length === navsBeforeLapse && lateO.defaultPrevented === false);

  // ---- the typing-target guard: editable targets suppress the layer (isTypingTarget every branch) ----
  // isTypingTarget runs BEFORE the single-key check, so an editable target is suppressed regardless of
  // the setting. slashFrom returns whether the palette opened (the target was NOT a typing target).
  function slashFrom(target: unknown): boolean {
    const before = paletteOpens;
    dispatchDocKey(keyEvent({ key: "/", target }));
    return paletteOpens > before;
  }
  ok("a null target is not editable, so / still opens the palette", slashFrom(null) === true);
  ok("a / inside an INPUT is suppressed", slashFrom(el("input")) === false);
  ok("a / inside a TEXTAREA is suppressed", slashFrom(el("textarea")) === false);
  ok("a / inside a SELECT is suppressed", slashFrom(el("select")) === false);
  const editable = el("div");
  (editable as { isContentEditable: boolean }).isContentEditable = true;
  ok("a / inside a contentEditable region is suppressed", slashFrom(editable) === false);
  ok("a / on a plain non-editable element opens the palette", slashFrom(el("div")) === true);

  // ---- the single-key-off accessibility setting (WCAG 2.1.4): the layer ignores / entirely ----
  const beforeOff = paletteOpens;
  setA11yPref("singleKeyShortcuts", "off");
  dispatchDocKey(keyEvent({ key: "/" }));
  ok("/ is ignored once single-key shortcuts are turned off", paletteOpens === beforeOff);
  // Restore the default so any later read in this process sees shortcuts on.
  setA11yPref("singleKeyShortcuts", "on");
  dispatchDocKey(keyEvent({ key: "/" }));
  ok("/ works again once single-key shortcuts are turned back on", paletteOpens === beforeOff + 1);

  g.setTimeout = savedSetTimeout;
  g.clearTimeout = savedClearTimeout;
}

if (failures > 0) process.exitCode = 1;

if (failures > 0) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("\nSHELL KEYBOARD COVERAGE VECTORS PASS");
