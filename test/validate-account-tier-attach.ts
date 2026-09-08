// The multi-source attach on the Sources account tier, driven through the
// REAL accountTier.
//
//   node test/validate-account-tier-attach.ts
//
// The detach direction is covered by validate-source-detach.ts. This is the other half of the same wire
// call, and it carries a different risk: attaching the WRONG SET. The tier lets an operator tick several
// discovered sources and attach them in one token-gated call, so the set sent must be exactly what is
// ticked at the moment of the click.
//
// The comment in account.ts spells out why that phrasing matters: "read AT CLICK TIME, never a stale
// capture". A closure that captured the selection when the panel rendered would attach whatever was ticked
// then, which after a few ticks is silently the wrong fleet. This file pins the live read.
//
// It also pins the mirror of the detach test: the remove[] list must be EMPTY. An attach that also carried
// a removal would detach a source nobody asked to remove, and the operator's next signal would be a failed
// backup rather than an error.

import { installDomShim, qsa, textOf, flushAsync } from "./dom-shim.ts";
installDomShim();

const { accountTier } = await import("../src/screens/sources/account.ts");
const { markConnected } = await import("./dom-shim.ts");
const { makeEvent } = await import("./dom-shim-core.ts");

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

interface Call {
  token: string;
  add: Array<{ binding?: string }>;
  remove: string[];
}

// The real SourceDiscovery shape: the tickable sources live under accounts[], each a DiscoveredAccount,
// with `bound` naming what the engine already has. A fixture that puts kv[] at the top level makes the tier
// render no controls at all, failing for a fixture reason rather than a product one.
const found = (names: string[]) => ({
  bound: { kv: [], r2: [], d1: [], secrets: [] },
  tokenPresent: true,
  engineAccountId: "acct-1",
  accounts: [
    {
      accountId: "acct-1",
      accountName: "Test account",
      kv: names.map((n) => ({ id: `id-${n}`, name: n })),
      r2: [],
      d1: [],
      secrets: [],
      zones: [],
      errors: [],
    },
  ],
  accountErrors: [],
});

// build renders the tier as an owner and returns handles onto the live controls.
function build(names: string[], result: () => Promise<unknown>): {
  calls: Call[];
  el: HTMLElement;
  tick: (name: string, on?: boolean) => void;
  token: () => { value: string } | undefined;
  gen: () => { textContent: string; disabled: boolean; click: () => void } | undefined;
  attach: () => { textContent: string; disabled: boolean; click: () => void } | undefined;
} {
  const calls: Call[] = [];
  // The tier mounts a management row on render that reads the discovery status, so the stub needs that
  // too: a stub missing a method the RENDER path calls throws before any assertion runs.
  const engine = {
    changeBindings: (token: string, add: Array<{ binding?: string }>, remove: string[]) => {
      calls.push({ token, add, remove });
      return result();
    },
    getDiscoveryStatus: () => Promise.resolve({ tokenPresent: true, lastRunAt: null }),
    discoverSources: () => Promise.resolve(found([]) as never),
  };
  const el = accountTier(engine as never, found(names) as never, new Set() as never, () => {}, true, { setWaitPoll: () => {}, stopWaitPoll: () => {}, setOpenAdd: () => {} } as never);
  markConnected(el as unknown as never);
  const boxes = () => qsa(el, "input") as unknown as Array<{ id: string; type?: string; checked: boolean; value: string; dispatchEvent: (e: ReturnType<typeof makeEvent>) => void }>;
  return {
    calls,
    el,
    tick: (name, on = true) => {
      // The control id is SLUGIFIED, so an underscore in a binding name becomes a hyphen
      // (KV_a -> ...-id-KV-a). Matching the raw name finds nothing.
      const slug = name.replace(/_/g, "-");
      const cb = boxes().find((b) => String(b.id ?? "").endsWith(slug));
      if (cb === undefined) throw new Error(`no checkbox for ${name} (ids: ${boxes().map((b) => b.id).join(",")})`);
      cb.checked = on;
      cb.dispatchEvent(makeEvent({ type: "change" }));
    },
    // Found by ATTRIBUTE, not by a `type` property: the shim keeps type as a content attribute, so
    // `b.type` is undefined and a property test silently finds nothing.
    token: () => boxes().find((b) => (b as unknown as { getAttribute: (k: string) => string | null }).getAttribute("type") === "password"),
    // "Attach selected to the engine" is the GENERATE step: it reveals the token panel. The panel's own
    // "Attach N now" is the control that calls the engine. Both are matched separately, because clicking
    // the first is what brings the second into existence, and a test that conflated them would click a
    // button that does not exist yet.
    // Matched on its STABLE hook, never its label. The generate button's text changes as soon as anything
    // is ticked ("Attach selected to the engine" becomes "Attach 1 to the engine"), so a label matcher
    // finds it before the first tick and loses it immediately after.
    gen: () => (qsa(el, "button") as unknown as Array<{ textContent: string; disabled: boolean; click: () => void; getAttribute: (k: string) => string | null }>).find((b) => b.getAttribute("data-dp") === "sources.button.gen"),
    attach: () => (qsa(el, "button") as unknown as Array<{ textContent: string; disabled: boolean; click: () => void }>).find((b) => /^Attach (\d+ )?now$/.test(String(b.textContent ?? ""))),
  };
}

const applied = () => Promise.resolve({ status: "applied", value: { attached: [], detached: [] } });

async function main(): Promise<void> {
  console.log("(1) the attach control is disabled until something is ticked");
  {
    const h = build(["KV_a", "KV_b"], applied);
    ok("(1a) a generate control exists", h.gen() !== undefined);
    ok("(1b) it starts disabled with nothing ticked", h.gen()?.disabled === true);
    h.tick("KV_a");
    ok("(1c) ticking one enables it", h.gen()?.disabled === false);
    h.gen()?.click();
    ok("(1d) clicking it reveals the token panel with its own attach control", h.attach() !== undefined);
    ok("(1e) whose label counts the selection", String(h.attach()?.textContent).includes("1"));
  }

  console.log("\n(2) THE LIVE READ: the set sent is what is ticked at CLICK time");
  {
    // Tick two, untick one, tick a third, then click. A closure that captured the selection at render time
    // (or at any earlier tick) would send the wrong fleet, and nothing on screen would say so.
    const h = build(["KV_a", "KV_b", "KV_c"], applied);
    h.tick("KV_a");
    h.tick("KV_b");
    h.tick("KV_a", false);
    h.tick("KV_c");
    h.gen()?.click();
    const t = h.token();
    if (t !== undefined) t.value = "deploy-token";
    h.attach()?.click();
    await flushAsync();
    ok("(2a) changeBindings was called once", h.calls.length === 1);
    const sent = (h.calls[0]?.add ?? []).map((i) => i.binding).filter((x): x is string => typeof x === "string").sort();
    // The wire carries the DERIVED binding, not the raw source name: bindingFor("SRC_KV_", name). So this
    // pins the derivation as well as the selection, which is worth having, because the binding is what the
    // engine reads the source through and a mangled prefix would attach something that resolves to nothing.
    ok(`(2b) exactly the two still-ticked sources were sent, as derived bindings (got ${JSON.stringify(sent)})`, JSON.stringify(sent) === JSON.stringify(["SRC_KV_KV_b", "SRC_KV_KV_c"]));
    ok("(2c) the unticked one was NOT sent", !sent.some((b) => b.includes("KV_a")));
  }

  console.log("\n(3) the mirror of the detach rule: remove[] must be EMPTY on an attach");
  {
    const h = build(["KV_a"], applied);
    h.tick("KV_a");
    h.gen()?.click();
    const t = h.token();
    if (t !== undefined) t.value = "deploy-token";
    h.attach()?.click();
    await flushAsync();
    ok("(3a) the call was made", h.calls.length === 1);
    ok("(3b) the remove list is empty: an attach never detaches anything", JSON.stringify(h.calls[0]?.remove) === "[]");
    ok("(3c) the token is trimmed and sent", h.calls[0]?.token === "deploy-token");
    ok("(3d) the one ticked source is sent as its derived binding", JSON.stringify((h.calls[0]?.add ?? []).map((i) => i.binding)) === JSON.stringify(["SRC_KV_KV_a"]));
  }

  console.log("\n(4) a blank token is refused inline, WITHOUT calling the engine");
    for (const blank of ["", "   "]) {
      const h = build(["KV_a"], applied);
      h.tick("KV_a");
      h.gen()?.click();
      const t = h.token();
      if (t !== undefined) t.value = blank;
      h.attach()?.click();
      await flushAsync();
      ok(`(4) token ${JSON.stringify(blank)}: the engine is not called`, h.calls.length === 0);
      ok(`(4) token ${JSON.stringify(blank)}: the operator is told to paste it`, textOf(h.el as unknown as never).includes("Paste the deploy token first."));
    }

  console.log("\n(5) clicking with nothing ticked does nothing at all");
  {
    // The button is disabled, but the handler also returns early on an empty set. Both layers are worth
    // having: a disabled attribute can be cleared in an inspector, the early return cannot.
    const h = build(["KV_a"], applied);
    h.gen()?.click();
    const t = h.token();
    if (t !== undefined) t.value = "deploy-token";
    h.attach()?.click();
    await flushAsync();
    ok("(5a) no call is made with an empty selection, even with a token pasted", h.calls.length === 0);
  }

  console.log(`\n${failures === 0 ? "ACCOUNT-TIER-ATTACH OK: the set sent is read at click time, remove[] stays empty, and a blank token never reaches the engine" : `${failures} FAILURE(S)`}`);
  // EXIT EXPLICITLY ON BOTH PATHS. Returning here and letting the event loop drain hangs this file for
  // ever when it PASSES: the dom shim deliberately leaves window.setTimeout as node's real timer (see
  // dom-shim-document.ts), so the transient UI a component schedules, the "Copied" announce and the flash
  // class, is still pending when the assertions finish and node waits for it. The banner had already
  // printed, so the chain looked like it was working while it sat at 0% CPU and never reached the next
  // validator. Sixteen other shim-using validators already end this way; this one did not.
  if (failures > 0) process.exitCode = 1; // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
  (globalThis as unknown as { process: { exit(code: number): never } }).process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  (globalThis as unknown as { process: { exit(code: number): never } }).process.exit(1);
});
