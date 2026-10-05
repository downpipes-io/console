// A harness for validators that render the setup surface (/setup) for real in the DOM shim. The engine behind it
// is the demo engine (lib/demo/demo-routes-read.ts route), seeded as a fresh account (the training-start state),
// so every read and write the setup model makes is answered by the same code the tour and the training course
// run on. A validator imports this AFTER installDomShim().
//
// renderSetup(path) mounts the setup screen at a /setup URL into a fresh <main id="main">, the way the shell
// does, and waits for the model's first read to land. A navigation the page makes (a primary that moves on)
// re-renders at the new URL, so a validator can walk questions by pressing their controls.

import type { Caller } from "../src/api.ts";
import { flushAsync } from "./dom-shim.ts";

const g = globalThis as unknown as Record<string, unknown>;
g.location = g.location ?? { origin: "https://console.test", search: "", hostname: "console.test", href: "https://console.test/", pathname: "/" };
if (typeof (g as { MutationObserver?: unknown }).MutationObserver !== "function") {
  g.MutationObserver = class {
    observe(): void {}
    disconnect(): void {}
    takeRecords(): unknown[] {
      return [];
    }
  };
}

const demoWorld = await import("../src/lib/demo/demo-world.ts");
const { applyDemoState, resetWorld } = demoWorld;
const { route } = await import("../src/lib/demo/demo-routes-read.ts");
const { connect, setCaller } = await import("../src/lib/store.ts");
const { installNav } = await import("../src/lib/nav.ts");
const { setupScreen } = await import("../src/screens/setup/index.ts");
const { setupModel } = await import("../src/lib/setup-flow/model.ts");

// currentWorld is the demo world the engine answers from now. resetSetupWorld replaces the world object, so a
// validator reads it through this call after the reset, never through a binding taken before it.
export function currentWorld(): import("../src/lib/demo/demo-seed.ts").DemoWorld {
  return demoWorld.world;
}

// The owner the demo seed signs in as, and a viewer for the hand-off checks.
export const OWNER: Caller = { method: "passkey", email: "owner@northwind.example", role: "owner", groups: [], isOnlyOwner: false } as Caller;
export const VIEWER: Caller = { method: "passkey", email: "viewer@northwind.example", role: "viewer", groups: [], isOnlyOwner: false } as Caller;

let lastMain: HTMLElement | null = null;

// The navigations the page made to a route outside /setup ("Open the console", "Leave setup", the redirect of a
// console set up elsewhere). The harness renders only the setup screen, so it records them instead of mounting
// setup at a route that is not setup's.
export const leftSetup: string[] = [];

function go(to: string): void {
  if (to === "/setup" || to.startsWith("/setup/") || to.startsWith("/setup?")) void renderSetup(to);
  else leftSetup.push(to);
}

type DemoStateVariant = import("../src/lib/demo/demo-state.ts").DemoStateVariant;

// resetSetupWorld starts an account on the demo engine (a fresh one by default, the training-start state) and
// points the console at it: the fetch that answers /admin/* from the demo world, a connected engine client, the
// given caller, and an empty draft.
export function resetSetupWorld(who: Caller = OWNER, state: DemoStateVariant = { kind: "training-start" }): void {
  resetWorld(Date.now());
  applyDemoState(state);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const u = new URL(url, "https://console.test");
    if (u.pathname.startsWith("/admin/")) return route(u.pathname + u.search, init);
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  connect("https://console.test");
  setCaller(who);
  setupModel().reset();
  // The page's record of committed answers (screens/setup/b/flow.ts ANSWERS_KEY) is part of the draft a new
  // account starts without: a committed answer marks a tab that ran setup (flow.ts setupRunHere).
  try {
    sessionStorage.removeItem("dp-draft:setup-answers-v1");
  } catch {
    // No storage in this shim: there is no record to clear.
  }
  // Nor has it a first-backup copy of another tab's setup draft (lib/setup-flow/model.ts), which a later read of
  // this empty draft would take up.
  try {
    localStorage.removeItem("downpipes.setup.first-backup");
  } catch {
    // No storage in this shim: there is no copy to clear.
  }
  leftSetup.length = 0;
  installNav({
    navigate: (to: string) => go(to),
    onUnauthorised: () => {},
    refreshIdentity: async () => {},
    onAuthenticated: async () => {},
    signOut: () => {},
  });
}

// renderSetup mounts /setup at `path` and waits for its first read. It returns the <main> it rendered into.
export async function renderSetup(path: string): Promise<HTMLElement> {
  // Works under either shim: the full DOM shim (a document with a body) and validate-api's lighter one.
  lastMain?.remove?.();
  const main = document.createElement("main");
  main.id = "main";
  (document as unknown as { body?: { appendChild?: (n: unknown) => unknown } }).body?.appendChild?.(main);
  lastMain = main;
  const [base, qs] = path.split("?");
  const parts = (base ?? "").split("/").filter(Boolean);
  const params: Record<string, string> = {};
  if (parts[1] !== undefined) params.step = parts[1];
  if (parts[2] !== undefined) params.sub = parts[2];
  const pattern = parts.length >= 3 ? "/setup/:step/:sub" : parts.length === 2 ? "/setup/:step" : "/setup";
  (globalThis as unknown as { location: { pathname: string } }).location.pathname = base ?? "/setup";
  const ctx = { pattern, params, query: new URLSearchParams(qs ?? ""), path, engine: null as never, caller: null, navigate: (to: string) => go(to) };
  main.appendChild(setupScreen.render(ctx as never));
  await flushAsync(12);
  return main;
}
