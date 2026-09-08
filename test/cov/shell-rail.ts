// Coverage validator for the shell rail rendering (src/shell/rail.ts): the (re)building of the
// curated nav rail, the active-route marking, the show-all escape hatch, the view-mode segmented
// control's pressed state, and the guided-setup strip. The app-shell validator drives these through
// the public Shell API, but it never reaches the leaf click handlers (the escape-hatch flip, the
// Help entry, the setup-strip Continue / Run-it links, and the dismiss button) nor every render
// branch (a group with a label, an owner-only step seen by a non-owner, the anyRunCompleted copy
// fork). This file calls the rail's exported renderers DIRECTLY against a hand-built ShellInternals
// so each render state and each handler runs end to end.
//
// It renders the real production code under the shared DOM shim (test/dom-shim.ts), exactly as the
// component validators do, and never edits that shared shim. Run with `node test/cov/shell-rail.ts`
// (the cov runner also invokes it).

import { installDomShim, qs, qsa, textOf } from "../dom-shim.ts";

installDomShim();

// The rail's keyboard wiring reads document.activeElement against HTMLAnchorElement values; the shim
// has a single element class. Alias HTMLElement to it so any instanceof guard downstream resolves as
// a browser would (a shim element is an HTMLElement; null is not). The shared shim file is untouched.
{
  const g = globalThis as unknown as Record<string, unknown>;
  const NodeCtor = (g as { Node: unknown }).Node;
  if (!("HTMLElement" in g)) g.HTMLElement = NodeCtor;
  if (!("SVGElement" in g)) g.SVGElement = NodeCtor;
}

import {
  setViewModeControl,
  renderRail,
  applyActiveRoute,
  renderSetupStrip,
} from "../../src/shell/rail.ts";
import { deriveSetup } from "../../src/lib/setup-state.ts";
import { setupCelebrated } from "../../src/lib/setup-state.ts";
import type { ShellInternals } from "../../src/shell/types.ts";
import type { SetupState } from "../../src/lib/api/types/sources.ts";
import type { Caller } from "../../src/lib/api/types/who.ts";
import type { CustomRole } from "../../src/lib/identity.ts";

const g = globalThis as unknown as Record<string, unknown>;
const doc = g.document as {
  createElement(tag: string): unknown;
  body: { appendChild(n: unknown): unknown };
};

let failures = 0;
function ok(name: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`);
  if (!cond) failures++;
}

// A typed window onto a shimmed element, enough for the reads the test makes.
type El = {
  getAttribute(k: string): string | null;
  setAttribute(k: string, v: string): void;
  classList: { contains(c: string): boolean };
  querySelector(sel: string): El | null;
  querySelectorAll(sel: string): El[];
  appendChild(n: El): El;
  click(): void;
  childNodes: El[];
  hidden: boolean;
  textContent: string;
  dataset: Record<string, string>;
};

function el(tag: string): El {
  return doc.createElement(tag) as unknown as El;
}

// ---- callers: a built-in owner (hides nothing), a custom shiny role (hides /reports) -----------
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
  // Hide the reports screen so curation drops an item and the escape hatch becomes meaningful.
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

// makeInternals builds a fresh ShellInternals with its own DOM nodes, wiring navigateFn to record
// every route the rail's handlers ask the router to open. Only the fields the rail touches are
// real DOM (navEl, railFooter, setupStrip); the rest are inert placeholders the rail never reads.
interface Harness {
  internals: ShellInternals;
  navEl: El;
  railFooter: El;
  setupStrip: El;
  navigated: string[];
}
function makeInternals(over: Partial<ShellInternals> = {}): Harness {
  const navEl = el("nav");
  const railFooter = el("div");
  const setupStrip = el("div");
  const navigated: string[] = [];
  const placeholder = el("div") as unknown as HTMLElement;
  const internals: ShellInternals = {
    navLinks: new Map(),
    mainRegion: placeholder,
    engineChip: placeholder,
    accountSlot: placeholder,
    shellEl: placeholder,
    railToggle: placeholder as unknown as HTMLButtonElement,
    navEl: navEl as unknown as HTMLElement,
    railFooter: railFooter as unknown as HTMLElement,
    scrim: placeholder,
    caller: null,
    showAll: false,
    activePattern: "",
    navigateFn: (r: string) => navigated.push(r),
    setup: null,
    setupStrip: setupStrip as unknown as HTMLElement,
    navCounts: new Map(),
    ...over,
  };
  return { internals, navEl, railFooter, setupStrip, navigated };
}

console.log("-- setViewModeControl reflects the resolved mode in the segmented toggle --");
{
  const execBtn = el("button") as unknown as HTMLButtonElement;
  const techBtn = el("button") as unknown as HTMLButtonElement;
  setViewModeControl(execBtn, techBtn, "shiny");
  ok("shiny presses the executive button and clears the technical one",
    (execBtn as unknown as El).getAttribute("aria-pressed") === "true"
    && (techBtn as unknown as El).getAttribute("aria-pressed") === "false"
    && (execBtn as unknown as El).classList.contains("is-active")
    && !(techBtn as unknown as El).classList.contains("is-active"));
  setViewModeControl(execBtn, techBtn, "technical");
  ok("technical presses the technical button and releases the executive one",
    (execBtn as unknown as El).getAttribute("aria-pressed") === "false"
    && (techBtn as unknown as El).getAttribute("aria-pressed") === "true"
    && !(execBtn as unknown as El).classList.contains("is-active")
    && (techBtn as unknown as El).classList.contains("is-active"));
}

console.log("-- renderRail for a null caller builds the full grouped rail with a Help footer --");
{
  const h = makeInternals({ caller: null, activePattern: "/downpipes" });
  renderRail(h.internals);
  // The ungrouped top group (NAV[0], label:null) renders Overview with no group label, and a
  // labelled group (Operate) renders its uppercase label.
  ok("the ungrouped Overview item renders with no group label",
    qs(h.navEl, 'a[href="/"]') !== null && qs(h.navEl, "#navgrp-")?.textContent !== "Overview");
  ok("a labelled group renders its aria-labelledby section label",
    qs(h.navEl, "#navgrp-operate") !== null && (qs(h.navEl, "#navgrp-operate")?.textContent ?? "") === "Operate");
  // Every NAV item is reachable for a null caller (no curation), so /reports is present.
  ok("a null caller shows the full uncurated rail (reports present)", qs(h.navEl, 'a[href="/reports"]') !== null);
  // The live navLinks map is replaced with the freshly built links.
  ok("renderRail replaces the live navLinks map with the built links", h.internals.navLinks.size > 0 && h.internals.navLinks.has("/downpipes"));
  // The active route was re-applied (activePattern was set), so exactly one link is current.
  ok("the active route is re-applied to the rebuilt links", qsa(h.navEl, '[aria-current="page"]').length === 1);
  // A built-in/null caller hides nothing, so no escape hatch.
  ok("a null caller renders no show-all escape hatch", qs(h.railFooter, ".rail-showall") === null);
  // Consistent Help is always last in the footer.
  const footerKids = h.railFooter.childNodes;
  const last = footerKids[footerKids.length - 1]!;
  ok("a persistent Help entry is always last in the footer", last.getAttribute("href") === "/command-palette" && textOf(last).includes("Help"));
  // Clicking Help routes to the palette and prevents the default navigation.
  qs(h.railFooter, 'a[href="/command-palette"]')!.click();
  ok("clicking the Help entry routes to the command palette", h.navigated[h.navigated.length - 1] === "/command-palette");
}

console.log("-- renderRail with no activePattern skips the active-route re-apply --");
{
  const h = makeInternals({ caller: null, activePattern: "" });
  renderRail(h.internals);
  ok("an empty active pattern leaves no rail item marked current", qsa(h.navEl, '[aria-current="page"]').length === 0);
}

console.log("-- renderRail honours a visibleFor predicate (the change-request inbox) --");
{
  // A viewer cannot approve config changes, so the /config/changes item (visibleFor) is dropped even
  // though surface curation would keep it; an owner sees it.
  const viewer = makeInternals({ caller: { ...ownerCaller, role: "viewer", isOnlyOwner: false } });
  renderRail(viewer.internals);
  ok("a viewer is not shown the approver-only Change requests rail item", qs(viewer.navEl, 'a[href="/config/changes"]') === null);

  const owner = makeInternals({ caller: ownerCaller });
  renderRail(owner.internals);
  ok("an owner is shown the Change requests rail item (visibleFor passes)", qs(owner.navEl, 'a[href="/config/changes"]') !== null);
}

console.log("-- renderRail curates a hidden screen out, and the escape hatch brings it back --");
{
  const h = makeInternals({ caller: execCaller, showAll: false });
  renderRail(h.internals);
  ok("the hidden /reports item is curated out of the rail", qs(h.navEl, 'a[href="/reports"]') === null);
  // The escape hatch is offered because this caller's surface hides a screen.
  const hatch = qs(h.railFooter, ".rail-showall");
  ok("a curated caller that hides a screen renders the show-all escape hatch", hatch !== null);
  ok("the escape hatch starts in the not-pressed (show-all-off) state", hatch!.getAttribute("aria-pressed") === "false");
  ok("the off-state escape hatch offers to show all screens", textOf(hatch!).includes("Show all screens"));
  // Flipping it turns showAll on and re-renders, bringing the hidden item back read-only.
  hatch!.click();
  ok("flipping show-all turns the internal flag on", h.internals.showAll === true);
  ok("flipping show-all brings the otherwise-hidden /reports item back", qs(h.navEl, 'a[href="/reports"]') !== null);
  const onHatch = qs(h.railFooter, ".rail-showall")!;
  ok("the on-state escape hatch is pressed and offers to show my screens", onHatch.getAttribute("aria-pressed") === "true" && textOf(onHatch).includes("Show my screens"));
  // The brought-back item is marked read-only (outside the curated surface) by buildNavLink, which
  // writes it through the dataset (a data-* property), not a class.
  ok("the show-all item is marked read-only via its dataset", qs(h.navEl, 'a[href="/reports"]')!.dataset.readonly === "true");
}

console.log("-- renderRail locks a not-yet-meaningful item during guided setup --");
{
  // An incomplete setup at step 1 (keys): downstream screens (e.g. /downpipes) are not yet allowed,
  // so their links carry the setup-locked marker + the inline reason; an always-allowed screen
  // (/settings) is not locked.
  const incomplete = deriveSetup(setupState({ keysReady: false, discoveryTokenPresent: false, boundSourceCount: 0, downpipeCount: 0, destination: { configured: false, verified: false, kind: "r2", source: "console" } }));
  const h = makeInternals({ caller: ownerCaller, setup: incomplete, activePattern: "/" });
  renderRail(h.internals);
  const dp = qs(h.navEl, 'a[href="/downpipes"]')!;
  ok("a not-yet-meaningful item is shown locked with the setup marker", dp.getAttribute("data-setup-locked") === "true");
  ok("the locked item carries the inline setup reason via aria-description", (dp.getAttribute("aria-description") ?? "").includes("Available after setup"));
  ok("an always-allowed Settings item is not locked during setup", qs(h.navEl, 'a[href="/settings"]')!.getAttribute("data-setup-locked") === null);
}

console.log("-- renderRail re-applies an attention count chip across the rebuild --");
{
  const counts = new Map<string, number>([["/credentials", 4]]);
  const h = makeInternals({ caller: ownerCaller, navCounts: counts });
  renderRail(h.internals);
  const link = qs(h.navEl, 'a[href="/credentials"]')!;
  ok("a count > 0 renders the attention chip on the matching link", qs(link, ".nav-item__count") !== null);
  ok("the chip text is the integer", textOf(qs(link, ".nav-item__count")!) === "4");
}

console.log("-- applyActiveRoute marks the active item and clears the others --");
{
  const h = makeInternals({ caller: ownerCaller, activePattern: "" });
  renderRail(h.internals);
  // A sub-pattern of Downpipes keeps Downpipes active (isItemActive reads activeFor), and only one.
  applyActiveRoute(h.internals, "/downpipes/:id");
  const current = qsa(h.navEl, '[aria-current="page"]');
  ok("a Downpipes sub-pattern marks exactly the Downpipes item current via activeFor", current.length === 1 && current[0]!.getAttribute("href") === "/downpipes");
  // Re-pointing it moves the single marker and clears the previous (the else branch removes it).
  applyActiveRoute(h.internals, "/runs");
  const moved = qsa(h.navEl, '[aria-current="page"]');
  ok("re-applying moves the single marker and clears the prior item", moved.length === 1 && moved[0]!.getAttribute("href") === "/runs");
}

console.log("-- applyActiveRoute falls back to a plain route match for a non-NAV link --");
{
  // A navLinks entry whose route is NOT in the static NAV exercises the `route === pattern` else
  // branch (findNavItem returns undefined). Build the link, register it, and match by exact route.
  const h = makeInternals();
  const synthetic = el("a");
  synthetic.setAttribute("href", "/synthetic-route");
  h.internals.navLinks = new Map([["/synthetic-route", synthetic as unknown as HTMLAnchorElement]]);
  applyActiveRoute(h.internals, "/synthetic-route");
  ok("a non-NAV link is marked current on an exact route match", synthetic.getAttribute("aria-current") === "page");
  applyActiveRoute(h.internals, "/something-else");
  ok("a non-matching pattern clears the non-NAV link's current marker", synthetic.getAttribute("aria-current") === null);
}

console.log("-- renderSetupStrip hides itself when there is no gating --");
{
  const h = makeInternals({ setup: null });
  renderSetupStrip(h.internals);
  ok("a null setup hides and empties the strip", h.setupStrip.hidden === true && h.setupStrip.childNodes.length === 0);
}

console.log("-- renderSetupStrip suppresses itself on the Overview route while incomplete --");
{
  const incomplete = deriveSetup(setupState({ boundSourceCount: 0, downpipeCount: 0 }));
  const h = makeInternals({ setup: incomplete, activePattern: "/" });
  renderSetupStrip(h.internals);
  ok("an incomplete setup on the Overview route hides the strip (the checklist owns it)", h.setupStrip.hidden === true && h.setupStrip.childNodes.length === 0);
}

console.log("-- renderSetupStrip shows the in-progress line off the Overview route --");
{
  // boundSourceCount 0 / downpipeCount 0 with everything earlier done -> the current step is
  // "Pick what to protect" (sources, NOT owner-only), so the Continue copy is the standard label.
  const incomplete = deriveSetup(setupState({ boundSourceCount: 0, downpipeCount: 0 }));
  const h = makeInternals({ setup: incomplete, activePattern: "/downpipes" });
  renderSetupStrip(h.internals);
  ok("an incomplete setup off the Overview route shows the strip", h.setupStrip.hidden === false);
  ok("the strip renders one pip per step", qsa(h.setupStrip, ".setup-pip").length === incomplete.steps.length);
  // The earlier steps are done (rendered done), and the current sources step is current.
  ok("a completed earlier step renders a done pip", qsa(h.setupStrip, ".setup-pip--done").length >= 1);
  ok("the current step renders a current pip", qsa(h.setupStrip, ".setup-pip--current").length === 1);
  ok("the strip names the step number and the lowercased step label", textOf(h.setupStrip).includes(`step ${incomplete.stepNumber} of`) && textOf(h.setupStrip).includes("pick what to protect"));
  const go = qs(h.setupStrip, ".setup-strip__go")!;
  ok("a non-owner-only current step offers a plain Continue", textOf(go) === "Continue");
  go.click();
  ok("Continue routes to the current step's home (/sources)", h.navigated[h.navigated.length - 1] === "/sources");
}

console.log("-- renderSetupStrip reads an owner-only step seen by a non-owner as a hand-off --");
{
  // A non-owner caller on an owner-only current step (keys, step 1): the copy adds the Owner hand-off
  // note and the action reads "View the step" rather than a dead Continue.
  const incomplete = deriveSetup(setupState({ keysReady: false, discoveryTokenPresent: false, boundSourceCount: 0, downpipeCount: 0, destination: { configured: false, verified: false, kind: "r2", source: "console" } }));
  const nonOwner: Caller = { ...ownerCaller, role: "viewer", isOnlyOwner: false };
  const h = makeInternals({ setup: incomplete, activePattern: "/downpipes", caller: nonOwner });
  renderSetupStrip(h.internals);
  ok("an owner-only step seen by a non-owner adds the Owner hand-off note", textOf(h.setupStrip).includes("an Owner finishes this step"));
  const go = qs(h.setupStrip, ".setup-strip__go")!;
  ok("the owner-only hand-off offers View the step (never a dead Continue)", textOf(go) === "View the step");
  go.click();
  ok("View the step routes to the owner-only step's home (/onboarding/connect)", h.navigated[h.navigated.length - 1] === "/onboarding/connect");
}

console.log("-- renderSetupStrip Continue falls back to / when the setup view has cleared --");
{
  // The Continue click reads internals.setup at click time; if it has since cleared, it routes to "/".
  const incomplete = deriveSetup(setupState({ boundSourceCount: 0, downpipeCount: 0 }));
  const h = makeInternals({ setup: incomplete, activePattern: "/downpipes" });
  renderSetupStrip(h.internals);
  h.internals.setup = null; // the view cleared after render but before the click
  qs(h.setupStrip, ".setup-strip__go")!.click();
  ok("a Continue click after the setup cleared routes to Overview", h.navigated[h.navigated.length - 1] === "/");
}

console.log("-- renderSetupStrip shows the completion line (first backup not yet run) --");
{
  const complete = deriveSetup(setupState({ anyRunCompleted: false }));
  const h = makeInternals({ setup: complete, activePattern: "/downpipes" });
  renderSetupStrip(h.internals);
  ok("a complete setup shows the completion strip", h.setupStrip.hidden === false && textOf(h.setupStrip).includes("Setup complete"));
  ok("with no run yet the line reads the backup can run now", textOf(h.setupStrip).includes("your first backup can run now"));
  const go = qs(h.setupStrip, ".setup-strip__go")!;
  ok("the completion action offers Run it when no run has completed", textOf(go) === "Run it");
  go.click();
  ok("Run it routes to Downpipes", h.navigated[h.navigated.length - 1] === "/downpipes");
}

console.log("-- renderSetupStrip shows the completion line (a backup has run) --");
{
  const completed = deriveSetup(setupState({ anyRunCompleted: true }));
  const h = makeInternals({ setup: completed, activePattern: "/downpipes" });
  renderSetupStrip(h.internals);
  ok("with a run completed the line reads the first backup has run", textOf(h.setupStrip).includes("your first backup has run"));
  ok("the completion action offers Open Downpipes once a run has completed", textOf(qs(h.setupStrip, ".setup-strip__go")!) === "Open Downpipes");
}

console.log("-- renderSetupStrip dismiss marks celebrated, clears the gating, and rebuilds --");
{
  // The dismiss button is the lines-215-218 path: markSetupCelebrated() persists the flag, the gating
  // is cleared (setup = null), the strip re-renders hidden, and the rail rebuilds without locks.
  (g.localStorage as { removeItem(k: string): void }).removeItem("dp-setup-celebrated");
  ok("the celebrated flag starts unset for this case", setupCelebrated() === false);
  const completed = deriveSetup(setupState({ anyRunCompleted: true }));
  const h = makeInternals({ setup: completed, activePattern: "/downpipes", caller: ownerCaller });
  // Render the rail too, so the dismiss handler's renderRail(internals) has a live nav to rebuild.
  renderRail(h.internals);
  renderSetupStrip(h.internals);
  const dismiss = qs(h.setupStrip, ".setup-strip__dismiss")!;
  ok("the completion strip renders a dismiss control", dismiss !== null && dismiss.getAttribute("aria-label") === "Dismiss the setup strip");
  dismiss.click();
  ok("dismiss persisted the celebrated flag", setupCelebrated() === true);
  ok("dismiss cleared the gating (internals.setup is null)", h.internals.setup === null);
  ok("dismiss re-rendered the strip hidden", h.setupStrip.hidden === true && h.setupStrip.childNodes.length === 0);
  ok("dismiss rebuilt the rail (the Help footer is back)", qs(h.railFooter, 'a[href="/command-palette"]') !== null);
}

if (failures > 0) process.exitCode = 1;

if (failures > 0) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("\nSHELL RAIL COVERAGE VECTORS PASS");
