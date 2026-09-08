// Coverage validator for the parts of the guided-setup brain (src/lib/setup-state.ts) that the
// pure-function suite in test/validate-setup-state.ts does not reach: the async facts readers
// (fetchSetup / fetchSetupHealed and their fail-open and self-heal arms), the celebration flag
// (setupCelebrated / markSetupCelebrated and their storage-blocked catch arms), and the Overview
// checklist component (setupChecklistCard across its current/done markers, the three heading
// framings, the singular vs plural remaining-steps copy, and the Continue button click).
//
// It renders the REAL component under the shared DOM shim (test/dom-shim.ts), exactly as the other
// component validators do, and never edits that shared shim. fetchSetup / fetchSetupHealed only call
// two EngineClient methods (getSetupState / acknowledgeSetup), so a tiny typed double stands in for
// the client and lets every branch run without a network. Run with `node test/cov/lib-setup-state.ts`
// (the cov runner also invokes it).

import { installDomShim, qs, qsa, textOf, classesOf, installBlockedStorage, restoreMemoryStorage } from "../dom-shim.ts";

installDomShim();

import {
  deriveSetup,
  fetchSetup,
  fetchSetupHealed,
  setupCelebrated,
  markSetupCelebrated,
  setupChecklistCard,
} from "../../src/lib/setup-state.ts";
import type { SetupState } from "../../src/api.ts";
import type { EngineClient } from "../../src/api.ts";

let failures = 0;
function ok(name: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`);
  if (!cond) failures++;
}

// facts builds a complete SetupState from the all-false baseline, with the given overrides, so each
// derivation drives off real values rather than partials.
function facts(overrides: Partial<SetupState>): SetupState {
  return {
    keysReady: false,
    signerConfigured: false,
    breakGlassConfigured: false,
    emailConfigured: false,
    discoveryTokenPresent: false,
    accountsSelected: false,
    destination: { configured: false, verified: false, kind: null, source: null },
    boundSourceCount: 0,
    downpipeCount: 0,
    anyRunCompleted: false,
    ready: false,
    ...overrides,
  };
}

// A minimal EngineClient double: fetchSetup / fetchSetupHealed touch only getSetupState and
// acknowledgeSetup, so a recording stub of just those two stands in for the whole transport. opts
// drives each arm: a thrown getSetupState (the unreachable-engine path), the acknowledge outcome,
// and a thrown acknowledge (the best-effort catch).
interface StubOpts {
  state?: SetupState;
  getThrows?: boolean;
  // ackOk is the { ok } acknowledgeSetup resolves to; ackThrows makes it reject instead.
  ackOk?: boolean;
  ackThrows?: boolean;
  // healedState, when set, is what a SECOND getSetupState returns (the post-acknowledge refetch),
  // so the heal can be observed to swap in a healthier view.
  healedState?: SetupState;
}
function stubEngine(opts: StubOpts): { engine: EngineClient; getCalls: number; ackCalls: number } {
  const counters = { getCalls: 0, ackCalls: 0 };
  const engine = {
    async getSetupState(): Promise<SetupState> {
      counters.getCalls += 1;
      if (opts.getThrows) throw new Error("engine unreachable");
      if (counters.getCalls >= 2 && opts.healedState) return opts.healedState;
      return opts.state ?? facts({});
    },
    async acknowledgeSetup(): Promise<{ ok: boolean }> {
      counters.ackCalls += 1;
      if (opts.ackThrows) throw new Error("acknowledge failed");
      return { ok: opts.ackOk ?? false };
    },
  } as unknown as EngineClient;
  return {
    engine,
    get getCalls() {
      return counters.getCalls;
    },
    get ackCalls() {
      return counters.ackCalls;
    },
  } as { engine: EngineClient; getCalls: number; ackCalls: number };
}

async function main(): Promise<void> {
  // ========================================================================
  console.log("\n-- fetchSetup: success derives the view; any throw is fail-open null --");
  // ========================================================================
  {
    const done = facts({
      keysReady: true,
      discoveryTokenPresent: true,
      destination: { configured: true, verified: true, kind: "s3", source: "console" },
      boundSourceCount: 1,
      downpipeCount: 1,
    });
    const s = stubEngine({ state: done });
    const view = await fetchSetup(s.engine);
    ok("fetchSetup returns a derived view on a successful read", view !== null && view.complete === true);
    ok("fetchSetup read the facts exactly once", s.getCalls === 1);

    // The endpoint absent / engine unreachable arm: getSetupState throws, so fetchSetup returns null
    // (the caller treats unknown as no gating, the fail-open contract).
    const bad = stubEngine({ getThrows: true });
    const none = await fetchSetup(bad.engine);
    ok("fetchSetup returns null when the read throws (fail-open)", none === null);
  }

  // ========================================================================
  console.log("\n-- fetchSetupHealed: passthrough, complete, the self-heal arms --");
  // ========================================================================
  {
    // A null underlying view (engine unreachable) passes straight through as null, no acknowledge.
    const bad = stubEngine({ getThrows: true });
    const none = await fetchSetupHealed(bad.engine);
    ok("fetchSetupHealed returns null when fetchSetup is null", none === null);
    ok("fetchSetupHealed does not acknowledge when the view is null", bad.ackCalls === 0);

    // A complete view passes straight through, no acknowledge (nothing to heal).
    const completeFacts = facts({
      keysReady: true,
      discoveryTokenPresent: true,
      destination: { configured: true, verified: true, kind: "s3", source: "console" },
      boundSourceCount: 1,
      downpipeCount: 1,
    });
    const cs = stubEngine({ state: completeFacts });
    const cv = await fetchSetupHealed(cs.engine);
    ok("fetchSetupHealed returns the complete view unchanged", cv !== null && cv.complete === true);
    ok("fetchSetupHealed does not acknowledge a complete view", cs.ackCalls === 0);

    // keys ALREADY done but setup incomplete (the destination comes next now): the keys step reads
    // done, so the !keysStep.done guard is false and no acknowledge is attempted.
    const keysDoneFacts = facts({ keysReady: true });
    const ks = stubEngine({ state: keysDoneFacts });
    const kv = await fetchSetupHealed(ks.engine);
    ok("fetchSetupHealed leaves a keys-done incomplete view untouched", kv !== null && kv.current.id === "destination");
    ok("fetchSetupHealed does not acknowledge when the keys step is already done", ks.ackCalls === 0);

    // keys NOT done + acknowledge clears something: the heal refetches and returns the healed view.
    const stuckFacts = facts({}); // keys not ready -> the "stuck marker" case
    const healed = facts({
      keysReady: true,
      discoveryTokenPresent: true,
      destination: { configured: true, verified: true, kind: "s3", source: "console" },
      boundSourceCount: 1,
      downpipeCount: 1,
    });
    const hs = stubEngine({ state: stuckFacts, ackOk: true, healedState: healed });
    const hv = await fetchSetupHealed(hs.engine);
    ok("fetchSetupHealed acknowledges when the keys step reads not-done", hs.ackCalls === 1);
    ok("an acknowledge that cleared the marker refetches the now-healthy view", hv !== null && hv.complete === true);
    ok("the heal refetched (two getSetupState reads)", hs.getCalls === 2);

    // keys NOT done but acknowledge is a no-op (ok:false, a genuinely keyless engine): keep the
    // original view, do NOT refetch.
    const noopFacts = facts({});
    const ns = stubEngine({ state: noopFacts, ackOk: false });
    const nv = await fetchSetupHealed(ns.engine);
    ok("a no-op acknowledge keeps the original view", nv !== null && nv.current.id === "keys");
    ok("a no-op acknowledge does not refetch (one read)", ns.getCalls === 1);

    // keys NOT done and acknowledge THROWS: best-effort, the original view is kept (the catch arm).
    const throwFacts = facts({});
    const ts = stubEngine({ state: throwFacts, ackThrows: true });
    const tv = await fetchSetupHealed(ts.engine);
    ok("an acknowledge that throws falls back to the original view (best-effort catch)", tv !== null && tv.current.id === "keys");
    ok("an acknowledge that throws does not refetch", ts.getCalls === 1);
  }

  // ========================================================================
  console.log("\n-- setupCelebrated / markSetupCelebrated: persisted flag + storage-blocked catch arms --");
  // ========================================================================
  {
    // A fresh in-memory store reads the flag as unset, mark persists it, the next read sees "1".
    restoreMemoryStorage();
    ok("the celebrated flag starts unset", setupCelebrated() === false);
    markSetupCelebrated();
    ok("markSetupCelebrated persists the flag (next read is true)", setupCelebrated() === true);

    // Storage unavailable: setupCelebrated swallows the read failure and returns true (never nag),
    // and markSetupCelebrated swallows the write failure without throwing.
    installBlockedStorage();
    ok("setupCelebrated returns true when storage read throws (never nag)", setupCelebrated() === true);
    let markThrew = false;
    try {
      markSetupCelebrated();
    } catch {
      markThrew = true;
    }
    ok("markSetupCelebrated swallows a blocked-storage write", markThrew === false);
    restoreMemoryStorage();
  }

  // ========================================================================
  console.log("\n-- setupChecklistCard: a fresh (keys-current) console --");
  // ========================================================================
  {
    const view = deriveSetup(facts({})); // nothing done -> keys is current, step 1 of 5
    const navTo: string[] = [];
    const card = setupChecklistCard(view, (to) => navTo.push(to));

    // The returned element IS the section.card (querySelector walks descendants, so the root is read
    // directly), carrying the from-scratch aria-label.
    ok("the card root is a section.card", card.tagName === "SECTION" && classesOf(card).includes("card"));
    ok("the heading is the from-scratch framing", textOf(qs(card, ".card__title")!) === "Set up your backups");
    ok("the description counts the done steps (0 of 5)", textOf(qs(card, ".card__desc")!).includes("0 of 5 steps done"));
    ok("the section aria-label is the from-scratch label", card.getAttribute("aria-label") === "Set up your backups");

    // Five list items, the first (keys) is the current one: its marker carries the --current class,
    // shows the 1-based number (not a tick), and its label and hint render the current styling.
    const items = qsa(card, ".setup-check__item");
    ok("the checklist renders five items", items.length === 5);
    const firstMark = qs(items[0]!, ".setup-check__mark");
    ok("the current step's marker shows its number, not a tick", textOf(firstMark!) === "1");
    ok("the current step's marker carries the --current modifier", firstMark!.classList.contains("setup-check__mark--current"));
    ok("the current step's label carries the --current modifier", qs(items[0]!, ".setup-check__label--current") !== null);
    ok("the current step renders its hint (only the current step does)", qs(items[0]!, ".field__hint") !== null);
    // A non-current, not-yet-done step shows a plain number marker and no hint.
    const secondMark = qs(items[1]!, ".setup-check__mark");
    ok("a non-current pending step's marker is a plain number", textOf(secondMark!) === "2" && !secondMark!.classList.contains("setup-check__mark--current"));
    ok("a non-current step renders no hint", qs(items[1]!, ".field__hint") === null);

    // The single action is Continue + the current step label, and clicking it navigates to its route.
    const btn = qs(card, "button.btn--primary")!;
    ok("the button reads Continue + the current step label", textOf(btn) === "Continue: Create your keys");
    btn.click();
    ok("clicking Continue navigates to the current step route", navTo.length === 1 && navTo[0] === view.current.route);
  }

  // ========================================================================
  console.log("\n-- setupChecklistCard: keys done reframes to 'console is set up' (plural + singular) --");
  // ========================================================================
  {
    // keys done, three steps remaining (connect/destination/sources/downpipe minus keys = 4 remaining
    // when only keys is done): the heading celebrates the console, the desc uses the plural "steps",
    // and the first item now shows a tick with a visually-hidden "(done)".
    const view = deriveSetup(facts({ keysReady: true }));
    const card = setupChecklistCard(view, () => {});
    ok("keys done reframes the heading to 'Your console is set up'", textOf(qs(card, ".card__title")!) === "Your console is set up");
    const desc = textOf(qs(card, ".card__desc")!);
    ok("the keys-done description frames remaining work as connecting backups", desc.includes("Your keys are in place"));
    ok("the keys-done description pluralises multiple remaining steps", desc.includes("steps to your first backup"));
    const doneMark = qs(qsa(card, ".setup-check__item")[0]!, ".setup-check__mark--done");
    ok("a done step shows the done tick marker", doneMark !== null && textOf(doneMark!) === "✓");
    ok("a done step carries a visually-hidden (done) note", qs(qsa(card, ".setup-check__item")[0]!, ".visually-hidden") !== null);

    // Exactly ONE step remaining drives the singular "step" copy: everything done bar the last
    // (downpipe) step, with downpipeCount present and zero.
    const oneLeft = deriveSetup(
      facts({
        keysReady: true,
        discoveryTokenPresent: true,
        destination: { configured: true, verified: true, kind: "s3", source: "console" },
        boundSourceCount: 1,
        downpipeCount: 0,
      }),
    );
    const cardOne = setupChecklistCard(oneLeft, () => {});
    const descOne = textOf(qs(cardOne, ".card__desc")!);
    ok("a single remaining step uses the singular 'step' copy", descOne.includes("1 step to your first backup") && !descOne.includes("1 steps"));
    // The aria-label when keys are done but setup is incomplete is the connect-your-backups label.
    ok("the keys-done incomplete card aria-label is 'Connect your backups'", cardOne.getAttribute("aria-label") === "Connect your backups");
  }

  // ========================================================================
  console.log("\n-- setupChecklistCard: complete card celebrates and opens Downpipes --");
  // ========================================================================
  {
    const view = deriveSetup(
      facts({
        keysReady: true,
        discoveryTokenPresent: true,
        destination: { configured: true, verified: true, kind: "s3", source: "console" },
        boundSourceCount: 1,
        downpipeCount: 1,
      }),
    );
    const navTo: string[] = [];
    const card = setupChecklistCard(view, (to) => navTo.push(to));
    ok("a complete card celebrates with 'Your backups are set up'", textOf(qs(card, ".card__title")!) === "Your backups are set up");
    ok("a complete card describes every step as done", textOf(qs(card, ".card__desc")!) === "Every step is done.");
    ok("a complete card aria-label is the from-scratch label (not the connect label)", card.getAttribute("aria-label") === "Set up your backups");
    // When complete no step is the current one, so every marker is a done tick (no --current marker).
    ok("a complete card has no current marker", qs(card, ".setup-check__mark--current") === null);
    ok("a complete card marks every step done", qsa(card, ".setup-check__mark--done").length === 5);
    const btn = qs(card, "button.btn--primary")!;
    ok("a complete card's button reads 'Open Downpipes'", textOf(btn) === "Open Downpipes");
    btn.click();
    ok("the complete card's button navigates to the current (last) step route", navTo.length === 1 && navTo[0] === view.current.route);
  }

  if (failures > 0) process.exitCode = 1;

  if (failures > 0) {
    console.error(`\n${failures} FAILURE(S)`);
    process.exit(1);
  }
  console.log("\nSETUP-STATE COVERAGE VECTORS PASS");
}

void main();
