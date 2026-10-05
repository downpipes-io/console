// THE CREATE WIZARD HAS NO INLINE ATTACH, so it shows no token field for one.
//
// The wizard carried an attach block (a password field for a one-shot deploy token, and a "Protect and
// continue" step) that was shown only when state.chosenInput was set. No source row ever set it: every row the
// source step offers is an attached binding or a token-authenticated source, and an unattached source is added
// under Sources first. So the block and its copy could never render, and its catalogue row described a field
// no operator could reach. The block is removed.
//
// This drives the REAL wizard over a stubbed engine, picks the one attached binding it offers, and reads the
// whole document, hidden nodes included, because the dead block sat in the DOM with `hidden` set: no password
// input, no "Protect and continue", and no attach copy. It also checks the
// source step rendered the binding at all, so a wizard that rendered nothing cannot pass.
//
// Run: node test/validate-wizard-no-inline-attach.ts

import { flushAsync, installDomShim, textOf } from "./dom-shim.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

installDomShim();

const { EngineClient } = await import("../src/api.ts");
const { openCreateWizard } = await import("../src/screens/sources-downpipes/editor-wizard.ts");

let failures = 0;
let checks = 0;
function ok(label: string, cond: boolean): void {
  checks++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string) => {
  const u = String(url);
  if (u.includes("/admin/sources/discover")) return json({ bound: { kv: ["KV_uploads"], r2: [], d1: [], secrets: [] }, tokenPresent: false });
  if (u.includes("/admin/destinations")) return json({ destinations: [{ id: "d1", label: "Primary" }], defaultId: "d1" });
  if (u.includes("/admin/destination")) return json({ configured: true, kind: "r2" });
  return json({});
}) as typeof fetch;

async function main(): Promise<void> {
  try {
    const engine = new EngineClient("https://engine.test");
    openCreateWizard(engine, null, new Set<string>(), () => {}, () => {});
    await flushAsync();
    await flushAsync();
    const body = document.body as unknown as { querySelectorAll: (s: string) => Array<{ getAttribute: (n: string) => string | null; checked?: boolean; click?: () => void; textContent: string }> };
    const text = textOf(document.body as never);
    ok("the source step rendered the attached binding it offers", text.includes("KV_uploads") || text.includes("uploads"));

    // Pick every checkbox the step offers, the way an operator ticks a source, then read the step again.
    for (const box of body.querySelectorAll("input")) {
      if (box.getAttribute("type") === "checkbox" && box.click) box.click();
    }
    await flushAsync();
    const after = textOf(document.body as never);
    const passwords = body.querySelectorAll("input").filter((i) => i.getAttribute("type") === "password");
    ok("the wizard carries no password input, hidden or shown", passwords.length === 0);
    ok("no control carries the removed token field's data-dp", body.querySelectorAll("[data-dp]").every((e) => e.getAttribute("data-dp") !== "sources-downpipes.password.token"));
    ok("no step offers 'Protect and continue'", !after.includes("Protect and continue"));
    ok("no attach copy asks for a Cloudflare API token", !after.includes("Paste a Cloudflare API token") && !after.includes("This source isn't protected yet"));
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log(failures === 0 ? "\nPASS validate-wizard-no-inline-attach" : `\nFAIL validate-wizard-no-inline-attach (${failures})`);
  verdictReached(failures, checks);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
