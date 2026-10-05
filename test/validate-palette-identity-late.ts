// A PALETTE OPENED BEFORE WHOAMI LANDS MUST FOLLOW THE CALLER WHEN IT RESOLVES.
//
// The first paint after a reload runs before the identity resolve (app.ts starts the router, then resolves
// whoami in the background). An Owner who presses Cmd-K in that window used to get the palette built for
// no caller at all, because the gating context was read once at open: 37 of 51 rows, with no Request a
// restore, no Apply a restore and no Create a downpipe, and it stayed that way until they closed it and
// opened it again. The palette now reads the live caller on every paint and repaints when the resolved
// caller changes.
//
// WHAT THIS PINS, each able to fail on its own:
//   1. THE CONTROL. With no caller the owner-gated commands are absent (a pass here is what makes the
//      later presence mean something).
//   2. NO REOPEN NEEDED. When the caller resolves to an Owner while the palette is open, the same open
//      palette lists them without a keystroke.
//   3. A KEYSTROKE READS THE LIVE CALLER TOO. The query render gates on the caller of that moment.
//   4. A PINNED CONTEXT STAYS PINNED. A palette opened with an explicit ctx keeps the set that ctx gates.
//   5. THE DOWNPIPE LIST ARRIVES WHILE THE PALETTE IS OPEN. The restore commands are gated on a downpipe
//      existing, read from the list the palette's own entity search fills. On the first query after a load
//      that list is empty when the rows are painted and lands one debounce later. The repaint that follows
//      must gate on it: typing "Request a restore" as the first query shows the row without another
//      keystroke. Before this, the repaint reused the rows gated on the empty list, and skipped the repaint
//      entirely when no entity matched, so the row never appeared.
//
// Run: node test/validate-palette-identity-late.ts

import { installDomShim, textOf, flushAsync, type ShimNode } from "./dom-shim.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts
import type { Caller } from "../src/api.ts";

installDomShim();
// The shim has no <head>; the palette's style marker goes there, so give it one.
const doc = document as unknown as { head?: unknown; createElement: (t: string) => unknown };
if (doc.head === undefined) doc.head = doc.createElement("head");

const store = await import("../src/lib/store.ts");
const { openCommandPalette } = await import("../src/screens/command-palette/overlay.ts");
let failures = 0;
let checks = 0;
function ok(label: string, cond: boolean): void {
  checks++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

const OWNER: Caller = { method: "access", email: "owner@example.com", role: "owner", groups: [], isOnlyOwner: false };

// One downpipe in the cache, so the restore commands' "a downpipe exists" gate is met and the only thing
// between the caller and those rows is the caller's own capability.
store.setDownpipesCache([{ id: "dp-1", name: "orders" } as never]);

function listText(): string {
  const lb = document.querySelector('[role="listbox"]') as unknown as ShimNode | null;
  return lb ? textOf(lb) : "";
}

function typeQuery(value: string): void {
  const input = document.querySelector('[role="combobox"]') as unknown as ShimNode;
  input.value = value;
  input.dispatchEvent({ type: "input", target: input, currentTarget: input, defaultPrevented: false, bubbles: true, preventDefault() {}, stopPropagation() {} });
}

async function main(): Promise<void> {
  console.log("\n-- 1. the control: no caller, no owner-gated commands --");
  store.setCaller(null);
  const handle = openCommandPalette();
  await flushAsync();
  ok("the palette opened", listText().length > 0);
  ok("with no caller, Request a restore is absent", !listText().includes("Request a restore"));
  ok("with no caller, Apply a restore is absent", !listText().includes("Apply a restore"));

  console.log("\n-- 2. the caller resolves while the palette is open --");
  store.setCaller(OWNER);
  await flushAsync();
  ok("the open palette now lists Request a restore", listText().includes("Request a restore"));
  ok("the open palette now lists Apply a restore", listText().includes("Apply a restore"));

  console.log("\n-- 3. a keystroke gates on the caller of that moment --");
  store.setCaller(null);
  await flushAsync();
  typeQuery("restore");
  await flushAsync();
  ok("with the caller gone again, a query for restore does not offer Request a restore", !listText().includes("Request a restore"));
  store.setCaller(OWNER);
  await flushAsync();
  typeQuery("restore");
  await flushAsync();
  ok("with the Owner back, the same query offers Request a restore", listText().includes("Request a restore"));
  handle.close();
  await flushAsync();

  console.log("\n-- 4. an explicit ctx is honoured as given --");
  store.setCaller(null);
  const pinned = openCommandPalette({ ctx: { caller: null, engine: null } });
  await flushAsync();
  store.setCaller(OWNER);
  await flushAsync();
  ok("a palette opened with a no-caller ctx keeps the no-caller set", !listText().includes("Request a restore"));
  pinned.close();
  await flushAsync();

  console.log("\n-- 5. the downpipe list lands after the rows are painted --");
  store.setDownpipesCache(null);
  store.setCaller(OWNER);
  let listReads = 0;
  const engine = {
    listDownpipes: async () => {
      listReads++;
      return [
        { config: { id: "dp-1", name: "orders", source: { type: "kv" } } },
        { config: { id: "dp-2", name: "payments", source: { type: "d1" } } },
      ];
    },
    listAllHistory: async () => ({ byDownpipe: {} }),
    listDestinations: async () => ({ destinations: [] }),
    listExpiry: async () => [],
    listAudit: async () => ({ entries: [] }),
  };
  const fresh = openCommandPalette({ ctx: { caller: OWNER, engine: engine as never } });
  await flushAsync();
  typeQuery("Request a restore");
  ok("CONTROL: painted before the list arrives, the row is absent", !listText().includes("Request a restore"));
  await new Promise((r) => setTimeout(r, 400));
  await flushAsync();
  ok("the palette read the downpipe list once", listReads === 1);
  ok("once the list lands, Request a restore shows without another keystroke", listText().includes("Request a restore"));
  fresh.close();
  await flushAsync();

  console.log(failures === 0 ? "\nPASS validate-palette-identity-late" : `\nFAIL validate-palette-identity-late (${failures})`);
  verdictReached(failures, checks);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
