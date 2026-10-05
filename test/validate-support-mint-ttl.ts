// Validate the expiry choice on the pull-credential mint (Settings, Support, and the pull vendor tiles on
// Integrations, which mount the same panel).
//
// Run: node test/validate-support-mint-ttl.ts
//
// THE DEFECT. mintCredential called engine.mintSupportCredential(scope, undefined, ...), so every credential
// got the scope default: 90 days for the audit feed. The client and the engine both accept ttlSeconds, and the
// engine caps it per scope (365 days for the audit feed), but no control in the console could send it. The
// Microsoft Sentinel page had to say a console-minted bearer lasts 90 days for that reason.
//
// WHAT THIS FILE GRADES, through the real rendered panel and a recording engine:
//   SENT      a typed number of days reaches the engine as ttlSeconds (days x 86400).
//   DEFAULT   a blank field sends no ttlSeconds, so the engine keeps applying the scope default.
//   REFUSED   a number above the scope cap is refused at the field, and no mint call is made.
//   SCOPED    each scope has its own cap (7 days for diagnostics), so 30 days is refused there.
//   QUEUED    under dual control the engine binds the approval to { scope, ttlSeconds }, and the approved mint
//             runs only when the owner re-submits with the same term. The queued path rebuilds the panel, so
//             the rebuilt field must keep the term, and the re-submit must send the same ttlSeconds.
//
// FS-WRITES: none outside this repo

import { installDomShim, flushAsync, markConnected } from "./dom-shim.ts";

(globalThis as unknown as { location: unknown }).location = {
  origin: "https://control.downpipes.io",
  href: "https://control.downpipes.io/settings",
  pathname: "/settings",
  assign: () => {},
  replace: () => {},
};
installDomShim();

const { renderPullCredentials, mintTtlSeconds, mintTermPhrase } = await import("../src/screens/settings/support.ts");
const { setCaller } = await import("../src/lib/caller-state.ts");
import type { IngestScope, SupportStatus } from "../src/lib/api/types/support.ts";
import type { EngineClient } from "../src/api.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
let checks = 0;
function ok(name: string, cond: boolean): void {
  checks++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`);
  if (!cond) failures++;
}

// The mint controls are Owner-gated through canDo(), so a real Owner caller is resolved first.
setCaller({ role: "owner", email: "owner@example.com", method: "access", subject: "s" } as never);

interface MintCall {
  scope: IngestScope;
  ttlSeconds: number | undefined;
}

// renderScope mounts the real panel for one scope with no active grant, so the mint needs no re-mint confirm.
async function renderScope(scope: IngestScope): Promise<{ card: HTMLElement; calls: MintCall[] }> {
  const calls: MintCall[] = [];
  const engine = {
    getSupport: async (): Promise<SupportStatus> => ({ vendorSealConfigured: true, signerConfigured: true, diagnostics: null, auditFeed: null, metrics: null }),
    metricsEndpointUrl: () => "https://engine.example.com/metrics",
    getConfigApprovalPolicy: async () => ({ requireChangeNumber: false }),
    mintSupportCredential: async (s: IngestScope, ttlSeconds?: number) => {
      calls.push({ scope: s, ttlSeconds });
      return { status: "result", value: { clientId: "dpc_new", secret: "s", bearer: "dpc_new.s", scope: s, expiresAt: "2027-01-01T00:00:00.000Z" } };
    },
  } as unknown as EngineClient;
  const card = renderPullCredentials(engine, scope);
  markConnected(card);
  await flushAsync();
  return { card, calls };
}

async function mintWith(scope: IngestScope, days: string): Promise<{ calls: MintCall[]; error: string; rendered: boolean }> {
  const { card, calls } = await renderScope(scope);
  const input = card.querySelector(`#support-ttl-${scope}`) as HTMLInputElement | null;
  const btn = [...card.querySelectorAll("button")].find((b) => (b.textContent ?? "") === "Mint credential") as HTMLButtonElement | undefined;
  if (input) input.value = days;
  btn?.click();
  await flushAsync();
  const slot = card.querySelector(`#support-ttl-${scope}-error`) as HTMLElement | null;
  const error = slot && slot.hidden !== true ? (slot.textContent ?? "").trim() : "";
  return { calls, error, rendered: input !== null && btn !== undefined };
}

console.log("-- the pure conversion --");
ok("blank sends no ttlSeconds (the engine default applies)", mintTtlSeconds("") === undefined && mintTtlSeconds("   ") === undefined);
ok("365 days is 31,536,000 seconds, the engine's audit-feed cap exactly", mintTtlSeconds("365") === 365 * 24 * 3600);

console.log("\n-- SENT: a typed expiry reaches the engine --");
{
  const r = await mintWith("audit-feed", "365");
  ok("the audit-feed panel rendered the expiry field and the mint button (not a blank render)", r.rendered);
  ok("one mint call was made", r.calls.length === 1);
  ok("the mint carries ttlSeconds for 365 days", r.calls[0]?.ttlSeconds === 365 * 24 * 3600);
  ok("and the scope is the audit feed", r.calls[0]?.scope === "audit-feed");
}

console.log("\n-- DEFAULT: a blank field leaves the default to the engine --");
{
  const r = await mintWith("audit-feed", "");
  ok("one mint call was made", r.calls.length === 1);
  ok("the mint carries no ttlSeconds", r.calls[0] !== undefined && r.calls[0].ttlSeconds === undefined);
}

console.log("\n-- REFUSED: above the scope cap, nothing is minted --");
{
  const r = await mintWith("audit-feed", "366");
  ok("no mint call was made", r.calls.length === 0);
  ok("the field names the rule and the remedy", r.error.includes("from 1 to 365") && r.error.includes("leave it blank"));
}
{
  const r = await mintWith("audit-feed", "0");
  ok("zero days is refused too, with no mint call", r.calls.length === 0 && r.error.includes("from 1 to 365"));
}

console.log("\n-- SCOPED: each scope has its own cap --");
{
  const r = await mintWith("diagnostics", "30");
  ok("30 days is refused on the diagnostics scope (cap 7 days)", r.calls.length === 0 && r.error.includes("from 1 to 7"));
  const ok7 = await mintWith("diagnostics", "7");
  ok("7 days is accepted on the diagnostics scope", ok7.calls.length === 1 && ok7.calls[0]?.ttlSeconds === 7 * 24 * 3600);
  const m = await mintWith("metrics", "400");
  ok("400 days is accepted on the metrics scope", m.calls.length === 1 && m.calls[0]?.ttlSeconds === 400 * 24 * 3600);
}

console.log("\n-- QUEUED: the re-submit after approval sends the approved term --");
{
  // The engine queues the first mint (dual control on, no armed approval) and applies the second, as the
  // gate does once a second owner has approved. Each mint asks the panel to refresh, which rebuilds the field.
  const calls: MintCall[] = [];
  let mints = 0;
  const engine = {
    getSupport: async (): Promise<SupportStatus> => ({ vendorSealConfigured: true, signerConfigured: true, diagnostics: null, auditFeed: null, metrics: null }),
    metricsEndpointUrl: () => "https://engine.example.com/metrics",
    getConfigApprovalPolicy: async () => ({ requireChangeNumber: false }),
    mintSupportCredential: async (s: IngestScope, ttlSeconds?: number) => {
      calls.push({ scope: s, ttlSeconds });
      mints++;
      if (mints === 1) return { status: "queued", queued: { id: "oa-1" } };
      return { status: "result", value: { clientId: "dpc_new", secret: "s", bearer: "dpc_new.s", scope: s, expiresAt: "2027-01-01T00:00:00.000Z" } };
    },
  } as unknown as EngineClient;
  const card = renderPullCredentials(engine, "audit-feed");
  markConnected(card);
  await flushAsync();
  const input = (): HTMLInputElement | null => card.querySelector("#support-ttl-audit-feed") as HTMLInputElement | null;
  const mintBtn = (): HTMLButtonElement | undefined =>
    [...card.querySelectorAll("button")].find((b) => (b.textContent ?? "") === "Mint credential") as HTMLButtonElement | undefined;
  const first = input();
  if (first) first.value = "200";
  mintBtn()?.click();
  await flushAsync();
  ok("the first mint was queued with ttlSeconds for 200 days", calls.length === 1 && calls[0]?.ttlSeconds === 200 * 24 * 3600);
  const rebuilt = input();
  ok("the queued path rebuilt the field (a new control, not the one typed into)", rebuilt !== null && rebuilt !== first);
  ok("the rebuilt field still holds 200", rebuilt?.value === "200");
  const text = card.textContent ?? "";
  ok("the panel names the queued term and tells the owner to mint again with it",
    text.includes("A mint with an expiry of 200 days waits for approval") && text.includes("mint again with the same expiry"));
  const toasts = [...document.querySelectorAll(".toast__msg")].map((n) => n.textContent ?? "");
  ok("the queued toast names the term", toasts.some((t) => t.includes("with an expiry of 200 days") && t.includes("queued for a second owner")));
  mintBtn()?.click();
  await flushAsync();
  ok("the re-submit sends the same ttlSeconds, so the armed approval matches", calls.length === 2 && calls[1]?.ttlSeconds === 200 * 24 * 3600);
  ok("after the applied mint the queued note is gone", !(card.textContent ?? "").includes("waits for approval"));
  ok("a blank term reads as the default expiry", mintTermPhrase("  ") === "the default expiry" && mintTermPhrase("1") === "an expiry of 1 day");
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} validate-support-mint-ttl: ${checks} checks, ${failures} failures`);
verdictReached(failures, checks);
if (failures > 0) process.exitCode = 1;
