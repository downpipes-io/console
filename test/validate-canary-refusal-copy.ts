// CN-01 ("Could not start the flight.") and CN-03 ("Could not update the canary.") name no leak and
// no bare status, but until now they also named no remedy at all: a deliberately short sentence with
// nothing spliced in, so an operator reads only that the thing they tried did not happen. Both catch
// blocks now splice the console's own reviewed refusal text (components/error-view.ts refusalText,
// the same helper the rest of the product uses for an engine refusal) onto the same leading sentence,
// so the engine's own reason rides to the operator when it sent one, and the reviewed classified
// sentence otherwise. This drives the REAL canary sections against a fake engine that throws the
// shape the transport throws, and grades the rendered toast.
//
//   node test/validate-canary-refusal-copy.ts

import { flushAsync, installDomShim, markConnected } from "./dom-shim.ts";

installDomShim();

const { renderStatusBlock, renderSettings } = await import("../src/screens/canary-sections.ts");
const store = await import("../src/lib/store.ts");

import type { CanaryView, EngineClient } from "../src/api.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
let checks = 0;
function ok(label: string, cond: boolean): void {
  checks++;
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

// toast.ts holds its live region as a module singleton that is never torn down between sub-tests
// here, by design (it is the one stable region a real page would also reuse), so every lookup below
// reads the LAST matching node rather than the first: the one the block just produced.
function lastMatch<T extends { textContent: string | null }>(nodes: T[]): T | undefined {
  return nodes[nodes.length - 1];
}
function lastToastText(): string {
  return lastMatch([...document.querySelectorAll(".toast__msg")])?.textContent ?? "";
}
function clickLastButtonNamed(text: string): void {
  const btn = lastMatch([...document.querySelectorAll("button")].filter((b) => (b.textContent ?? "").includes(text)));
  (btn as unknown as { click: () => void } | undefined)?.click();
}

function view(enabled: boolean): CanaryView {
  const all = [{ id: "a", label: "A", isDefault: true }];
  return {
    config: { enabled, destinationIds: null, intervalSeconds: 3600 },
    status: enabled ? "alive" : "disabled",
    lastRunAt: null,
    nextRunAt: null,
    inFlight: false,
    runSeq: 1,
    dests: [{ destinationId: "a", label: "A", isDefault: true, status: "alive", lastRunAt: null, deadSince: null, lastCheck: null }],
    history: [],
    allDestinations: all,
    destinationCount: all.length,
    flyingToAll: true,
    danglingPins: [],
  } as unknown as CanaryView;
}

async function main(): Promise<void> {
  store.setCaller({ method: "access", email: "owner@example.com", role: "owner", groups: [], isOnlyOwner: true } as never);

  console.log("-- CN-01: fly-the-canary against an engine that refuses with a reason --");
  {
    const engine = {
      runCanary: async (): Promise<{ ok: boolean; flying: boolean }> => {
        throw new Error("run canary: the scheduler could not reach the destination registry: 500");
      },
    } as unknown as EngineClient;
    const root = document.createElement("div");
    const el = renderStatusBlock(engine, view(true), root, { reload: () => {}, rerender: () => {}, simulate: () => {} });
    root.appendChild(el);
    document.body.appendChild(root);
    markConnected(root as unknown as never);
    clickLastButtonNamed("Fly the canary now");
    await flushAsync();
    const msg = lastToastText();
    ok("the toast leads with the same short sentence", msg.startsWith("Could not start the flight."));
    ok("the engine's own reason now rides with it", msg.includes("could not reach the destination registry"));
    ok("no internal classifier token leaks", !/forbidden-class|access-redirect|retry-after=/.test(msg));
  }

  console.log("\n-- CN-01 control: an engine refusal with NO reason still names a remedy --");
  {
    const engine = {
      runCanary: async (): Promise<{ ok: boolean; flying: boolean }> => {
        throw new Error("run canary: 500");
      },
    } as unknown as EngineClient;
    const root = document.createElement("div");
    const el = renderStatusBlock(engine, view(true), root, { reload: () => {}, rerender: () => {}, simulate: () => {} });
    root.appendChild(el);
    document.body.appendChild(root);
    markConnected(root as unknown as never);
    clickLastButtonNamed("Fly the canary now");
    await flushAsync();
    const msg = lastToastText();
    ok("the reviewed fallback sentence names something to do, not a bare status", /\b(try again|retry|wait|check)\b/i.test(msg));
  }

  console.log("\n-- CN-03: the enabled toggle against an engine that refuses with a reason --");
  {
    const engine = {
      setCanaryConfig: async (): Promise<never> => {
        throw new Error("set canary config: the config store is unavailable: 500");
      },
    } as unknown as EngineClient;
    const section = renderSettings(engine, view(false), () => {});
    document.body.appendChild(section);
    markConnected(section as unknown as never);
    const summary = lastMatch([...document.querySelectorAll("summary")].filter((s) => (s.textContent ?? "").includes("Canary settings")));
    (summary as unknown as { click: () => void } | undefined)?.click();
    await flushAsync();
    const toggle = lastMatch([...document.querySelectorAll("#canary-enabled")]) as unknown as { checked: boolean; dispatchEvent: (e: unknown) => void } | undefined;
    if (toggle) {
      toggle.checked = true;
      const { makeEvent } = await import("./dom-shim-core.ts");
      toggle.dispatchEvent(makeEvent({ type: "change", bubbles: true }));
    }
    await flushAsync();
    const msg = lastToastText();
    ok("the toggle exists and was reached", toggle !== undefined);
    ok("the toast leads with the same short sentence", msg.startsWith("Could not update the canary."));
    ok("the engine's own reason now rides with it", msg.includes("the config store is unavailable"));
  }

  console.log(`\n${checks - failures}/${checks} ok`);
  console.log(`VERDICT: ${failures === 0 ? "PASS" : "FAIL"} failures=${failures} checks=${checks} entry=${import.meta.filename}`);
  verdictReached(failures, checks);
  if (failures > 0) {
    console.log(`\n${failures} FAILURE(S)`);
    process.exit(1);
  }
  console.log("BOTH CANARY REFUSALS NAME THE ENGINE'S OWN REASON");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
