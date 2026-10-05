// B37: the custom-role builder screen's catalogue-load fault renders the block error with Retry.
//
// rolesBuilderScreen loads GET /admin/custom-roles to seed the existing-roles catalogue. Every released
// engine serves that route, so any failure (a 404, a 500 or a network abort) means the catalogue was not
// read: the screen renders the block error with Retry, never a note that frames it as an unbuilt feature.
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
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

nav.installNav({ navigate: () => {}, onUnauthorised: () => {}, refreshIdentity: async () => {}, onAuthenticated: async () => {}, signOut: () => {} });

let failures = 0;
function ok(name: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`);
  if (!cond) failures++;
}

// Render the builder screen for an access.policy holder (owner) whose listCustomRoles rejects with `err`.
async function renderWithLoadError(err: Error): Promise<ShimNode> {
  return renderWithLoad(async () => { throw err; });
}

// Render the builder screen for an access.policy holder (owner) whose listCustomRoles is `list`.
async function renderWithLoad(list: () => Promise<unknown[]>): Promise<ShimNode> {
  const c: Caller = { method: "access", email: "owner@example.com", role: "owner", groups: [], isOnlyOwner: false };
  store.setCaller(c);
  store.connect("https://engine.test");
  const engine = store.getEngine()!;
  (engine as unknown as { listCustomRoles: () => Promise<unknown[]> }).listCustomRoles = list;
  const root = screenMod.rolesBuilderScreen.render({
    pattern: "/access/roles/builder", params: {}, query: new URLSearchParams(), path: "/access/roles/builder",
    engine, caller: c, navigate: () => {},
  }) as unknown as ShimNode;
  await flushAsync();
  return root;
}

const SAVE_MARKER = "Save custom role";         // the builder's save control: it must not render over an unread catalogue
const RETRY_MARKER = "Retry";                    // blockError's Retry affordance

async function main(): Promise<void> {
  console.log("-- B37: a failed catalogue read renders the block error, not the builder --");
  {
    // The positive control: a catalogue that loads renders the builder with its Save control, so the
    // "does NOT render the builder" checks below can fail.
    const root = await renderWithLoad(async () => []);
    ok("a loaded catalogue renders the builder with its Save control", textOf(root).includes(SAVE_MARKER));
  }
  {
    // A 500: the engine is live and BROKEN. The catalogue was not read, so this must be a block error with
    // Retry, never a builder composing over a catalogue it did not read.
    const root = await renderWithLoadError(new Error("list custom roles: 500"));
    const txt = textOf(root);
    ok("a 500 renders a block error", txt.includes("engine") && root.querySelectorAll("button").some((b) => (b.textContent ?? "").includes(RETRY_MARKER)));
    ok("a 500 does NOT render the builder (no Save control over an unread catalogue)", !txt.includes(SAVE_MARKER));
  }
  {
    // A network abort (no status): unreachable, again a real fault, not a pending feature.
    const root = await renderWithLoadError(new TypeError("Failed to fetch"));
    const txt = textOf(root);
    ok("a network abort renders a block error with Retry", root.querySelectorAll("button").some((b) => (b.textContent ?? "").includes(RETRY_MARKER)));
    ok("a network abort does NOT render the builder", !txt.includes(SAVE_MARKER));
  }

  console.log("-- B37: a 404 or 501 is a fault too: every released engine serves /admin/custom-roles --");
  for (const status of [404, 501]) {
    const root = await renderWithLoadError(new Error(`list custom roles: ${status}`));
    const txt = textOf(root);
    ok(`a ${status} renders a block error with Retry`, root.querySelectorAll("button").some((b) => (b.textContent ?? "").includes(RETRY_MARKER)));
    ok(`a ${status} does NOT render the builder`, !txt.includes(SAVE_MARKER));
  }

  console.log("-- B55: the custom-role Save button disables before the create await (no double-fire) --");
  {
    // A valid FRESH-CREATE composition (the kv-restorer recipe validateCustomRole accepts) with a name NOT in
    // the existing catalogue: the branch that used to run void doSave() with the button never disabled, so an
    // ordinary double-click submitted the create twice. A createCustomRole we hold pending lets us inspect the
    // button WHILE the create is in flight: the guard is the disabled state set before the await.
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
    ok("B55: the save button renders", saveBtn !== undefined);
    saveBtn?.click();
    await flushAsync();
    ok("B55: one click fires exactly one createCustomRole", calls === 1);
    ok("B55: the save button is DISABLED while the create is in flight (a second click cannot double-fire)", saveBtn?.disabled === true);
    releaseCreate({ status: "applied", value: { label: "QA viewer" } });
    await flushAsync();
  }

  console.log(failures === 0 ? "\nROLES-BUILDER LOAD VECTORS PASS" : `\n${failures} FAILURE(S)`);
  verdictReached(failures); // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
