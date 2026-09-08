// Coverage for src/components/feedback.ts: the empty / loading (skeleton) / banner primitives plus
// the calm note and posture strip. These cover three of the
// six states every screen must handle (the error states live in error-view.ts), so this file drives
// each rendering function under the shared DOM shim (no jsdom, no network) and asserts a meaningful
// outcome for every state and branch rather than merely touching a line.
//
// Run with: node test/cov/components-feedback.ts
//
// Surfaces driven (and the contract each asserts):
//   emptyState    the inset card; the optional diagram node above the text; the optional body line;
//                 the optional action button with its primary default vs the secondary variant; and
//                 that clicking the action fires the caller's onClick.
//   skeletonRows  the aria-busy aria-hidden block; the default bar count and an explicit count.
//   skeletonTiles the aria-busy stat grid; the default tile count and an explicit count.
//   banner        the info glyph vs the alert glyph for warn / danger; a string, a numeric and a
//                 Node message; the falsy-message guard; the optional action; and the dismissible
//                 close button that removes the banner from its parent.
//   noteQuiet     the muted single-line note built from spread content.
//   postureStrip  the dot + label item per entry; the supplied aria-label vs the "Posture" default;
//                 and the optional trailing detail affordance firing its onClick.

import { installDomShim, qs, qsa, textOf, classesOf, type ShimNode } from "../dom-shim.ts";
import { h } from "../../src/lib/dom.ts";
import { ICON_INFO, ICON_ALERT, ICON_CLOSE } from "../../src/lib/icons.ts";

// Install the shim BEFORE importing the component (lib/dom.ts creates elements at load time).
installDomShim();

const feedback = await import("../../src/components/feedback.ts");
const { emptyState, skeletonRows, skeletonTiles, banner, noteQuiet, postureStrip } = feedback;

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

// glyphPresent reads the path markup svgIcon set verbatim as an svg's innerHTML, so a test can
// assert WHICH glyph a state resolved to, not merely that an icon exists. The banner's icon lives
// inside the .banner__icon span.
function glyphPresent(root: ShimNode, iconSelector: string, iconMarkup: string): boolean {
  const span = qs(root, iconSelector);
  if (span === null) return false;
  const svg = span.querySelector("svg") ?? span.children[0] ?? null;
  return svg?.innerHTML.includes(iconMarkup) ?? false;
}

// ---- 1. emptyState: the full card with diagram, body and a secondary action -------------------

{
  // A diagram node, a body line and a secondary-variant action together exercise all three optional
  // legs plus the secondary class arm.
  let clicked = 0;
  const diagram = h("div", { class: "probe-diagram" }, "source to engine to dest") as unknown as ShimNode;
  const card = emptyState({
    title: "No downpipes yet",
    body: "Create one to start backing up.",
    action: { label: "Create downpipe", onClick: () => { clicked++; }, variant: "secondary" },
    diagram: diagram as unknown as Node,
  }) as unknown as ShimNode;

  ok("emptyState renders an inset measure card", classesOf(card).includes("empty-state") && classesOf(card).includes("card--inset") && classesOf(card).includes("measure"));
  ok("emptyState mounts the supplied diagram above the text", qs(card, ".empty-state__diagram .probe-diagram") !== null);
  ok("emptyState renders the title", textOf(qs(card, ".empty-state__title")!) === "No downpipes yet");
  ok("emptyState renders the body line when supplied", qs(card, ".empty-state__body") !== null && textOf(qs(card, ".empty-state__body")!) === "Create one to start backing up.");
  const secBtn = qs(card, ".empty-state__action button");
  ok("a secondary action takes the btn--secondary class", secBtn !== null && classesOf(secBtn).includes("btn--secondary") && !classesOf(secBtn).includes("btn--primary"));
  ok("the action button shows the caller's label", secBtn !== null && textOf(secBtn) === "Create downpipe");
  secBtn!.click();
  ok("clicking the empty-state action invokes the caller's onClick", clicked === 1);
}

{
  // A primary-by-default action with NO diagram and NO body: the diagram and body if-branches are
  // skipped, and the variant ternary falls to the primary arm (variant omitted).
  const card = emptyState({
    title: "Nothing to show",
    action: { label: "Refresh", onClick: () => {} },
  }) as unknown as ShimNode;
  ok("emptyState omits the diagram block when none is supplied", qs(card, ".empty-state__diagram") === null);
  ok("emptyState omits the body paragraph when no body is supplied", qs(card, ".empty-state__body") === null);
  const priBtn = qs(card, ".empty-state__action button");
  ok("an action with no variant defaults to btn--primary", priBtn !== null && classesOf(priBtn).includes("btn--primary"));
}

{
  // A bare title only: no diagram, no body, no action. The action if-branch is skipped, so the card
  // holds just the title and offers no button.
  const card = emptyState({ title: "Filtered out" }) as unknown as ShimNode;
  ok("a title-only empty state renders the title", textOf(qs(card, ".empty-state__title")!) === "Filtered out");
  ok("a title-only empty state appends no action row", qs(card, ".empty-state__action") === null);
  ok("a title-only empty state offers no button", qsa(card, "button").length === 0);
}

// ---- 2. skeletonRows: the default count and an explicit count ---------------------------------

{
  // The default (count omitted) builds four rows inside an aria-busy aria-hidden block.
  const def = skeletonRows() as unknown as ShimNode;
  ok("skeletonRows is an aria-busy block", def.getAttribute("aria-busy") === "true");
  ok("skeletonRows is aria-hidden from assistive tech", def.getAttribute("aria-hidden") === "true");
  ok("skeletonRows carries the skeleton-block class", classesOf(def).includes("skeleton-block"));
  ok("skeletonRows builds four rows by default", qsa(def, ".skeleton-row").length === 4);

  // An explicit count overrides the default and every bar carries both skeleton classes.
  const seven = skeletonRows(7) as unknown as ShimNode;
  ok("skeletonRows builds exactly the requested number of rows", qsa(seven, ".skeleton-row").length === 7);
  const firstRow = qs(seven, ".skeleton-row");
  ok("each skeleton row carries the shimmer base class", firstRow !== null && classesOf(firstRow).includes("skeleton"));

  // A zero count is honest: an empty (but still aria-busy) block, no rows.
  const none = skeletonRows(0) as unknown as ShimNode;
  ok("skeletonRows(0) builds no rows", qsa(none, ".skeleton-row").length === 0);
}

// ---- 3. skeletonTiles: the default count and an explicit count --------------------------------

{
  // The default builds four tiles inside an aria-busy stat grid.
  const def = skeletonTiles() as unknown as ShimNode;
  ok("skeletonTiles is an aria-busy stat grid", def.getAttribute("aria-busy") === "true" && classesOf(def).includes("stat-grid"));
  ok("skeletonTiles is aria-hidden from assistive tech", def.getAttribute("aria-hidden") === "true");
  ok("skeletonTiles builds four tiles by default", qsa(def, ".skeleton-tile").length === 4);

  // An explicit count overrides the default.
  const three = skeletonTiles(3) as unknown as ShimNode;
  ok("skeletonTiles builds exactly the requested number of tiles", qsa(three, ".skeleton-tile").length === 3);
  const firstTile = qs(three, ".skeleton-tile");
  ok("each skeleton tile carries the shimmer base class", firstTile !== null && classesOf(firstTile).includes("skeleton"));
}

// ---- 4. banner: the info glyph, an action, and a string message -------------------------------

{
  // tone "info" selects ICON_INFO; a string message is wrapped in a text node; the action renders a
  // button that fires the caller's onClick. Not dismissible by default, so there is no close button.
  let acted = 0;
  const el = banner({
    tone: "info",
    message: "An update is available.",
    action: { label: "Review update", onClick: () => { acted++; } },
  }) as unknown as ShimNode;

  ok("banner is a role=region notice", el.getAttribute("role") === "region" && el.getAttribute("aria-label") === "Notice");
  ok("an info banner carries the info tone class", classesOf(el).includes("banner--info"));
  ok("an info banner uses the info glyph", glyphPresent(el, ".banner__icon", ICON_INFO));
  ok("a string message renders into the message area", textOf(qs(el, ".banner__msg")!) === "An update is available.");
  const actBtn = qs(el, ".banner__action");
  ok("the optional action renders a button with the caller's label", actBtn !== null && textOf(actBtn) === "Review update");
  actBtn!.click();
  ok("clicking the banner action invokes the caller's onClick", acted === 1);
  ok("a non-dismissible banner has no close button", qs(el, ".banner__close") === null);
}

// ---- 5. banner: the warn / danger glyph, a numeric message, and the dismissible close ----------

{
  // tone "warn" selects ICON_ALERT (the not-info arm); a numeric message takes the number typeof
  // leg; dismissible:true appends the close button, whose click removes the banner from its parent.
  const host = h("div", { class: "banner-host" }) as unknown as ShimNode;
  const el = banner({ tone: "warn", message: 42, dismissible: true }) as unknown as ShimNode;
  host.appendChild(el);

  ok("a warn banner carries the warn tone class", classesOf(el).includes("banner--warn"));
  ok("a non-info banner uses the alert glyph", glyphPresent(el, ".banner__icon", ICON_ALERT));
  ok("a numeric message renders its stringified value", textOf(qs(el, ".banner__msg")!) === "42");
  ok("a warn banner without an action renders no action button", qs(el, ".banner__action") === null);
  const close = qs(el, ".banner__close");
  ok("a dismissible banner renders a close button", close !== null && close.getAttribute("aria-label") === "Dismiss");
  ok("the close button uses the close glyph", glyphPresent(el, ".banner__close", ICON_CLOSE));
  ok("the banner is mounted in its host before dismissal", qs(host, ".banner") !== null);
  close!.click();
  ok("clicking the close button removes the banner from its parent", qs(host, ".banner") === null && el.parentNode === null);
}

{
  // tone "danger" also selects ICON_ALERT (covering the danger leg of the not-info arm).
  const el = banner({ tone: "danger", message: "Access is not enforced." }) as unknown as ShimNode;
  ok("a danger banner carries the danger tone class", classesOf(el).includes("banner--danger"));
  ok("a danger banner uses the alert glyph", glyphPresent(el, ".banner__icon", ICON_ALERT));
}

{
  // A Node message takes the else branch (appendChild(opts.message as Node)); the supplied element
  // is attached verbatim with its own marker class so the test can find it.
  const node = h("a", { class: "probe-msg-node", href: "#" }, "Open the update") as unknown as ShimNode;
  const el = banner({ tone: "info", message: node as unknown as import("../../src/lib/dom.ts").Child }) as unknown as ShimNode;
  const msg = qs(el, ".banner__msg");
  ok("a Node message is attached inside the message area", msg !== null && qs(msg, ".probe-msg-node") !== null);
  ok("the attached Node message keeps its text", textOf(qs(el, ".probe-msg-node")!) === "Open the update");
}

{
  // A falsy (empty-string) message exercises the final else-if guard: the string typeof leg appends
  // a text node holding "" rather than the Node branch, and the message area stays empty of markup.
  const el = banner({ tone: "info", message: "" }) as unknown as ShimNode;
  const msg = qs(el, ".banner__msg");
  ok("an empty-string message still renders a (text-only) message area", msg !== null && textOf(msg) === "" && qsa(msg, "*").length === 0);
}

{
  // A null message takes neither the string/number leg nor the truthy Node leg (the else-if guard
  // is false), so the message area is appended but holds nothing at all.
  const el = banner({ tone: "info", message: null as unknown as import("../../src/lib/dom.ts").Child }) as unknown as ShimNode;
  const msg = qs(el, ".banner__msg");
  ok("a null message renders an empty message area with no children", msg !== null && msg.childNodes.length === 0);
}

// ---- 6. noteQuiet: the muted single-line note from spread content ------------------------------

{
  // noteQuiet spreads its content into one muted line; a string plus a Node together prove the
  // variadic path carries both kinds of child.
  const tail = h("strong", { class: "probe-note-tail" }, "12 entries") as unknown as ShimNode;
  const note = noteQuiet("Last verified ", tail as unknown as import("../../src/lib/dom.ts").Child) as unknown as ShimNode;
  ok("noteQuiet carries the note-quiet class", classesOf(note).includes("note-quiet"));
  ok("noteQuiet renders its leading text", textOf(note).includes("Last verified "));
  ok("noteQuiet renders a node child it was given", qs(note, ".probe-note-tail") !== null && textOf(qs(note, ".probe-note-tail")!) === "12 entries");

  // No content at all: the variadic spread is empty, so the note is an empty muted line.
  const empty = noteQuiet() as unknown as ShimNode;
  ok("noteQuiet with no content is an empty note", classesOf(empty).includes("note-quiet") && empty.childNodes.length === 0);
}

// ---- 7. postureStrip: items and the label default -------------------------------------------
// The strip has no trailing detail affordance: the option was removed (see
// src/components/feedback.ts for why), so the assertion below is that NO link-like button is
// built for any input, not that one is built for the right one.

{
  // Several items and an explicit aria-label exercise the item loop and the label-supplied arm
  // of the ??.
  const strip = postureStrip(
    [
      { tone: "ok", label: "Backups current" },
      { tone: "warn", label: "Access not enforced" },
      { tone: "neutral", label: "Replicas pending" },
    ],
    { label: "Backup posture" },
  ) as unknown as ShimNode;

  ok("postureStrip is a role=region with the supplied aria-label", strip.getAttribute("role") === "region" && strip.getAttribute("aria-label") === "Backup posture");
  ok("postureStrip carries the posture-strip class", classesOf(strip).includes("posture-strip"));
  ok("postureStrip renders one item per entry", qsa(strip, ".posture-strip__item").length === 3);
  // Each item is a dot + visible label (statusWithLabel), so the tones and labels read through.
  ok("postureStrip carries a dot for each item's tone", qsa(strip, ".dot--ok").length === 1 && qsa(strip, ".dot--warn").length === 1 && qsa(strip, ".dot--neutral").length === 1);
  ok("postureStrip shows each item's text label", textOf(strip).includes("Backups current") && textOf(strip).includes("Access not enforced") && textOf(strip).includes("Replicas pending"));
  ok("postureStrip builds no trailing affordance of its own", qs(strip, "button.linklike") === null);
  ok("postureStrip builds no button at all", qsa(strip, "button").length === 0);
}

{
  // No opts at all: the default opts {} is used and the label ?? falls back to "Posture".
  const strip = postureStrip([{ tone: "info", label: "Read only" }]) as unknown as ShimNode;
  ok("postureStrip falls back to the Posture aria-label when none is given", strip.getAttribute("aria-label") === "Posture");
  ok("postureStrip with no opts renders no trailing affordance", qs(strip, "button.linklike") === null);
  ok("postureStrip still renders its single item", qsa(strip, ".posture-strip__item").length === 1 && textOf(strip).includes("Read only"));
}

{
  // An empty items list: the for-of loop body never runs, so the strip is an empty region.
  const strip = postureStrip([], { label: "Empty posture" }) as unknown as ShimNode;
  ok("an empty posture strip renders no items", qsa(strip, ".posture-strip__item").length === 0);
  ok("an empty posture strip keeps its supplied aria-label", strip.getAttribute("aria-label") === "Empty posture");
}

// ---- summary -----------------------------------------------------------------------------------

if (failures > 0) process.exitCode = 1;

if (failures > 0) {
  console.log(`\nFEEDBACK COVERAGE: ${failures} FAIL`);
  process.exit(1);
}
console.log("\nFEEDBACK COVERAGE PASS");
