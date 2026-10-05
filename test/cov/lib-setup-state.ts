// Coverage validator for the parts of the shell's setup reading that the step-model suite in
// test/validate-setup-state.ts does not reach: the shell read (src/lib/setup-read.ts readSetupView and
// readSetupViewHealed, with their fail-open and self-heal arms), the shell's current-view holder
// (src/lib/setup-state.ts setLastSetupView / lastSetupView / setupIncomplete), the celebration flag
// (setupCelebrated / markSetupCelebrated and their storage-blocked catch arms), and Overview's not-set-up
// card (src/screens/overview/setup-card.ts setupProgressCard and setupSubtitle across a fresh console, keys
// in place, a non-owner's hand-off and a complete setup, and the button click).
//
// It renders the REAL component under the shared DOM shim (test/dom-shim.ts), exactly as the other
// component validators do. The shell read goes through the setup model's own engine calls, so a small
// routed fetch stands in for the engine. Run with `node test/cov/lib-setup-state.ts` (the cov runner also
// invokes it).

import { installDomShim, qs, qsa, textOf, classesOf, installBlockedStorage, restoreMemoryStorage } from "../dom-shim.ts";

installDomShim();

import { setupCelebrated, markSetupCelebrated, setLastSetupView, lastSetupView, setupIncomplete, setupViewOf, type SetupView } from "../../src/lib/setup-state.ts";
import { readSetupView, readSetupViewHealed } from "../../src/lib/setup-read.ts";
import { setupModel } from "../../src/lib/setup-flow/model.ts";
import { setupProgressCard, setupSubtitle } from "../../src/screens/overview/setup-card.ts";
import { connect, getEngine } from "../../src/lib/store.ts";
import type { Caller, SetupState } from "../../src/api.ts";

import { verdictReached } from "../lib/verdict-guard.ts"; // ARMS the completion guard
let failures = 0;
function ok(name: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`);
  if (!cond) failures++;
}

// facts builds a complete SetupState from the all-false baseline, with the given overrides.
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

// engine stands in for the admin API the shell read reaches: GET /admin/setup-state (a sequence, so a heal
// can be observed to swap in a healthier answer), GET /admin/downpipes, and POST /admin/setup/acknowledge.
interface EngineOpts {
  states?: SetupState[];
  stateThrows?: boolean;
  downpipes?: unknown[];
  ackOk?: boolean;
  ackThrows?: boolean;
}
function engine(opts: EngineOpts): { reads: () => number; acks: () => number } {
  let reads = 0;
  let acks = 0;
  const json = (v: unknown, status = 200): Response => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const p = new URL(String(input)).pathname;
    if (p === "/admin/setup/acknowledge" && init?.method === "POST") {
      acks++;
      if (opts.ackThrows) throw new TypeError("failed to fetch");
      return json({ ok: opts.ackOk ?? false });
    }
    if (p === "/admin/setup-state") {
      reads++;
      if (opts.stateThrows) return json({ error: "boom" }, 500);
      const list = opts.states ?? [facts({})];
      return json(list[Math.min(reads - 1, list.length - 1)]);
    }
    if (p === "/admin/downpipes") return json(opts.downpipes ?? []);
    return json({});
  }) as typeof fetch;
  if (!getEngine()) connect("https://engine.example.com");
  setupModel().reset();
  return { reads: () => reads, acks: () => acks };
}

const SEALED_DOWNPIPE = { config: { id: "dp-1", name: "ledger", cadenceSeconds: 86400, enabled: true, source: { type: "kv", binding: "SRC_KV_A" } }, nextRunAt: 0, lastRunId: "r1", inFlight: false, integrityVerified: { at: 1_700_000_000_000, how: "run" } };
const DONE = facts({ keysReady: true, discoveryTokenPresent: true, destination: { configured: true, verified: true, kind: "s3", source: "console" }, boundSourceCount: 1, downpipeCount: 1, anyRunCompleted: true });

async function main(): Promise<void> {
  // The shell's setup model lives as long as the page, and once it reads setup complete it stays complete
  // (lib/setup-flow/model.ts completeSeen). So every read that must come back incomplete runs before the first
  // complete one, and the complete reads are the last section.

  // ========================================================================
  console.log("\n-- readSetupView: a successful read yields the shell's view; a failed read is fail-open null --");
  // ========================================================================
  {
    const e = engine({ states: [facts({})] });
    const view = await readSetupView();
    ok("a fresh engine reads incomplete", view !== null && view.complete === false);
    ok("the shell read reads setup-state once", e.reads() === 1);
    ok("and records the view for the gate and the palette", lastSetupView() === view && setupIncomplete());

    engine({ stateThrows: true });
    const none = await readSetupView();
    ok("a setup-state read that fails is null (the caller treats unknown as no gating)", none === null);
    ok("and the recorded view is cleared, so nothing gates on a stale verdict", lastSetupView() === null && !setupIncomplete());
  }

  // ========================================================================
  console.log("\n-- readSetupViewHealed: passthrough, complete, the self-heal arms --");
  // ========================================================================
  {
    const bad = engine({ stateThrows: true });
    ok("a null view passes straight through", (await readSetupViewHealed(getEngine()!)) === null);
    ok("with no acknowledge", bad.acks() === 0);

    const keysDone = engine({ states: [facts({ keysReady: true })] });
    const kv = await readSetupViewHealed(getEngine()!);
    ok("keys already reported: the view is left alone", kv !== null && kv.steps.find((s) => s.id === "keys")?.done === true);
    ok("and nothing is acknowledged", keysDone.acks() === 0);

    // The demo engine's stuck first-run marker: keys reported absent, an acknowledge that clears something,
    // and the re-read that follows shows them.
    const healed = engine({ states: [facts({}), facts({ keysReady: true })], ackOk: true });
    const hv = await readSetupViewHealed(getEngine()!);
    ok("keys reported absent: the engine is asked to acknowledge", healed.acks() === 1);
    ok("an acknowledge that cleared the marker re-reads and returns the healthier view", hv?.steps.find((s) => s.id === "keys")?.done === true && healed.reads() === 2);

    const noop = engine({ states: [facts({})], ackOk: false });
    const nv = await readSetupViewHealed(getEngine()!);
    ok("a no-op acknowledge (a keyless engine) keeps the first view", nv?.current.id === "connect" && noop.reads() === 1);

    const threw = engine({ states: [facts({})], ackThrows: true });
    const tv = await readSetupViewHealed(getEngine()!);
    ok("an acknowledge that throws keeps the first view (best-effort)", tv?.current.id === "connect" && threw.reads() === 1);
  }

  // ========================================================================
  console.log("\n-- setupCelebrated / markSetupCelebrated: persisted flag + storage-blocked catch arms --");
  // ========================================================================
  {
    restoreMemoryStorage();
    ok("the celebrated flag starts unset", setupCelebrated() === false);
    markSetupCelebrated();
    ok("markSetupCelebrated persists the flag (next read is true)", setupCelebrated() === true);
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
  console.log("\n-- setupProgressCard: a fresh console, an Owner --");
  // ========================================================================
  const OWNER = { method: "passkey", email: "o@example.com", role: "owner", groups: [], isOnlyOwner: false } as unknown as Caller;
  const VIEWER = { method: "passkey", email: "v@example.com", role: "viewer", groups: [], isOnlyOwner: false } as unknown as Caller;
  const viewFor = async (state: SetupState, downpipes: unknown[] = []): Promise<SetupView> => {
    engine({ states: [state], downpipes });
    return (await readSetupView())!;
  };
  {
    const view = await viewFor(facts({}));
    const navTo: string[] = [];
    const card = setupProgressCard(view, OWNER, (to) => navTo.push(to));
    ok("the card root is a section.card", card.tagName === "SECTION" && classesOf(card).includes("card"));
    ok("the heading invites the first backup", textOf(qs(card, ".card__title")!) === "Set up your first backup");
    ok("the description counts the done steps and names the next one", textOf(qs(card, ".card__desc")!) === "0 of 7 steps done. Next is Connect. Setup continues where you stopped.");
    const items = qsa(card, ".setup-check__item");
    ok("the card lists the seven numbered steps", items.length === 7);
    const first = qs(items[0]!, ".setup-check__mark")!;
    ok("the current step's marker shows its number and the --current modifier", textOf(first) === "1" && first.classList.contains("setup-check__mark--current"));
    ok("the current step is aria-current=step", items[0]!.getAttribute("aria-current") === "step");
    ok("a later step's marker is a plain number", textOf(qs(items[1]!, ".setup-check__mark")!) === "2" && !qs(items[1]!, ".setup-check__mark")!.classList.contains("setup-check__mark--current"));
    const btn = qs(card, "button.btn--primary")!;
    ok("the one action is Continue setup", textOf(btn) === "Continue setup");
    btn.click();
    ok("it opens the setup surface, which resumes at the first open question", navTo.length === 1 && navTo[0] === "/setup");
    ok("the subtitle says backups are not running yet", setupSubtitle(view) === "Backups are not running yet. Setup gets you there.");
  }

  // ========================================================================
  console.log("\n-- setupProgressCard: keys in place, and a non-owner's hand-off --");
  // ========================================================================
  {
    const view = await viewFor(facts({ keysReady: true }));
    ok("once the keys are in, the subtitle reads as progress", setupSubtitle(view).startsWith("Your keys are in place."));
    const card = setupProgressCard(view, OWNER, () => {});
    // Keys is step 4 of 7; with the keys in and nothing picked there is nothing to attach, so Apply reads done too.
    const keysItem = qsa(card, ".setup-check__item")[3]!;
    const doneMark = qs(keysItem, ".setup-check__mark--done");
    ok("the Keys step shows the tick, with a visually-hidden (done) note", doneMark !== null && textOf(doneMark) === "✓" && qs(keysItem, ".visually-hidden") !== null);
    ok("a step not done keeps its number", textOf(qs(qsa(card, ".setup-check__item")[0]!, ".setup-check__mark")!) === "1");
    const fresh = await viewFor(facts({}));
    const handoff = setupProgressCard(fresh, VIEWER, () => {});
    ok("a non-owner looking at an Owner step reads an honest hand-off", textOf(qs(handoff, ".card__desc")!).includes("An Owner does this step."));
    ok("and the action says View setup, not Continue", textOf(qs(handoff, "button.btn--primary")!) === "View setup");
    const nullCaller = setupProgressCard(fresh, null, () => {});
    ok("an unresolved caller is not told it lacks a role", textOf(qs(nullCaller, "button.btn--primary")!) === "Continue setup");
  }

  // ========================================================================
  console.log("\n-- complete: the shell read, the heal passthrough, and no re-lock for the page's life --");
  // ========================================================================
  {
    const e = engine({ states: [DONE], downpipes: [SEALED_DOWNPIPE] });
    const view = await readSetupView();
    ok("a sealed estate reads complete", view !== null && view.complete === true);
    ok("the shell read reads setup-state once", e.reads() === 1);
    ok("and records the view for the gate and the palette", lastSetupView() === view && !setupIncomplete());

    const complete = engine({ states: [DONE], downpipes: [SEALED_DOWNPIPE] });
    const cv = await readSetupViewHealed(getEngine()!);
    ok("a complete view passes through unchanged", cv?.complete === true);
    ok("with no acknowledge (nothing to heal)", complete.acks() === 0);

    // The same page then reads an engine with nothing set up (its downpipes deleted, its keys gone): the shell
    // stays complete, so nothing it unlocked locks again.
    engine({ states: [facts({})], downpipes: [] });
    const later = await readSetupView();
    ok("a later read of an engine with nothing set up still reads complete in this page", later?.complete === true && !setupIncomplete());
  }

  // ========================================================================
  console.log("\n-- setupProgressCard: complete, and the view holder --");
  // ========================================================================
  {
    const view = await viewFor(DONE, [SEALED_DOWNPIPE]);
    const navTo: string[] = [];
    const card = setupProgressCard(view, OWNER, (to) => navTo.push(to));
    ok("a complete card says so", textOf(qs(card, ".card__title")!) === "Setup is complete");
    ok("with no current marker", qs(card, ".setup-check__mark--current") === null);
    const btn = qs(card, "button.btn--primary")!;
    ok("and opens Downpipes", textOf(btn) === "Open Downpipes");
    btn.click();
    ok("navigating to /downpipes", navTo[0] === "/downpipes");
    setLastSetupView(null);
    ok("setLastSetupView(null) clears the holder", lastSetupView() === null && !setupIncomplete());
    const snapView = setupViewOf(setupModel().get());
    setLastSetupView(snapView);
    ok("the holder keeps what it is given", lastSetupView() === snapView);
  }

  verdictReached(failures);

  if (failures > 0) {
    console.error(`\n${failures} FAILURE(S)`);
    process.exit(1);
  }
  console.log("\nSETUP-STATE COVERAGE VECTORS PASS");
}

void main();
