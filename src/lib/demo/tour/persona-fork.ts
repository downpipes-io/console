// The welcome card: the tour's FIRST interaction. The tour opens with a
// short welcome that greets the visitor and says in two lines what the tour is (a guided ten-chapter walk
// through the real console on sample data, no signup) and that every feature shown is in the free Community
// edition. The pitch paragraphs live on the marketing site, not here: the welcome's job is to start the walk,
// not to sell. Its two persona actions each start a DIFFERENT curated walk; the demoted "Free Explore"
// control (a real button styled as a link) drops to free-explore. Choosing a persona tears the welcome down,
// builds a TourDirector over that persona's typed script (scripts/chapters.ts), and starts it. Both walks
// bookend with Overview/no-custody and the funnel.
//
// It is PURE presentation + wiring on the console's own design tokens and the h() DOM builder, zero
// dependency, and additive: it imports only console-own modules and the tour modules, and nothing here runs
// on the genuine console (it is mounted only by startTour(), which the tour/demo flag path calls). CSP: every
// style is applied through the CSSOM by h() (per-property setProperty), never an inline style attribute, so
// the card runs under the console's strict style-src 'self' with no 'unsafe-inline'.
//
// Accessibility (the same WCAG 2.2 AA gate the console holds): the card is a labelled role=dialog the focus
// moves into; each action is a real <button> reachable and operable by keyboard with the console's own
// visible focus ring; an off-screen live region announces the welcome; and prefers-reduced-motion is honoured
// (the entrance is instant under reduced motion). It is a labelled, NON-trapping dialog (aria-modal=false), not
// a true modal: it does not trap Tab, does not make the app behind inert, and (per the redesign that keeps the
// real screen the star) it carries NO dim backdrop at all, so the booted Overview behind it stays fully visible
// and reachable to every input mode alike - mouse, keyboard and screen reader. The always-visible "Free
// Explore" control (a real, keyboard-reachable button styled linklike so it reads quieter than the two walk
// primaries) and Escape are the explicit exits for all input modes, leaving the visitor in the genuine, faked
// console, with a persistent "Take the tour" relaunch control so skipping is reversible (it re-mounts the
// welcome), mirroring the in-tour Exit, which already offers a Resume affordance. Both exits count as a
// welcome engagement: destroy() emits persona_chosen with the coarse label "explore" (once per mount).
//
// House rules: Australian English, precise claims.

import { h, svgIcon } from "../../dom.ts";
import { motionOK } from "../../a11y-prefs.ts";
import { noteTourDegraded } from "../demo-drift.ts";
import { ICON_EXTERNAL, ICON_PLAY } from "../../icons.ts";
import { createTourDirector, type TourDirector } from "./director.ts";
import { TOUR_EARLY_EXIT } from "./scripts/chapters.ts";
import { applyFocusRing, clearFocusRing } from "./overlay.ts";
import { TOUR_SCRIPTS, type TourPersona } from "./scripts/chapters.ts";
import { emit } from "./analytics.ts";

// The stable element id, so a double launch is a no-op (the second mount finds the existing welcome and
// returns) and a test can find + dismiss it deterministically. One welcome card per page. The id keeps its
// historical "tour-persona-fork" value so the boot path and a test's stable selector are undisturbed.
const FORK_ID = "tour-persona-fork";

// The stable id of the persistent "Take the tour" relaunch affordance shown after the visitor explores freely
// (or presses Escape). It mirrors the director's Resume button (a fixed, tokenised control) so a visitor who
// skips to look around first can still enter the guided narrative, rather than being able to reach it only by
// reloading the page. Distinct from the director's "tour-resume" id, so the two affordances never collide and
// a test can find each. One relaunch control per page.
const RELAUNCH_ID = "tour-relaunch";

// The stable data attribute on each of the TWO walk start buttons; its value is the walk persona ("cto" |
// "engineer"), so a test can find and activate each deterministically without coupling to label text. The
// "Free Explore" control carries no start attribute (it starts no walk; its dismissal is counted separately
// as the analytics welcome choice "explore").
const START_ATTR = "tourStart";

// The handle the launcher (and a test) drives. choose() is the same path the on-screen "Start the tour" button
// takes (tear the welcome down, build + start the director over the single guided script). destroy() dismisses
// the welcome without starting (Escape / "Free Explore"), leaving the visitor in the real, faked app.
// director is the running director once the tour is started (null until then), so a test can assert the
// welcome actually started a tour.
export interface PersonaFork {
  choose(persona: TourPersona): void;
  destroy(): void;
  readonly root: HTMLElement;
  readonly director: TourDirector | null;
}

// Dependencies, all injectable so the coverage validator can drive the welcome headless with a spy director
// and a controllable document. In production every default is the real wiring.
export interface PersonaForkDeps {
  // Build the director over the guided script. Defaults to the real createTourDirector; a test injects a spy
  // to assert the script + that start() was called, without painting a real overlay.
  createDirector?: (persona: TourPersona) => TourDirector;
  // The document to mount into. Defaults to the ambient document.
  doc?: Document;
}

// mountPersonaFork builds the welcome card into document.body and returns its handle. Idempotent: a second
// call returns the existing card (never stacks two). It mounts a centred, backdrop-free card with the welcome
// copy, the two walk primaries and the demoted linklike "Free Explore" control; starting (or calling
// choose()) tears the card down and starts the guided tour. It is a no-op-safe view: a document with no body
// returns a detached handle whose verbs are inert (defensive; startTour runs at boot when the body exists).
export function mountPersonaFork(deps: PersonaForkDeps = {}): PersonaFork {
  const doc = deps.doc ?? document;
  // The default real director is built over the CHOSEN persona's curated script (TOUR_SCRIPTS). Each choice runs
  // a different walk over the same director; there is no mid-tour persona switch (a visitor exits to free-explore
  // and relaunches to pick the other path). A test that injects its own createDirector controls the director
  // shape itself, so the spy paths are unaffected.
  const makeDirector =
    deps.createDirector ??
    ((persona: TourPersona) => createTourDirector(TOUR_SCRIPTS[persona], { earlyExit: TOUR_EARLY_EXIT }));

  // The welcome is being shown, so the "Take the tour" relaunch affordance (shown only while the visitor is in
  // free-explore, the card down) must not linger behind it. Remove any stale relaunch control on mount.
  hideRelaunch(doc);

  const existing = doc.getElementById(FORK_ID);
  if (existing) {
    // The welcome is ALREADY mounted, so something asked for the tour twice. The defensive handle below
    // keeps the visitor's session sane, but the second mount builds a SECOND director over the same DOM, and a
    // double-driven tour spotlights two things at once and narrates over itself. It has never been visible in
    // the funnel (both sessions emit the same step_reached events), so it is recorded here.
    noteTourDegraded("double-mount");
    return existingHandle(existing, makeDirector);
  }

  let director: TourDirector | null = null;
  let destroyed = false;
  let keyHandler: ((ev: KeyboardEvent) => void) | null = null;
  // The element that held focus when the fork mounted (the control the visitor opened the tour from). Captured
  // BEFORE focus moves into the card, so teardown can return focus there instead of stranding a keyboard user
  // at <body> when the card is removed (the browser resets focus to <body> when the focused element leaves the
  // DOM, a WCAG 2.4.3 break). On a dismissal this restores focus directly; on a choice it restores it just
  // before the director mounts its overlay, so the director captures the same launch control as ITS anchor.
  let launchEl: HTMLElement | null = null;

  // The off-screen polite announcer: a screen reader hears the prompt when the card mounts, independent of
  // the visual layout. role=status + aria-live=polite so it never interrupts and is read once.
  const live = h("div", { role: "status", "aria-live": "polite", "aria-atomic": "true", class: "visually-hidden" });

  // choose(persona) is the single start action a persona button and the public verb share: record the choice,
  // drop the welcome (so the tour overlay is not painted under it), build the director over THAT persona's
  // curated script, and start it. Guarded so a double start (a fast double-tap) starts exactly one tour.
  function choose(persona: TourPersona): void {
    if (destroyed) return;
    // Count which lens the visitor chose (a coarse label, no personal data), behind the analytics flag inside
    // emit(); best-effort and never blocking.
    emit({ name: "persona_chosen", persona });
    // The visitor is entering the guided narrative: any "Take the tour" relaunch control from a prior skip
    // must not survive behind the tour overlay. The director owns the in-tour Resume affordance from here;
    // the relaunch belongs only to free-explore.
    hideRelaunch(doc);
    teardown();
    director = makeDirector(persona);
    director.start();
  }

  // teardown removes the fork chrome + the keyboard layer. It does NOT stop a running director (choose()
  // builds the director AFTER teardown), and is the path both a choice and a dismissal funnel through.
  function teardown(): void {
    if (destroyed) return;
    destroyed = true;
    unwireKeys();
    card.remove();
    // Removing the card removed the panel that held focus, so a keyboard user would otherwise be dumped at
    // <body> (WCAG 2.4.3 Focus Order). Return focus to the control they opened the tour from. On a dismissal
    // this is the visitor's final focus; on a choice it is momentary, then the director's overlay takes focus
    // (and captures this same control as its own restore anchor, so Exit later returns here too).
    if (launchEl && typeof launchEl.focus === "function" && launchEl.isConnected !== false) {
      try {
        launchEl.focus();
      } catch {
        // A DOM hiccup restoring focus must never break the teardown; the visitor keeps the browser default.
      }
    }
  }

  // destroy dismisses the fork WITHOUT starting a tour (Escape / the skip control): the visitor is left in the
  // genuine, faked app to explore, with a persistent "Take the tour" relaunch affordance so they can enter the
  // guided narrative later (it re-mounts the fork). This mirrors the director's Resume button: skipping at the
  // fork is no longer a one-way door, matching the in-tour Exit, which already offers a way back.
  function destroy(): void {
    // Dismissing to free-explore is still a welcome engagement (the visitor chose the console over a walk), so
    // count it as the coarse welcome choice "explore". Both dismissal paths (the "Free Explore" click and
    // Escape) funnel through destroy(); choose() never does (it calls teardown() directly), so a walk choice
    // can never emit "explore". The `destroyed` flag, read BEFORE teardown() sets it, is the single-emit
    // guard: a dismissal that reaches destroy() twice (a click whose handler runs alongside another teardown
    // path) emits exactly once. "explore" is deliberately NOT a TourPersona (no script exists for it); the
    // event's persona field is a plain string, so no type widens.
    if (!destroyed) emit({ name: "persona_chosen", persona: "explore" });
    teardown();
    // Mount the relaunch control AFTER teardown restores focus to the launch element, so the visitor's focus
    // lands where they opened the tour from (WCAG 2.4.3), not yanked onto a freshly-mounted button they did
    // not ask for; the relaunch is a quiet, always-reachable affordance, not a focus grab. Re-mounting the
    // fork uses the SAME deps, so a test's injected director (and production's default real one) carry over.
    showRelaunch(deps);
  }

  // The welcome actions. The TWO walk buttons are equal primaries, sized and centred as peers (tokens.css
  // .tour-fork-actions lays them out 2-up on a wide card and stacks them on a narrow one). Short, plain
  // labels ("Governance Tour" / "Engineering Tour"), no subtitle: the label carries the whole meaning. The
  // .btn base is a fixed-height, single-line, nowrap control; the primaries override height (auto, base
  // height as a floor), padding and white-space so a label that ever runs long wraps gracefully rather than
  // clipping, and both stay equal-height in the grid (align-items:stretch). box-sizing keeps the width honest
  // inside the grid track. forkButton is the single h("button") call site all the welcome actions share (one
  // action-census key), so the demoted "Free Explore" control below passes its own class and style through
  // the same helper rather than minting a second call site.
  const primaryStyle = ["display:flex", "align-items:center", "justify-content:center", "text-align:center", "pointer-events:auto", "width:100%", "height:auto", "min-height:var(--control-h)", "padding:var(--space-2) var(--space-3)", "white-space:normal", "box-sizing:border-box"];
  const forkButton = (opts: { cls: string; label: string; aria: string; data?: Record<string, string>; style?: string[]; onClick: () => void }): HTMLElement =>
    h(
      "button",
      { "data-dp": "lib-tour-persona-fork.button.fork-button",
        type: "button",
        class: opts.cls,
        "aria-label": opts.aria,
        ...(opts.data ? { dataset: opts.data } : {}),
        style: (opts.style ?? primaryStyle).join(";"),
        on: { click: opts.onClick },
      },
      opts.label,
    );
  const ctoButton = forkButton({ cls: "btn btn--primary", label: "Governance Tour", aria: "Governance Tour", data: { [START_ATTR]: "cto" }, onClick: () => choose("cto") });
  const engineerButton = forkButton({ cls: "btn btn--primary", label: "Engineering Tour", aria: "Engineering Tour", data: { [START_ATTR]: "engineer" }, onClick: () => choose("engineer") });

  // The "Free Explore" control: demoted from button chrome to a linklike control (still a real <button>,
  // still in the tab order, same accessible name), so the two walks read as THE choice and skipping reads as
  // the quiet way past it, not a third equal option. It dismisses the welcome to free-explore, so the tour is
  // never forced; Escape does the same, and both always work. It sits beneath the walk grid, on the row the
  // downpipes.io link right-aligns.
  const skipButton = forkButton({ cls: "linklike", label: "Free Explore", aria: "Free Explore", style: ["font-size:var(--text-sm)", "pointer-events:auto", "white-space:nowrap"], onClick: () => destroy() });

  const titleId = "tour-fork-title";
  const descId = "tour-fork-desc";
  const panel = h(
    "div",
    {
      role: "dialog",
      "aria-modal": "false",
      "aria-labelledby": titleId,
      "aria-describedby": descId,
      tabindex: "-1",
      style: [
        "position:relative",
        "box-sizing:border-box",
        "min-width:0",
        // Responsive width: a comfortable 480px on a wide screen, but never wider than 92vw, so the card never
        // spills past the viewport edge on a phone (92vw also dodges the desktop scrollbar gutter a 100vw-based
        // width would overflow). dvh (not vh) on the height so the mobile browser chrome does not eat the card;
        // overflow:auto keeps a tall card scrollable on a short viewport. Padding scales from a comfortable 16px
        // on phones up to 32px on desktop so the card is premium-spacious wide and not cramped narrow.
        "width:min(600px, 94vw)",
        "max-height:calc(100dvh - var(--space-6))",
        "overflow:auto",
        "display:flex",
        "flex-direction:column",
        "gap:var(--space-5)",
        "padding:clamp(var(--space-4), 5vw, var(--space-6))",
        "background:var(--surface-raised)",
        "color:var(--text)",
        "border:1px solid var(--border)",
        "border-radius:var(--radius-lg)",
        "box-shadow:var(--shadow-lg)",
        "font-family:var(--font-sans)",
        "pointer-events:auto",
        // No default outline: the ring is applied imperatively when focus moves into the panel below (a
        // programmatic focus does NOT match :focus-visible, so the global ring would never show on this centred,
        // target-less first screen), and cleared on blur. Without it a sighted keyboard user would get no visible
        // cue that focus landed in the fork.
      ].join(";"),
      // Clear the imperative focus ring when focus leaves the panel (the user tabbed to a choice button, or
      // away), so the ring shows ONLY while the panel itself holds focus.
      on: { blur: () => clearFocusRing(panel) },
    },
    // The heading group: a teal eyebrow, the welcome title, then exactly two short lines: what the tour is
    // (the walk, the sample data, no signup) and the free-edition promise. The first line is the dialog's
    // describedby target, so it must stay populated. The pitch paragraphs the card used to carry (source-type
    // counts, the pricing model) belong to the marketing site; the welcome earns the walk in two lines.
    h(
      "div",
      { style: ["display:flex", "flex-direction:column", "gap:var(--space-2)", "min-width:0"].join(";") },
      // --trust-fg, NOT --trust. tokens.css calls --t-500 "the verified dot/border tone" and gives --t-600 as
      // the "readable teal foreground", and this eyebrow is TEXT: --trust on the light panel is 4.14:1
      // against the 4.5:1 this size and weight require, where --trust-fg is
      // 6.14:1 there, and in dark BOTH resolve to --t-300d at 7.83:1, so this changes the light theme only.
      h("span", { style: ["font-size:var(--text-xs)", "font-weight:var(--weight-semibold)", "letter-spacing:var(--tracking-wide)", "color:var(--trust-fg)"].join(";") }, "Product tour"),
      h("h2", { id: titleId, style: ["margin:0", "font-size:var(--text-xl)", "font-weight:var(--weight-semibold)", "letter-spacing:var(--tracking-tight)", "color:var(--text)"].join(";") }, "Welcome to downpipes"),
      // THE LENGTH IS THE TOUR'S OWN ARITHMETIC, NOT A ROUND NUMBER. This line read "a guided
      // three-minute walk" until. The walks are ten chapters of 24 and 30 beats, and
      // director.ts already holds the product's own judgement of how long each beat needs to be read:
      // dwellForBody scales the hold to the prose length (MS_PER_CHAR, clamped between MIN_DWELL_MS
      // and MAX_DWELL_MS) plus STEP_GAP_MS between steps. Summed over the shipped scripts that is 5.6
      // minutes for the governance walk and 6.9 for the engineering one at 1x, so the card was
      // promising less than half of what the tour itself budgets. "Ten chapters" is the honest
      // measure and it is the one a visitor can check against the progress bar in front of them; the
      // pace stays theirs, because the walk is manual by default and Play is opt-in.
      h("p", { id: descId, style: ["margin:0", "max-width:min(48ch, 100%)", "font-size:var(--text-base)", "color:var(--text-muted)", "line-height:var(--leading-base)"].join(";") }, "A guided walk of ten chapters through the real console, at your own pace, on sample data for a fictional company. No signup, and it resets when you reload."),
      h("p", { style: ["margin:0", "max-width:min(48ch, 100%)", "font-size:var(--text-base)", "color:var(--text-muted)", "line-height:var(--leading-base)"].join(";") }, "Every feature you will see is in the free Community edition."),
    ),
    // The expectation line: the shape of the choice and how to leave. The length lives in the first body
    // line ("ten chapters"), so it is not repeated here; Esc is the standing exit promise.
    h("p", { style: ["margin:0", "font-size:var(--text-xs)", "font-weight:var(--weight-medium)", "color:var(--text-muted)", "letter-spacing:0.02em"].join(";") }, "Two curated paths · Esc leaves the tour at any time"),
    // The action zone: a hairline divider, then the two equal walk primaries laid out 2-up on a wide card and
    // stacked on a narrow one by .tour-fork-actions, then the demoted Free Explore control and the quiet
    // links beneath.
    h(
      "div",
      { style: ["display:flex", "flex-wrap:wrap", "align-items:center", "gap:var(--space-3)", "border-top:1px solid var(--border-subtle)", "padding-top:var(--space-4)"].join(";") },
      // The two walk actions in an equal grid so they are the SAME width and height regardless of their
      // (different-length) labels. .tour-fork-actions is 2 equal columns on a wide card and one column
      // (stacked) on a narrow one (tokens.css), so the choices are normal-width and centred, never a full-card
      // bar, and never clip off a phone. The demoted Free Explore control sits on the next flex row, outside
      // the grid, beside the right-aligned downpipes.io link.
      h("div", { class: "tour-fork-actions" }, ctoButton, engineerButton),
      skipButton,
      // The quiet way OUT to the marketing site for a visitor who landed on the tour cold and wants the
      // pitch before the product: a right-aligned text link, new tab so this welcome (and their place in
      // the demo) is never lost. The persistent corner "downpipes.io" button carries the same path once
      // the welcome is dismissed; both count server-side via ?src= like every other CTA.
      h(
        "a",
        {
          class: "linklike",
          href: "https://downpipes.io/?src=tour-welcome",
          target: "_blank",
          rel: "noopener noreferrer",
          "aria-label": "Learn more at downpipes.io (opens in a new tab)",
          style: ["margin-left:auto", "font-size:var(--text-sm)", "display:inline-flex", "align-items:center", "gap:var(--space-1)", "pointer-events:auto", "white-space:nowrap"].join(";"),
          on: { click: () => emit({ name: "cta_clicked", detail: "site-welcome" }) },
        },
        h("span", "downpipes.io"),
        h("span", { "aria-hidden": "true", style: "display:inline-flex" }, svgIcon(ICON_EXTERNAL, { size: 12 })),
      ),
      // The privacy pointer (GDPR/ePrivacy honesty at the point of entry): the tour is cookieless and
      // identifier-free, and the one-line policy that says so lives on the marketing site. A quiet
      // muted link, full width under the actions so the welcome stays calm.
      h(
        "a",
        {
          class: "linklike",
          href: "https://downpipes.io/cookies?src=tour-welcome",
          target: "_blank",
          rel: "noopener noreferrer",
          "aria-label": "Privacy and cookies (opens in a new tab)",
          style: ["flex-basis:100%", "font-size:var(--text-xs)", "color:var(--text-muted)", "pointer-events:auto"].join(";"),
        },
        "Privacy and cookies: no cookies, no identifier; first-party counts of anonymous steps and the campaign link that brought you here.",
      ),
    ),
    live,
  );

  // The hosting layer + the centred card. The redesign keeps the REAL console screen the star: the owner does
  // NOT want the booted Overview hidden behind the welcome, so this layer carries NO dim backdrop at all (it is
  // fully transparent), only positioning. It is pointer-TRANSPARENT, so the Overview behind it stays reachable to
  // EVERY input mode: the welcome is a labelled, non-trapping role=dialog (aria-modal=false), not a true modal,
  // so it must not block the pointer when it deliberately leaves the keyboard tab order and the screen-reader
  // cursor free to reach the app behind. The always-visible "Free Explore" control and Escape are the explicit
  // exits for all input modes; clicking the transparent area lands in the real, faked app behind, exactly as it
  // does for a keyboard or screen-reader user. The panel re-enables its own pointer events below, so the card
  // stays interactive while the surrounding layer is click-through.
  // The viewport width at mount, read once. Below 560px the card anchors as a bottom SHEET (align-items at the
  // flex-end of the layer) rather than vertically centred: a tall card centred on a short phone would scroll off
  // the top, whereas a sheet stays reachable at the thumb. Above it, the card is centred as a classic dialog.
  const vw = typeof window !== "undefined" && window.innerWidth ? window.innerWidth : 1280;
  const sheet = vw < 560;
  const card = h(
    "div",
    {
      id: FORK_ID,
      dataset: { tourPersonaFork: "true", frontLayer: "true" }, // data-front-layer: tokens.css lifts a confirm above this --z-palette layer
      style: [
        "position:fixed",
        "inset:0",
        "z-index:var(--z-palette)",
        "display:flex",
        sheet ? "align-items:flex-end" : "align-items:center",
        "justify-content:center",
        "padding:var(--space-4)",
        "pointer-events:none",
      ].join(";"),
    },
    panel,
  );

  // The scrim fades in and the card rises in, once on mount (CSP-safe, by NAME against the dp-fade-in / dp-rise
  // keyframes in tokens.css, never an inline @keyframes block). Gated on motionOK() so the in-app reduced-motion
  // opt-out is honoured (the CSS prefers-reduced-motion gate keys only on the OS setting; the JS gate is the one
  // that also respects the in-app toggle), exactly as every other tour transition is gated. Under reduced motion
  // both appear instantly, no animation property set.
  if (motionOK()) {
    card.style.setProperty("animation", "dp-fade-in var(--dur-fast) var(--ease-out)");
    panel.style.setProperty("animation", "dp-rise var(--dur) var(--ease-out)");
  }

  const body = doc.body;
  if (!body) {
    // Defensive: no body to mount into. Return a detached, inert handle (the fork is the tour's entry, never a
    // boot gate, so a missing body must not throw at boot).
    return { choose, destroy, root: card, get director(): TourDirector | null { return director; } };
  }
  body.appendChild(card);

  // The visitor reached the tour's first interaction: count tour_started once, on the real mount (after the
  // welcome is in the DOM, so a no-body defensive handle above does NOT count a start). Best-effort + behind
  // the flag inside emit(); never blocks the welcome.
  emit({ name: "tour_started" });

  // Remember where focus was BEFORE moving it into the card (the control the visitor opened the tour from), so
  // teardown can hand focus back rather than stranding a keyboard user at <body> when the card is removed. Never
  // the welcome's own chrome (it is gone after teardown), and only a real element (not <body>).
  const launchCandidate = doc.activeElement as HTMLElement | null;
  if (launchCandidate && launchCandidate !== doc.body && !launchCandidate.closest?.(`#${FORK_ID}`)) {
    launchEl = launchCandidate;
  }

  // Move focus into the card so keyboard + screen-reader users land on the welcome, and announce it.
  // applyFocusRing also shows a visible focus ring on the panel: this centred, target-less first screen paints
  // no spotlight ring, and a programmatic focus does not match :focus-visible, so without it a sighted keyboard
  // user would see no cue that focus moved in. The ring clears on blur (the user tabbing to an action button).
  if (typeof panel.focus === "function") panel.focus();
  applyFocusRing(panel);
  announce("Welcome to downpipes. This is a guided walk through the real console on sample data, with no signup. Take the tour as a CTO or as an engineer, or explore freely.");

  // The keyboard layer while the welcome is shown: Escape dismisses to free-explore. The action buttons are
  // ordinary focusable buttons (Tab + Enter/Space activate them through the native button semantics), so the
  // welcome only needs to add Escape; it never hijacks Tab or the buttons' own keys.
  wireKeys();

  function wireKeys(): void {
    if (keyHandler) return;
    keyHandler = (ev: KeyboardEvent): void => {
      if (destroyed) return;
      if (ev.key === "Escape") {
        ev.preventDefault();
        destroy();
      }
    };
    doc.addEventListener("keydown", keyHandler as EventListener);
  }

  function unwireKeys(): void {
    if (keyHandler) {
      doc.removeEventListener("keydown", keyHandler as EventListener);
      keyHandler = null;
    }
  }

  function announce(message: string): void {
    live.textContent = "";
    if (typeof setTimeout === "function") setTimeout(() => { live.textContent = message; }, 0);
    else live.textContent = message;
  }

  return { choose, destroy, root: card, get director(): TourDirector | null { return director; } };
}

// existingHandle wraps an already-mounted welcome in a fresh handle so a redundant mountPersonaFork() is a safe
// no-op that still lets the caller start/dismiss the live welcome. It cannot recover the original director
// reference (a fresh starter builds a new one), so choose() here starts a tour over a new director; in
// practice the launcher mounts the welcome exactly once, so this is the defensive double-mount path only.
function existingHandle(card: HTMLElement, makeDirector: (persona: TourPersona) => TourDirector): PersonaFork {
  let director: TourDirector | null = null;
  return {
    choose(persona: TourPersona): void {
      card.remove();
      director = makeDirector(persona);
      director.start();
    },
    destroy(): void {
      card.remove();
    },
    root: card,
    get director(): TourDirector | null { return director; },
  };
}

// showRelaunch mounts the persistent "Take the tour" affordance after the visitor explores freely (or presses
// Escape), so the guided narrative is never a one-way door: a visitor who skips to look around first can still
// enter it. It mirrors the director's Resume button (a single small, fixed, tokenised, keyboard reachable
// control) and re-mounts the welcome on click, carrying the SAME deps so a test's injected director (and
// production's default real one) are honoured. Idempotent: a second call returns the existing control rather
// than stacking a second. Docked bottom-RIGHT, the exact spot the director's Resume button uses: the two are
// mutually exclusive by construction (Resume exists only mid-tour, the relaunch only in free-explore), and the
// bottom-left corner belongs to the rail's pinned "Help and shortcuts" row, which the old placement sat on. A
// view with no body is a no-op (the relaunch is an affordance, never a gate).
function showRelaunch(deps: PersonaForkDeps): void {
  const doc = deps.doc ?? document;
  if (doc.getElementById(RELAUNCH_ID)) return;
  const body = doc.body;
  if (!body) return;
  const btn = h(
    "button",
    {
      type: "button",
      id: RELAUNCH_ID,
      class: "btn btn--primary",
      "aria-label": "Take the tour",
      style: [
        "position:fixed",
        "right:var(--space-4)",
        "bottom:var(--space-6)",
        "z-index:var(--z-tooltip)",
        "display:inline-flex",
        "align-items:center",
        "gap:var(--space-2)",
        "box-shadow:var(--shadow-lg)",
        "pointer-events:auto",
      ].join(";"),
      // Re-mount the welcome through the public launcher so activeFork is updated and exactly one welcome
      // exists. The relaunch removes itself first (mountPersonaFork also clears any stale relaunch on mount, so
      // this is a belt-and-braces no-op there) so it does not linger behind the re-shown welcome.
      on: { click: () => { hideRelaunch(doc); startTour(deps); } },
    },
    h("span", { "aria-hidden": "true", style: "display:inline-flex" }, svgIcon(ICON_PLAY, { size: 14 })),
    h("span", "Take the tour"),
  );
  body.appendChild(btn);
}

// hideRelaunch removes the relaunch affordance (when the welcome is (re-)shown, or the tour is started), so it
// is present ONLY while the visitor is in free-explore with the welcome down. A no-op when none is mounted.
function hideRelaunch(doc: Document): void {
  doc.getElementById(RELAUNCH_ID)?.remove();
}

// activeFork guards the public launcher against a double launch (two welcome cards). The tour is launched once
// per page load; a redundant startTour() returns the existing welcome's handle.
let activeFork: PersonaFork | null = null;

// startTour is the public entry the tour/demo flag path calls to begin the experience: it mounts the welcome
// card (the tour's first interaction). Starting the tour runs the guided script's director; exploring freely
// (or Escape) drops the welcome to free-explore. Idempotent: a redundant call returns the existing welcome
// rather than stacking a second. Returns the welcome handle so a launcher (or a test) can drive it. Best-effort
// by its caller: a mount fault must never block the no-login boot the faked backend stands up.
export function startTour(deps: PersonaForkDeps = {}): PersonaFork {
  if (activeFork && (deps.doc ?? document).getElementById(FORK_ID)) return activeFork;
  activeFork = mountPersonaFork(deps);
  return activeFork;
}
