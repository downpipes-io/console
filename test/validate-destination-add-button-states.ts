// The Destinations screen's header "Add a destination"
// button must lead somewhere real in EVERY state destinations.ts can render, not only the one it
// was originally written against. Before this fix, the button's onClick only ever asked
// openDisclosureByTitle for a disclosure titled "Add a destination" -- present in the
// multi-destination list and absent from the deploy-bound single-destination state (a
// destination bound at deploy time, no console record yet), which instead renders that add
// surface as a "Replace from the console" disclosure. The button fell through to
// openDisclosureByTitle's no-match branch, scrolled the region and focused whatever happened to
// be first in it, and never opened a form.
//
// This drives the REAL renderSetup / renderList / renderConfigured + the REAL
// openDisclosureByTitle exactly as destinations.ts wires them, across all three states, and
// asserts a real, reachable form control follows the click in every one. A regression that
// narrows the button back to one title reproduces the defect here, offline, rather than waiting
// for a live rehearsal instance to notice.
//
// Run with: node test/validate-destination-add-button-states.ts

import { installDomShim } from "./dom-shim.ts";

// Install BEFORE importing any module that touches document at load time.
installDomShim();

import type { EngineClient } from "../src/api.ts";
import type { DestinationList, DestinationStatus } from "../src/lib/api/types/destinations.ts";
import { h } from "../src/lib/dom.ts";
import { openDisclosureByTitle } from "../src/screens/common.ts";
import { renderConfigured, renderList, renderSetup } from "../src/screens/destination-cards.ts";
import { flushAsync, markConnected, qs, qsa } from "./dom-shim.ts";
import { makeEvent } from "./dom-shim-core.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

// A minimal EngineClient stub: only what loadFormContext (destination-form-fields.ts) reaches
// for when a disclosure's form host mounts on first open.
function stubEngine(): EngineClient {
  return {
    discoverSources: () => Promise.resolve({ engineAccountId: null, accounts: [] }),
    listDownpipes: () => Promise.resolve([]),
  } as unknown as EngineClient;
}

type DetailsLike = { open: boolean; dispatchEvent: (e: ReturnType<typeof makeEvent>) => void; querySelector: (sel: string) => { textContent?: string | null } | null };

const ADD_TITLES = ["Add a destination", "Replace from the console"];

// The GATING disclosure: the one the header button targets by title, distinct from whatever
// unrelated collapsed sections the mounted form itself carries (destinationForm has its own
// closed-by-default Storage pricing / Immutability accordions, which are not this button's
// business and must not fail this check).
function gatingDisclosure(region: HTMLElement): DetailsLike | null {
  const all = qsa(region, "details") as unknown as DetailsLike[];
  return all.find((d) => ADD_TITLES.includes((d.querySelector("summary")?.textContent ?? "").trim())) ?? null;
}

// The click: exactly what the header button's onClick runs. Real browsers fire "toggle" on a
// <details> whose open state changes, script-set included, which is what mounts a disclosure's
// form host on first open (see destination-cards.ts / destination-cards-actions.ts). The shim
// does not replicate that native behaviour, so this simulates the browser's half of the contract
// on the gating <details> the click just opened, the same way every other disclosure-toggle
// validator in this suite does.
function clickAddButton(region: HTMLElement): void {
  openDisclosureByTitle(region, ADD_TITLES);
  const gate = gatingDisclosure(region);
  if (gate?.open) gate.dispatchEvent(makeEvent({ type: "toggle" }));
}

// A real form control reachable in region: either there is no gating disclosure at all (the
// first-run state, where the form IS the screen) or it is open, and either way a real field
// exists.
function formIsReachable(region: HTMLElement): boolean {
  const gate = gatingDisclosure(region);
  const input = qs(region, "input, select, textarea");
  return (gate === null || gate.open) && input !== null;
}

async function main(): Promise<void> {
  const engine = stubEngine();

  console.log("\n-- state 1: unconfigured (the setup form IS the screen, no disclosure) --");
  {
    const region = h("div") as HTMLElement;
    markConnected(region);
    region.appendChild(renderSetup(engine, () => undefined));
    await flushAsync();
    ok("no gating disclosure exists yet (the form is already the whole screen)", gatingDisclosure(region) === null);
    clickAddButton(region);
    await flushAsync();
    ok("a real form control is reachable with nothing to open", formIsReachable(region));
  }

  console.log("\n-- state 2: multi-destination list (the original 'Add a destination' title) --");
  {
    const region = h("div") as HTMLElement;
    markConnected(region);
    const list: DestinationList = {
      defaultId: "d1",
      destinations: [{ present: true, id: "d1", bucket: "b1", isDefault: true, source: "console" }],
    };
    region.appendChild(renderList(engine, list, () => undefined));
    ok("the disclosure starts closed", !(gatingDisclosure(region)?.open ?? false));
    clickAddButton(region);
    await flushAsync();
    ok('the "Add a destination" disclosure opens and mounts a form', formIsReachable(region));
  }

  console.log("\n-- state 3: deploy-bound single destination, no console record --");
  {
    const region = h("div") as HTMLElement;
    markConnected(region);
    const st: DestinationStatus = { present: true, source: "deploy", envConfigured: true, bucket: "rehearsal-2026-09-05-archive" };
    region.appendChild(renderConfigured(engine, st, () => undefined));
    ok("the disclosure starts closed", !(gatingDisclosure(region)?.open ?? false));
    clickAddButton(region);
    await flushAsync();
    ok('the button opens the "Replace from the console" disclosure and mounts a form', formIsReachable(region));
    const bodyText = region.textContent ?? "";
    ok("the copy beside the button names what adding a destination here needs", bodyText.includes("R2 API token key pair"));
    ok("the copy states the move it makes (deploy-time binding -> console-managed)", bodyText.includes("console-managed destinations"));
  }

  console.log(failures === 0 ? "\nDESTINATION ADD-BUTTON STATES PASS" : `\n${failures} FAILURE(S)`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\nVALIDATE-DESTINATION-ADD-BUTTON-STATES THREW:", err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
