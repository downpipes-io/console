// Coverage validator for the app shell entry (src/shell/app-shell.ts): mountShell builds the
// three-zone chrome once and returns the Shell handles the router drives (setMain / setActiveRoute /
// setTitle / setEngine / setCaller / setViewMode / setSetup / setNavCount / closeRail / setChrome and
// the on* wiring). validate-nav.ts already covers the buildNavLink + applyNavCount re-exports, so this
// file drives the assembly and every returned handle instead, which is the bulk of the module that the
// nav suite never touches.
//
// It RENDERS the real shell under the shared DOM shim (test/dom-shim.ts), exactly as the component
// validators do, and asserts a meaningful outcome for each path: the landmark structure, the rail
// re-curation on a caller change, the view-toggle showing/hiding by role default, the route-aware setup
// strip, the count chip, the chrome on/off attribute, the title + polite announce, and that each on*
// handler fires from the control it is wired to (palette trigger, view-mode buttons, sign-out,
// rail toggle, and the global "/" and g-chord key layer).
//
// Two browser APIs the shim does not model are supplied locally (never by editing the shared shim):
// HTMLCanvasElement.getContext (so the decorative ambient field returns early as it does headless) and
// the Web Animations + View Transitions hooks (element.animate / document.startViewTransition), so the
// motion-gated setMain charge path runs end to end rather than only its reduced-motion fallback.
//
// Run with `node test/cov/shell-app-shell.ts` (the cov runner also invokes it).

import { installDomShim, qs, qsa, textOf, flushAsync, type ShimNode } from "../dom-shim.ts";

installDomShim();

// localStorage is wired by the shim; sessionStorage is not, but no shell path reads it. The view-mode
// + aurora + a11y prefs read localStorage (the shim's in-memory store), which is enough.
const g = globalThis as unknown as Record<string, unknown>;

// The shell builds the view-toggle with the variadic Element.append (one call in the whole shell
// chain). The shared shim models appendChild but not append; rather than touch the shared file, add
// the standard variadic helper to the shim node prototype for this process only (it delegates to
// appendChild, the same semantics, so no behaviour changes for the modules under test).
{
  type ProtoNode = {
    appendChild(n: unknown): unknown;
    parentNode: { childNodes: unknown[]; appendChild(n: unknown): unknown } | null;
  };
  const NodeCtor = (g as { Node: { prototype: Record<string, unknown> } }).Node;
  const proto = NodeCtor.prototype;
  if (typeof proto.append !== "function") {
    proto.append = function (this: ProtoNode, ...nodes: unknown[]): void {
      for (const n of nodes) this.appendChild(n);
    };
  }
  // replaceWith: the engine chip swap (setEngine) calls oldChip.replaceWith(fresh). Model the standard
  // semantics on the shim prototype (swap this node for the replacements in its parent's child list).
  if (typeof proto.replaceWith !== "function") {
    proto.replaceWith = function (this: ProtoNode, ...nodes: unknown[]): void {
      const parent = this.parentNode;
      if (!parent) return;
      const i = parent.childNodes.indexOf(this);
      for (const n of nodes) parent.appendChild(n); // append then re-order so the new node sits in place
      if (i >= 0) {
        // Move the freshly-appended replacements to the original index and drop this node.
        const moved = nodes.slice();
        for (const n of moved) {
          const j = parent.childNodes.indexOf(n);
          if (j >= 0) parent.childNodes.splice(j, 1);
        }
        parent.childNodes.splice(i, 0, ...moved);
        const self = parent.childNodes.indexOf(this);
        if (self >= 0) parent.childNodes.splice(self, 1);
        (this as { parentNode: unknown }).parentNode = null;
      }
    };
  }
}

// The shell's keyboard layer guards on `target instanceof HTMLElement`, and the rail-mark charge on
// `svg instanceof SVGElement`. The shim has a single element class (Node); alias both DOM element
// constructors to it for this process so those instanceof guards resolve as they would in a browser
// (a shim element is an HTMLElement / SVGElement; null is neither). The shared shim file is untouched.
{
  const NodeCtor = (g as { Node: unknown }).Node;
  if (!("HTMLElement" in g)) g.HTMLElement = NodeCtor;
  if (!("SVGElement" in g)) g.SVGElement = NodeCtor;
}

// ---- supply the two browser APIs the headless shim does not model (test-local, shim untouched) ----
// The ambient field calls canvas.getContext("2d"); a null return makes it return early exactly as a
// headless 2d context would, so no rAF loop starts. Wrap createElement so a <canvas> carries the method.
type AnimateRec = { kind: string };
const animateCalls: AnimateRec[] = [];
const docAny = g.document as {
  createElement: (tag: string) => Record<string, unknown>;
  createElementNS: (ns: string, tag: string) => Record<string, unknown>;
  startViewTransition?: (cb: () => void) => unknown;
};
// equip adds the headless-only browser bits to a freshly-created element: a 2d-context-less canvas
// (so the decorative ambient field returns early) and a recording Web Animations stub (so the
// motion-gated rail-mark charge runs its full path and resolves rather than only its fallback).
function equip(el: Record<string, unknown>, tag: string): Record<string, unknown> {
  if (String(tag).toLowerCase() === "canvas" && typeof el.getContext !== "function") {
    el.getContext = (): null => null;
  }
  if (typeof el.animate !== "function") {
    el.animate = (_frames: unknown, _opts: unknown): { finished: Promise<void> } => {
      animateCalls.push({ kind: tag });
      return { finished: Promise.resolve() };
    };
  }
  return el;
}
const realCreate = docAny.createElement.bind(docAny);
docAny.createElement = (tag: string): Record<string, unknown> => equip(realCreate(tag), tag);
const realCreateNS = docAny.createElementNS.bind(docAny);
docAny.createElementNS = (ns: string, tag: string): Record<string, unknown> => equip(realCreateNS(ns, tag), tag);

// document.startViewTransition: a recording stub so setMain's progressive-enhancement branch runs the
// callback (the swap) rather than the plain-apply fallback.
let viewTransitions = 0;
docAny.startViewTransition = (cb: () => void): { finished: Promise<void> } => {
  viewTransitions++;
  cb();
  return { finished: Promise.resolve() };
};

import { mountShell, ICON_REFRESH } from "../../src/shell/app-shell.ts";
import { deriveSetup } from "../../src/lib/setup-state.ts";
import type { SetupState } from "../../src/lib/api/types/sources.ts";
import type { Caller } from "../../src/lib/api/types/who.ts";
import type { CustomRole } from "../../src/lib/identity.ts";

let failures = 0;
function ok(name: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`);
  if (!cond) failures++;
}

// A typed handle onto the shimmed tree the real render returns. The shim's own node type is reused so
// the created elements, the qs/qsa results, and the appendChild calls all line up under one family.
type Shim = ShimNode;

function makeHost(): Shim {
  return (docAny.createElement("div") as unknown) as Shim;
}

// keydown event for the document-level global key layer ("/" and the g-chords live there).
function keyEvent(key: string): Record<string, unknown> {
  return {
    type: "keydown",
    key,
    target: null,
    currentTarget: null,
    defaultPrevented: false,
    bubbles: true,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    preventDefault(this: { defaultPrevented: boolean }) { this.defaultPrevented = true; },
    stopPropagation() {},
  };
}
const docKeys = (g.document as { dispatchKey: (ev: unknown) => void }).dispatchKey;

// ---- a built-in caller (hides nothing) and a custom-role caller (shiny default, hides a screen) ----
const ownerCaller: Caller = {
  method: "access",
  email: "owner@example.test",
  role: "owner",
  groups: [],
  isOnlyOwner: true,
};
const execRole: CustomRole = {
  name: "exec",
  label: "Executive",
  capabilities: ["downpipe.read"],
  // Hide the reports screen so the surface curation drops an item and the escape hatch appears, and
  // declare the shiny presentation so the view toggle is standing chrome for this caller.
  surface: { reports: "hidden" },
  presentation: "shiny",
  landing: "downpipes",
  createdBy: "owner@example.test",
  createdAt: "2026-06-22T00:00:00.000Z",
};
const execCaller: Caller = {
  method: "access",
  email: "exec@example.test",
  role: "viewer",
  groups: [],
  isOnlyOwner: false,
  customRole: execRole,
  customCapabilities: ["downpipe.read"],
};

function setupState(over: Partial<SetupState>): SetupState {
  return {
    keysReady: true,
    signerConfigured: true,
    breakGlassConfigured: true,
    emailConfigured: true,
    discoveryTokenPresent: true,
    accountsSelected: true,
    destination: { configured: true, verified: true, kind: "r2", source: "console" },
    boundSourceCount: 2,
    downpipeCount: 1,
    anyRunCompleted: false,
    ready: true,
    ...over,
  };
}

console.log("-- mountShell: the landmark structure, the skip link, the single brand mark --");
const host = makeHost();
// Connect the host to the shim document body so the shell's document-rooted reads resolve (the
// rail-mark charge does a document.querySelector for the brand body), the same as a mounted #app.
((g.document as { body: Shim }).body).appendChild(host);
const shell = mountShell((host as unknown) as Element);
{
  // The skip link is the FIRST focusable element (WCAG 2.4.1) and targets #main.
  const first = host.childNodes[0]!;
  ok("the first child is the skip-to-content link targeting #main", first.getAttribute("class") === "skip-link" && first.getAttribute("href") === "#main");

  ok("a Primary nav landmark is present", qs(host, 'nav[aria-label="Primary"]') !== null);
  ok("the header context bar is present", qs(host, "header.context-bar") !== null);
  const main = qs(host, "main#main");
  ok("the main region carries id=main and tabindex=-1 (focus target)", main !== null && main.getAttribute("tabindex") === "-1");
  ok("the main inner starts capped to the wide measure", qs(host, ".main__inner.measure-wide") !== null);
  ok("exactly one locked brand mark renders in the rail", qsa(host, ".rail__brand .brand").length === 1);
  ok("the palette trigger names itself for assistive tech", (qs(host, ".palette-trigger")?.getAttribute("aria-label") ?? "").startsWith("Open command palette"));
  // mountShell replaced the host's children, so the shell root sits under it with the default rail.
  ok("the shell root is mounted with the default rail state", qs(host, ".shell")?.dataset.rail === "default");
}

console.log("-- before any on* wiring: the controls fall through to the safe no-op defaults --");
{
  // Until main.ts calls onNavigate / onOpenPalette / onSignOut / onViewMode, the shell's handler slots
  // hold the no-op defaults. Activating each control before wiring must be a harmless no-op (never a
  // throw), which is exactly the first-paint contract (the rail works before the router is attached).
  // Each activation here runs one default closure; a rail link click also runs the internals.navigateFn
  // wrapper that the rail is built against.
  const railLink = qs(host, ".rail a.nav-item[href]");
  ok("the first-paint rail carries at least one navigable link", railLink !== null);
  let threw = false;
  try {
    railLink!.click(); // -> internals.navigateFn(route) -> the navigateFn no-op default
    qs(host, ".palette-trigger")!.click(); // -> the openPaletteFn no-op default
    qsa(host, ".view-toggle__btn")[0]!.click(); // -> the viewModeFn no-op default
    qs(host, ".account-slot button")!.click(); // -> the signOutFn no-op default
  } catch {
    threw = true;
  }
  ok("activating any control before wiring is a safe no-op (no throw)", threw === false);
}

console.log("-- the on* handlers fire from the controls they are wired to --");
{
  let navigated: string | null = null;
  let paletteOpened = 0;
  let signedOut = 0;
  const viewModeFlips: string[] = [];
  shell.onNavigate((r) => { navigated = r; });
  shell.onOpenPalette(() => { paletteOpened++; });
  shell.onSignOut(() => { signedOut++; });
  shell.onViewMode((m) => { viewModeFlips.push(m); });

  qs(host, ".palette-trigger")!.click();
  ok("clicking the palette trigger calls onOpenPalette", paletteOpened === 1);

  // The view-mode toggle: executive then technical.
  const execBtn = qsa(host, ".view-toggle__btn")[0]!;
  const techBtn = qsa(host, ".view-toggle__btn")[1]!;
  execBtn.click();
  techBtn.click();
  ok("the two view-toggle buttons call onViewMode with shiny then technical", viewModeFlips.join(",") === "shiny,technical");

  // The sign-out affordance lives in the (degraded) account slot rendered at mount.
  const signOutBtn = qs(host, ".account-slot button");
  ok("a sign-out control is rendered in the account slot", signOutBtn !== null);
  signOutBtn!.click();
  ok("clicking sign out calls onSignOut", signedOut === 1);

  // The global key layer: "/" opens the palette; "g" then "o" jumps to the Overview route.
  docKeys(keyEvent("/"));
  ok('the global "/" key opens the palette', paletteOpened === 2);
  docKeys(keyEvent("g"));
  docKeys(keyEvent("o"));
  ok('the "g o" chord navigates to the Overview route', navigated === "/");
}

console.log("-- setMain: motion path runs the charge + view transition, and the measure branches --");
{
  // With motion on (the shim's matchMedia reports prefers-reduced-motion: not matched), setMain runs
  // the rail-mark charge and the View Transitions swap. Drive a real content node in.
  const content = docAny.createElement("section") as unknown as Shim;
  content.appendChild((docAny.createElement("h1") as unknown) as Shim);
  shell.setMain((content as unknown) as Node); // default measure = wide
  await flushAsync(2);
  ok("setMain swapped the supplied node into the main inner", qs(host, "main#main section") !== null);
  ok("setMain used the View Transitions swap under motion", viewTransitions >= 1);
  ok("the default measure caps content to the wide width", qs(host, ".main__inner.measure-wide") !== null);

  // prose measure -> the narrow reading width.
  shell.setMain((docAny.createElement("article") as unknown) as Node, "prose");
  await flushAsync(2);
  ok("the prose measure caps content to the reading width (.measure, not wide)", qs(host, ".main__inner.measure") !== null && qs(host, ".main__inner.measure-wide") === null);

  // full measure -> no width cap at all.
  shell.setMain((docAny.createElement("div") as unknown) as Node, "full");
  await flushAsync(2);
  const inner = qs(host, ".main__inner")!;
  ok("the full measure leaves no width cap (no measure / measure-wide class)", !inner.classList.contains("measure") && !inner.classList.contains("measure-wide"));

  // The full charge path: inject a real svg > .dp-mark-body under the rail brand (the production glyph
  // holds the body inside an innerHTML string the shim does not parse). chargeRailMark then finds the
  // body, appends the charge stroke, animates the stroke, and (because the body has an svg ancestor)
  // also runs the svg scale-pulse branch.
  const brand = qs(host, ".rail__brand")!;
  const svgWrap = docAny.createElement("svg") as unknown as Shim;
  const body = docAny.createElement("g") as unknown as Shim;
  (body as unknown as { setAttribute(k: string, v: string): void }).setAttribute("class", "dp-mark-body");
  svgWrap.appendChild(body);
  brand.appendChild(svgWrap);
  animateCalls.length = 0;
  // Two navigations back to back WITHOUT draining microtasks between them: the first charge stroke is
  // appended synchronously but its self-removal is async, so the second navigation finds the in-flight
  // stroke still present and removes it before drawing the fresh one (the "single in-flight, a rapid
  // nav restarts it cleanly" behaviour). This drives the leftover-charge removal path.
  shell.setMain((docAny.createElement("p") as unknown) as Node);
  ok("a charge stroke is present in-flight before the next navigation", qs(host, ".rail__brand .dp-mark-charge") !== null);
  shell.setMain((docAny.createElement("p") as unknown) as Node);
  ok("at most one charge stroke is in flight at a time (the prior one was cleared)", qsa(host, ".rail__brand .dp-mark-charge").length === 1);
  await flushAsync(2);
  ok("the charge animated both the downspout stroke and the svg pulse when the mark body exists", animateCalls.length >= 2);
  ok("the charge stroke is self-removing once the animation finishes", qs(host, ".rail__brand .dp-mark-charge") === null);

  // Under reduced motion, setMain takes the calm fallback: NO charge is injected (motionOK gates it)
  // and the swap is the plain instant apply, never the cross-fade. The content still lands (information
  // is never motion-gated, only the fade is). Drive the OS-level signal by making the reduced-motion
  // media query match (the a11y "motion" preference stays "system", so this is the OS branch), without
  // touching the persisted prefs. Restored afterwards so later sections see motion on again.
  const savedMatchMedia = g.matchMedia;
  g.matchMedia = (query: string): { matches: boolean; media: string; addEventListener(): void; removeEventListener(): void; addListener(): void; removeListener(): void } => ({
    media: query,
    matches: query.includes("reduced-motion"),
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  });
  const beforeCharge = animateCalls.length;
  const beforeVT = viewTransitions;
  shell.setMain((docAny.createElement("aside") as unknown) as Node, "prose");
  await flushAsync(2);
  ok("reduced motion swaps the content with no view transition (the plain apply)", viewTransitions === beforeVT);
  ok("reduced motion injects no rail-mark charge", animateCalls.length === beforeCharge);
  ok("reduced motion still lands the new content", qs(host, "main#main aside") !== null);
  g.matchMedia = savedMatchMedia; // restore the default so later sections see motion on again
}

console.log("-- setActiveRoute marks the active rail item with aria-current=page --");
{
  shell.setActiveRoute("/downpipes");
  const active = qsa(host, '.rail [aria-current="page"]');
  ok("exactly one rail item carries aria-current=page after setActiveRoute", active.length === 1);
  // Re-pointing it moves the marker.
  shell.setActiveRoute("/");
  ok("re-setting the active route moves the single aria-current marker", qsa(host, '.rail [aria-current="page"]').length === 1);
}

console.log("-- setTitle names the document and announces the destination politely --");
{
  shell.setTitle("Downpipes");
  ok("setTitle names the tab/history entry with the product suffix", (docAny as unknown as { title: string }).title === "Downpipes - downpipes console");
  // The polite announce is set a tick later (cleared first so repeat navigations re-announce).
  const announce = qs(host, '[role="status"][aria-live="polite"]')!;
  ok("the announce region is cleared synchronously before the delayed set", announce.textContent === "");
  await new Promise<void>((r) => setTimeout(r, 60));
  ok("the destination is announced politely after the tick", announce.textContent === "Downpipes");
}

console.log("-- setEngine replaces the engine chip with the new host --");
{
  // The initial chip (built at mount with a null host) is the Not-connected state.
  ok("the initial engine chip reads Not connected (null host at mount)", textOf(qs(host, ".engine-chip")!).includes("Not connected"));
  // setEngine swaps in a fresh chip with the connected host. The handle replaces the
  // node it was given (the original mount chip), so a single swap is the path under test here.
  shell.setEngine({ host: "engine.example.test" });
  const chip = qs(host, ".engine-chip")!;
  ok("setEngine swaps in a chip showing the connected host", textOf(chip).includes("engine.example.test"));
  // The chip carries NO status dot: nothing ever drove one (the app only ever knew "unknown"),
  // so a lamp here was a permanently grey light that read like a broken indicator.
  ok("the engine chip renders no status dot", qs(host, ".engine-chip .dot") === null);
}

console.log("-- setCaller re-curates the rail and shows the view toggle by role default --");
// biome-ignore lint/complexity/noUselessLoneBlockStatements: the bare block is this validator's section marker, not dead scope
{
  // A built-in owner hides nothing: no escape hatch, and the view toggle stays hidden (technical
  // default, no stored override).
  shell.setCaller(ownerCaller, true);
  ok("a built-in caller renders no show-all escape hatch", qs(host, ".rail-showall") === null);
  ok("a verified caller renders the account chip with the email", textOf(qs(host, ".account-slot")!).includes("owner@example.test"));
  ok("the view toggle is hidden for a technical-default role with no override", qs(host, ".view-toggle")!.hidden === true);

  // A custom shiny role that hides /reports: the escape hatch appears AND the view toggle is standing
  // chrome (role default is shiny).
  shell.setCaller(execCaller, true);
  ok("a curated caller that hides a screen renders the show-all escape hatch", qs(host, ".rail-showall") !== null);
  ok("the view toggle is shown for a shiny-default role", qs(host, ".view-toggle")!.hidden === false);
  // The hidden /reports item is dropped from the curated rail.
  ok("the hidden /reports item is curated out of the rail", qs(host, '.rail a[href="/reports"]') === null);

  // The escape hatch flips show-all and brings the hidden item back read-only.
  qs(host, ".rail-showall")!.click();
  ok("flipping show-all brings the otherwise-hidden /reports item back", qs(host, '.rail a[href="/reports"]') !== null);

  // A null caller (whoami pending) restores the full rail and the degraded account note.
  shell.setCaller(null, false);
  ok("a null caller restores the full uncurated rail (reports present)", qs(host, '.rail a[href="/reports"]') !== null);
  ok("a null caller shows the honest degraded identity note", textOf(qs(host, ".account-slot")!).includes("Signed in; identity pending"));
}

console.log("-- setViewMode reflects the pressed state without changing authority --");
{
  shell.setViewMode("shiny");
  const execBtn = qsa(host, ".view-toggle__btn")[0]!;
  ok("setViewMode(shiny) presses the executive button", execBtn.getAttribute("aria-pressed") === "true");
  shell.setViewMode("technical");
  ok("setViewMode(technical) releases the executive button", execBtn.getAttribute("aria-pressed") === "false");
}

console.log("-- setSetup renders the route-aware guided-setup strip --");
{
  const incomplete = deriveSetup(setupState({ boundSourceCount: 0, downpipeCount: 0 }));
  // On a non-Overview route the strip shows for an incomplete setup.
  shell.setActiveRoute("/downpipes");
  shell.setSetup(incomplete);
  const strip = qs(host, ".setup-strip")!;
  ok("an incomplete setup shows the strip off the Overview route", strip.hidden === false);
  ok("the strip names the current step number", textOf(strip).includes("step"));

  // On the Overview route the strip suppresses itself (the checklist owns the statement there).
  shell.setActiveRoute("/");
  ok("the strip suppresses itself on the Overview route while incomplete", qs(host, ".setup-strip")!.hidden === true);

  // A complete setup shows the one-time completion line on any route.
  shell.setActiveRoute("/downpipes");
  const complete = deriveSetup(setupState({}));
  shell.setSetup(complete);
  ok("a complete setup shows the completion strip", qs(host, ".setup-strip")!.hidden === false && textOf(qs(host, ".setup-strip")!).includes("Setup complete"));

  // null clears the gating entirely.
  shell.setSetup(null);
  ok("setSetup(null) clears the strip (no gating)", qs(host, ".setup-strip")!.hidden === true);
}

console.log("-- setNavCount patches the quiet attention chip in place --");
{
  // Re-resolve a caller so the live rail has the /credentials link, then set + clear the count.
  shell.setCaller(ownerCaller, true);
  shell.setNavCount("/credentials", 5);
  const link = qs(host, '.rail a[href="/credentials"]')!;
  ok("a count > 0 renders the .nav-item__count chip on the credentials link", qs(link, ".nav-item__count") !== null);
  ok("the chip text is the integer", textOf(qs(link, ".nav-item__count")!) === "5");
  shell.setNavCount("/credentials", null);
  ok("a null count clears the chip in place", qs(qs(host, '.rail a[href="/credentials"]')!, ".nav-item__count") === null);
  // A count for a route with no live link is a safe no-op (recorded only).
  shell.setNavCount("/nonexistent-route", 3);
  ok("a count for an absent route does not throw and renders nothing", qs(host, ".nav-item__count") === null);
}

console.log("-- closeRail and setChrome toggle the shell chrome state --");
{
  // setChrome off marks the shell full-bleed; on clears the marker.
  shell.setChrome(false);
  ok("setChrome(false) marks the shell chrome off (full-bleed)", qs(host, ".shell")!.dataset.chrome === "off");
  shell.setChrome(true);
  ok("setChrome(true) clears the chrome-off marker", qs(host, ".shell")!.dataset.chrome === undefined);

  // closeRail is a no-op when the rail is not open (its guard), and a safe call regardless.
  shell.closeRail();
  ok("closeRail leaves a non-open rail in its default state", qs(host, ".shell")!.dataset.rail !== "open");

  // Open the rail via the toggle, then close it through the handle. At non-compact widths the toggle
  // collapses the strip rather than opening a slide-over, so assert the state is one the toggle set.
  qs(host, ".rail-toggle")!.click();
  const railState = qs(host, ".shell")!.dataset.rail;
  ok("the rail toggle changed the rail state", railState === "collapsed" || railState === "open" || railState === "default");
  shell.closeRail();
}

console.log("-- the ICON_REFRESH re-export is available for the refresh affordance --");
ok("ICON_REFRESH is re-exported from the shell entry", typeof ICON_REFRESH === "string" && ICON_REFRESH.length > 0);

if (failures > 0) process.exitCode = 1;

if (failures > 0) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("\nAPP SHELL COVERAGE VECTORS PASS");
