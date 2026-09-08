// The custom-role builder screen's catalogue-load fault must tell "not wired" apart from "broken".
//
// rolesBuilderScreen loads GET /admin/custom-roles to seed the existing-roles catalogue. A genuine 500
// (the engine live and broken) or a network abort (unreachable) must render an honest block error with
// Retry; only a genuine not-wired build (404/501) keeps the pending-engine note.
//
// This drives the REAL screen under the shared DOM shim, exactly like validate-config-changes drives the
// config inbox: a stubbed listCustomRoles rejection per status class, then asserts what the region renders.
//
// Run: node test/validate-roles-builder-load.ts

import { installDomShim, textOf, flushAsync, type ShimNode } from "./dom-shim.ts";

installDomShim();

const screenMod = await import("../src/screens/roles-builder.ts");
const store = await import("../src/lib/store.ts");
const nav = await import("../src/lib/nav.ts");
import { saveRow } from "../src/screens/roles-builder/preview.ts";
import { emptyBuilderState, type BuilderState } from "../src/screens/roles-builder.ts";
import { ROLE_CAPABILITIES, type Capability, type SurfaceMode } from "../src/lib/identity.ts";
import type { Caller, EngineClient } from "../src/api.ts";

nav.installNav({ navigate: () => {}, onUnauthorised: () => {}, refreshIdentity: async () => {}, onAuthenticated: async () => {}, signOut: () => {} });

let failures = 0;
function ok(name: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`);
  if (!cond) failures++;
}

// Render the builder screen for an access.policy holder (owner) whose listCustomRoles rejects with `err`.
async function renderWithLoadError(err: Error): Promise<ShimNode> {
  const c: Caller = { method: "access", email: "owner@example.com", role: "owner", groups: [], isOnlyOwner: false };
  store.setCaller(c);
  store.connect("https://engine.test");
  const engine = store.getEngine()!;
  (engine as unknown as { listCustomRoles: () => Promise<unknown[]> }).listCustomRoles = async () => { throw err; };
  const root = screenMod.rolesBuilderScreen.render({
    pattern: "/access/roles/builder", params: {}, query: new URLSearchParams(), path: "/access/roles/builder",
    engine, caller: c, navigate: () => {},
  }) as unknown as ShimNode;
  await flushAsync();
  return root;
}

const PENDING_MARKER = "could not load";        // the pendingEngineNote copy
const RETRY_MARKER = "Retry";                    // blockError's Retry affordance

async function main(): Promise<void> {
  console.log("-- a genuine fault renders the honest block error, not the pending note --");
  {
    // A 500: the engine is live and BROKEN. The catalogue was not read, so this must be a block error with
    // Retry, never the "pending the engine" note that reads as an unbuilt feature.
    const root = await renderWithLoadError(new Error("list custom roles: 500"));
    const txt = textOf(root);
    ok("a 500 renders a block error", txt.includes("engine") && root.querySelectorAll("button").some((b) => (b.textContent ?? "").includes(RETRY_MARKER)));
    ok("a 500 does NOT show the pending-engine 'could not load ... compose below' note", !txt.includes(PENDING_MARKER));
  }
  {
    // A network abort (no status): unreachable, again a real fault, not a pending feature.
    const root = await renderWithLoadError(new TypeError("Failed to fetch"));
    const txt = textOf(root);
    ok("a network abort renders a block error with Retry", root.querySelectorAll("button").some((b) => (b.textContent ?? "").includes(RETRY_MARKER)));
    ok("a network abort does NOT show the pending-engine note", !txt.includes(PENDING_MARKER));
  }

  console.log("-- a genuinely not-wired endpoint keeps the honest pending note (unchanged) --");
  {
    // A 404: the custom-role endpoint is genuinely not wired. Composing over an empty catalogue is the right
    // interim, so the pending-engine note stands and the builder body renders below it (no block error).
    const root = await renderWithLoadError(new Error("list custom roles: 404"));
    const txt = textOf(root);
    ok("a 404 shows the pending-engine note", txt.includes(PENDING_MARKER));
    ok("a 404 does NOT render a block-error Retry (the feature is honestly not built yet)", !root.querySelectorAll("button").some((b) => (b.textContent ?? "").includes(RETRY_MARKER)));
    ok("a 404 still renders the builder below the note (compose and preview stays available)", txt.includes("compose and preview") || txt.includes("Compose"));
  }
  {
    // A 501: same not-wired class as 404.
    const root = await renderWithLoadError(new Error("list custom roles: 501"));
    ok("a 501 shows the pending-engine note (not-wired class)", textOf(root).includes(PENDING_MARKER));
  }

  console.log("-- the custom-role Save button disables before the create await (no double-fire) --");
  {
    // A valid FRESH-CREATE composition (the kv-restorer recipe validateCustomRole accepts) with a name NOT in
    // the existing catalogue. A createCustomRole we hold pending lets us inspect the button WHILE the create
    // is in flight: the guard is the disabled state set before the await, so a double-click cannot double-fire it.
    const state: BuilderState = emptyBuilderState();
    state.name = "qa-viewer";
    state.label = "QA viewer";
    state.capabilities = new Set<Capability>(["restore.dryrun", "restore.apply", "restore.approve", "audit.read", "downpipe.read"]);
    state.surface = new Map<string, SurfaceMode>([["restore", "edit"], ["approvals", "edit"], ["audit", "read"], ["downpipes", "hidden"], ["people", "hidden"]]);
    state.presentation = "shiny";
    state.landing = "restore";

    let calls = 0;
    let releaseCreate: (v: { status: "applied"; value: { label: string } }) => void = () => {};
    const engine = { createCustomRole: () => { calls++; return new Promise((res) => { releaseCreate = res; }); } } as unknown as EngineClient;
    const row = saveRow(engine, state, ROLE_CAPABILITIES.owner, new Set<string>(), () => {}) as unknown as ShimNode;
    const saveBtn = row.querySelectorAll("button").find((b) => (b.textContent ?? "").includes("Save custom role")) as unknown as { click: () => void; disabled: boolean } | undefined;
    ok("the save button renders", saveBtn !== undefined);
    saveBtn?.click();
    await flushAsync();
    ok("one click fires exactly one createCustomRole", calls === 1);
    ok("the save button is DISABLED while the create is in flight (a second click cannot double-fire)", saveBtn?.disabled === true);
    releaseCreate({ status: "applied", value: { label: "QA viewer" } });
    await flushAsync();
  }

  console.log(failures === 0 ? "\nROLES-BUILDER LOAD VECTORS PASS" : `\n${failures} FAILURE(S)`);
  if (failures > 0) process.exitCode = 1;
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
