// Coverage validator for the context-bar chrome (src/shell/chrome.ts): the engine identity chip
// (buildEngineChip) and the account/session area (renderAccount). The app-shell validator builds the
// shell once and swaps these via setEngine / setCaller, but it never reaches the null-host title,
// and never drives both account branches (verified identity vs the whoami-pending degrade note) nor
// either sign-out handler. This file calls both exported renderers directly, asserting a meaningful
// outcome for each branch so the lines, functions and branches are genuinely exercised end to end.
//
// It renders the real production code under the shared DOM shim (test/dom-shim.ts), exactly as the
// other cov validators do, and never edits that shared shim. Run with `node test/cov/shell-chrome.ts`
// (the cov runner also invokes it).

import { installDomShim, qs, textOf } from "../dom-shim.ts";

installDomShim();

import { buildEngineChip, renderAccount } from "../../src/shell/chrome.ts";
import type { Caller } from "../../src/api.ts";

const g = globalThis as unknown as Record<string, unknown>;
const doc = g.document as { createElement(tag: string): unknown };

let failures = 0;
function ok(name: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`);
  if (!cond) failures++;
}

// A narrow window onto a shimmed element, enough for the reads the test makes.
type El = {
  getAttribute(k: string): string | null;
  classList: { contains(c: string): boolean };
  querySelector(sel: string): El | null;
  appendChild(n: El): El;
  click(): void;
  childNodes: El[];
  textContent: string;
};

function el(tag: string): El {
  return doc.createElement(tag) as unknown as El;
}

// chip reads buildEngineChip's tree as a shimmed element.
function chip(opts: { host: string | null }): El {
  return buildEngineChip(opts) as unknown as El;
}

// ---- buildEngineChip: host text only (no status lamp), and the null-host fallback -----------------

console.log("-- buildEngineChip: a connected engine renders the host, the title, and NO status dot --");
{
  const c = chip({ host: "engine.example.test" });
  ok("the host is shown in the monospace host span", textOf(c.querySelector(".engine-chip__host")!) === "engine.example.test");
  ok("a connected chip's title names the host", c.getAttribute("title") === "Engine: engine.example.test");
  // The chip deliberately carries NO status dot: nothing ever drove one (the app only ever knew
  // "unknown"), so a lamp here was a permanently grey light that read like a broken indicator.
  ok("the chip renders no status dot (nothing drives one)", c.querySelector(".dot") === null);
}

console.log("-- buildEngineChip: a null host reads Not connected and the no-engine title --");
{
  // host null exercises the false arm of both the title ternary and the host ?? fallback.
  const c = chip({ host: null });
  ok("a null host shows the Not connected placeholder in the host span", textOf(c.querySelector(".engine-chip__host")!) === "Not connected");
  ok("a null host reads the no-engine title (the false arm of the title ternary)", c.getAttribute("title") === "No engine connected");
  ok("a disconnected chip renders no status dot either", c.querySelector(".dot") === null);
}

// ---- renderAccount: the verified identity branch vs the whoami-pending degrade note --------------

const accessCaller: Caller = {
  method: "access",
  email: "operator@example.test",
  role: "owner",
  groups: [],
  isOnlyOwner: true,
};

console.log("-- renderAccount: a resolved caller with whoami renders the honest verified chip --");
{
  const slot = el("div");
  let signedOut = 0;
  renderAccount(slot as unknown as HTMLElement, accessCaller, true, () => signedOut++);
  ok("the account area renders a single account chip", slot.childNodes.length === 1 && qs(slot, ".account-chip") !== null);
  // The Access verdict chip reads the REAL verdict (method "access" -> verified teal trust), never a
  // hardcoded green; assert the trust tone and the verified email copy.
  const trust = qs(slot, ".trust-chip")!;
  ok("the verdict chip is the verified trust tone, read from the access caller", (trust.getAttribute("class") ?? "").includes("trust-chip--trust"));
  ok("the verdict chip states the verified Access email", textOf(qs(slot, ".trust-chip__label")!).includes("operator@example.test"));
  // The verdict chip is the ONE carrier of the email: no second monospace copy of it beside it.
  ok("the email renders once (no duplicated mono identity span)", qs(slot, ".account-chip__id") === null);
  // The role is title-cased from the caller's role string.
  ok("the role badge title-cases the caller's role", textOf(qs(slot, ".badge")!) === "Owner");
  const signOut = qs(slot, "button")!;
  ok("the verified chip offers a Sign out affordance", textOf(signOut) === "Sign out");
  signOut.click();
  ok("clicking Sign out in the verified branch invokes the handler", signedOut === 1);
}

console.log("-- renderAccount: a null-email token caller renders the honest fallback verdict --");
{
  // email null (a token-method caller): the verdict chip carries no email and no fake identity string.
  const slot = el("div");
  const noEmail: Caller = { method: "token", email: null, role: "viewer", groups: [], isOnlyOwner: false };
  renderAccount(slot as unknown as HTMLElement, noEmail, true, () => {});
  ok("a viewer caller's role badge reads Viewer", textOf(qs(slot, ".badge")!) === "Viewer");
  // A token-method caller resolves to the amber token-fallback verdict, NOT a green/teal one.
  ok("a token caller's verdict chip is the amber warn tone, never a faked verified", (qs(slot, ".trust-chip")!.getAttribute("class") ?? "").includes("trust-chip--warn"));
  ok("no fabricated identity string renders for a null-email caller", qs(slot, ".account-chip__id") === null);
}

console.log("-- renderAccount: whoami pending shows the honest degrade note, no faked identity --");
{
  // whoamiAvailable false drops to the degraded branch: an honest note, no email, no green chip.
  const slot = el("div");
  let signedOut = 0;
  renderAccount(slot as unknown as HTMLElement, accessCaller, false, () => signedOut++);
  ok("the degraded branch renders a single account chip", slot.childNodes.length === 1 && qs(slot, ".account-chip") !== null);
  ok("the degraded branch shows the honest signed-in-identity-pending note", textOf(slot).includes("Signed in; identity pending"));
  ok("the degraded branch never paints a verified trust chip (no faked identity)", qs(slot, ".trust-chip") === null);
  ok("the degraded branch shows no role badge", qs(slot, ".badge") === null);
  const signOut = qs(slot, "button")!;
  ok("the degraded branch still offers a Sign out affordance", textOf(signOut) === "Sign out");
  signOut.click();
  ok("clicking Sign out in the degraded branch invokes the handler", signedOut === 1);
}

console.log("-- renderAccount: a null caller also takes the degrade note branch --");
{
  // caller null (with whoami nominally available) still fails the `caller && whoamiAvailable` guard,
  // so it renders the same honest degrade note rather than throwing on a null caller.
  const slot = el("div");
  renderAccount(slot as unknown as HTMLElement, null, true, () => {});
  ok("a null caller renders the degrade note (the guard's null arm)", textOf(slot).includes("Signed in; identity pending") && qs(slot, ".trust-chip") === null);
}

console.log("-- renderAccount: a second render clears the slot before re-rendering --");
{
  // clear(slot) runs at the top of renderAccount; render twice and assert no duplication accrued.
  const slot = el("div");
  renderAccount(slot as unknown as HTMLElement, accessCaller, true, () => {});
  renderAccount(slot as unknown as HTMLElement, accessCaller, false, () => {});
  ok("re-rendering clears the prior chip rather than stacking a second one", slot.childNodes.length === 1);
  ok("the re-render reflects the latest state (degraded note, not the stale verified chip)", textOf(slot).includes("Signed in; identity pending"));
}

if (failures > 0) process.exitCode = 1;

if (failures > 0) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("\nSHELL CHROME COVERAGE VECTORS PASS");
