// Validate three engine admin surfaces the console must reach correctly.
//
//   KEY VINTAGES  GET /admin/keys/vintages serves the keyless vintage inventory. The console reads it on
//             the Keys screen's Rotate tab. Asserted here: the client hits the right route and unwraps
//             { inventory }; the verdict is computed by the honesty rules rather than by counting alone (an
//             unread history outranks a zero count); and the panel renders the stranded vintages, never a
//             fabricated all-clear when the read failed.
//
//   REQUIRE-ACCESS PRE-FLIGHT  POST /admin/policy/require-access exists for the console to consult before
//             it advises disabling the shared admin token. The console must not state that the posture is
//             one it "cannot read or set" and print `wrangler secret delete ADMIN_TOKEN` unconditionally,
//             since that is the exact lock-out the engine's pre-flight exists to refuse. Asserted here: the
//             closing command appears ONLY when the engine says safeToDisableToken, the engine's own
//             lockoutWarning is surfaced verbatim when it does not, and a pre-flight that cannot be read
//             withholds the command rather than falling through to it.
//
//   WEBHOOK POLICY REMOVAL  the legacy single SRE-alert webhook policy had console client methods and no
//             screen. Alert delivery moved to notify channels and rules, so those were client methods for a
//             screen that had been deliberately replaced; they are removed rather than left as a shim.
//             Asserted here from SOURCE: no console module targets /admin/policy/webhook and EngineClient
//             exposes no webhook-policy method, so the dead half cannot come back unnoticed. The engine
//             side no longer serves the three routes either; the assertions below also hold the mirror
//             types that shadowed them (the notify-webhook config-diff area), which a re-add would need.
//
// Run with `node test/validate-surface-consumers.ts`.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installDomShim, textOf, flushAsync } from "./dom-shim.ts";

installDomShim();

import { connect } from "../src/lib/store.ts";
import { renderKeyVintages, shortFp, vintageSummary, VINTAGE_HEADING } from "../src/screens/keys/vintages.ts";
import { requireAccessBody, secondFactorSentence } from "../src/screens/access-security/fallback.ts";
import type { EngineClient, KeyVintageInventory, RequireAccessPreflight } from "../src/api.ts";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}
function eq(a: unknown, b: unknown, label: string): void {
  const cond = a === b;
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}  got=${JSON.stringify(a)} want=${JSON.stringify(b)}`);
  if (!cond) failures++;
}

// ---- fixtures -------------------------------------------------------------------------------------------

// A rotated estate: two break-glass vintages, the older one no longer installed, so 33 runs are openable
// ONLY by the identity.key the owner must still hold.
function rotatedInventory(): KeyVintageInventory {
  return {
    current: { breakGlass: "dpr1:aaaa1111bbbb2222", operational: null, signer: "edmldsa1:cccc3333dddd4444" },
    okRunCount: 214,
    readableRunCount: 214,
    truncated: false,
    historyReadOk: true,
    vintages: [
      { fingerprint: "dpr1:aaaa1111bbbb2222", role: "break-glass", runCount: 181, isCurrent: true },
      { fingerprint: "dpr1:9999eeee8888ffff", role: "break-glass", runCount: 33, isCurrent: false },
    ],
    stranded: { runCount: 33, byVintage: [{ fingerprint: "dpr1:9999eeee8888ffff", role: "break-glass", runCount: 33 }], unknownCount: 0 },
    signer: { current: "edmldsa1:cccc3333dddd4444", brokenRunCount: 0, currentRunCount: 214 },
    currentBreakGlassRunCount: 181,
    operationalSoleAccessRunCount: 0,
  };
}

function preflight(over: Partial<RequireAccessPreflight> = {}): RequireAccessPreflight {
  return {
    tokenFallbackDisabled: false,
    accessConfigured: true,
    enforced: false,
    callerMethod: "access",
    secondFactor: { passkeyOwnerEnrolled: true, accessConfigured: true, recoveryReady: false, secondOwner: false },
    secondFactorPresent: true,
    safeToDisableToken: true,
    lockoutWarning: null,
    ...over,
  };
}

// stubFetch records every request and answers from the supplied responder, so a route assertion reads the
// URL the client actually built rather than the one the test hoped for.
interface Call { url: string; method: string }
let calls: Call[] = [];
function stubFetch(responder: () => Response): () => void {
  const prior = globalThis.fetch;
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: typeof input === "string" ? input : String(input), method: (init?.method ?? "GET").toUpperCase() });
    return responder();
  }) as typeof fetch;
  return () => {
    globalThis.fetch = prior;
  };
}
const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// ---- the client reaches GET /admin/keys/vintages ------------------------------------------------

async function clientReadsVintages(): Promise<void> {
  console.log("\nkey vintages client: GET /admin/keys/vintages");
  const inv = rotatedInventory();
  let restore = stubFetch(() => jsonResponse({ inventory: inv }));
  const engine = connect("https://engine.example.com") as EngineClient;
  const got = await engine.getKeyVintages();
  eq(calls[0]?.url, "https://engine.example.com/admin/keys/vintages", "getKeyVintages hits GET /admin/keys/vintages");
  eq(calls[0]?.method, "GET", "getKeyVintages is a GET (a read, exempt from the write rate limit)");
  eq(JSON.stringify(got), JSON.stringify(inv), "the { inventory } envelope is unwrapped and passed through verbatim");
  restore();

  // A non-2xx must throw the named verb, never resolve to an empty inventory that would read as "no
  // vintages, nothing stranded" -- the precise false all-clear this surface exists to prevent.
  restore = stubFetch(() => new Response("nope", { status: 500 }));
  let threw = "";
  try {
    await engine.getKeyVintages();
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  eq(threw, "key vintages: 500", "a non-2xx throws verb + status rather than resolving to an empty inventory");
  restore();
}

// ---- the verdict rules -------------------------------------------------------------------------

function vintageVerdictRules(): void {
  console.log("\nkey vintages verdict: the honesty rules outrank the counts");
  const clean = { ...rotatedInventory(), stranded: { runCount: 0, byVintage: [], unknownCount: 0 } };
  eq(vintageSummary(clean).tone, "ok", "a complete pass with nothing stranded reads as ok");

  eq(vintageSummary(rotatedInventory()).tone, "warn", "runs stranded to a key the engine no longer holds read as warn");
  ok("the stranded count is stated, not merely implied", vintageSummary(rotatedInventory()).title.includes("33"));

  // Order matters, and this is the assertion that catches a plausible-looking simplification: an inventory
  // whose history did not read has stranded.runCount 0, and grading on the count alone would call that clean.
  const unread = { ...clean, historyReadOk: false };
  eq(vintageSummary(unread).tone, "warn", "an unread run history is NOT an all-clear, even with a zero stranded count");
  ok("and it says the count is not a verdict", /not a verdict/i.test(vintageSummary(unread).detail));

  // Truncation is the weaker version of the same rule: what was inspected is clean, what was not is unknown.
  eq(vintageSummary({ ...clean, truncated: true }).tone, "info", "a truncated pass refuses the all-clear tone");
  eq(vintageSummary({ ...clean, stranded: { runCount: 0, byVintage: [], unknownCount: 4 } }).tone, "info", "runs that could not be attributed refuse the all-clear tone too");
  // An unread history outranks truncation as well, so the strongest caveat is the one shown.
  eq(vintageSummary({ ...clean, truncated: true, historyReadOk: false }).tone, "warn", "an unread history outranks truncation");

  eq(shortFp("dpr1:aaaa1111bbbb2222cccc"), "dpr1:aaaa1111bbbb", "a long fingerprint is shortened after the scheme prefix");
  eq(shortFp("dpr1:abcd"), "dpr1:abcd", "a short fingerprint is left whole");
}

// ---- the panel ---------------------------------------------------------------------------------

async function vintagePanelRenders(): Promise<void> {
  console.log("\nkey vintages panel: the Rotate tab can answer 'which key opens which vintage'");
  const inv = rotatedInventory();
  let restore = stubFetch(() => jsonResponse({ inventory: inv }));
  const engine = connect("https://engine.example.com") as EngineClient;
  const panel = renderKeyVintages(engine);
  document.body.appendChild(panel);
  await flushAsync();
  const text = textOf(panel);
  ok("the panel carries the inventory heading", text.includes(VINTAGE_HEADING));
  ok("it names the stranded run count", text.includes("33"));
  ok("it marks the vintage the engine no longer holds", text.includes("Old vintage"));
  ok("it marks the vintage the engine still holds", text.includes("Current"));
  ok("it names the old vintage's fingerprint, so the operator can match it to a saved identity.key", text.includes("dpr1:9999eeee8888"));
  ok("it reports signer continuity alongside recipient stranding", /Signature check/.test(text));
  panel.remove();
  restore();

  // The failure path. A panel that renders an empty inventory on a failed read would say "nothing stranded"
  // about an estate it never managed to look at.
  restore = stubFetch(() => new Response("boom", { status: 503 }));
  const panel2 = renderKeyVintages(engine);
  document.body.appendChild(panel2);
  await flushAsync();
  const text2 = textOf(panel2);
  ok("a failed read never claims nothing is stranded", !/openable by a key your engine currently holds/i.test(text2));
  ok("and offers a retry", /retry/i.test(text2));
  panel2.remove();
  restore();

  // The panel must be MOUNTED, not merely importable. A module no screen composes is the same defect the
  // census found in the first place, one layer further in: built, and unreachable by an operator.
  restore = stubFetch(() => jsonResponse({ inventory: inv }));
  const { renderRotationSection } = await import("../src/screens/keys/rotation.ts");
  const tab = renderRotationSection(engine);
  document.body.appendChild(tab);
  await flushAsync();
  ok("the Rotate break-glass tab mounts the inventory, so an operator reaches it", textOf(tab).includes(VINTAGE_HEADING));
  ok("alongside the keep-old-key warning it makes checkable", textOf(tab).includes("Archives sealed before this rotation can only be opened by the old identity.key. Keep it."));
  tab.remove();
  restore();
}

// ---- the token-disable advice is gated on the engine's verdict ---------------------------------

const CLOSE_COMMAND = "wrangler secret delete ADMIN_TOKEN";

function requireAccessGating(): void {
  console.log("\nrequire-access advice: the closing command is gated on the engine's pre-flight");

  const safe = textOf(requireAccessBody(preflight()));
  ok("with safeToDisableToken the closing command is shown", safe.includes(CLOSE_COMMAND));

  // The crux. The engine computed that closing the token path would lock this operator out; the console must
  // not print the command anyway with a softer caveat, which is what it did before it consulted the engine.
  const lockout = "You have no second factor enrolled (no owner passkey, no Cloudflare Access, no recovery codes, no second owner). Disabling or deleting the admin token now would lock you out.";
  const refusedText = textOf(
    requireAccessBody(
      preflight({
        accessConfigured: false,
        secondFactor: { passkeyOwnerEnrolled: false, accessConfigured: false, recoveryReady: false, secondOwner: false },
        secondFactorPresent: false,
        safeToDisableToken: false,
        lockoutWarning: lockout,
      }),
    ),
  );
  ok("with safeToDisableToken FALSE the closing command is withheld", !refusedText.includes(CLOSE_COMMAND));
  ok("and the engine's own lockoutWarning is surfaced verbatim", refusedText.includes(lockout));
  ok("and the operator is told no way back in was found", /no other way in/i.test(refusedText));

  // The narrower refusal: a second factor exists, but this caller is ON the token, so the engine sends no
  // warning text. A console that only rendered lockoutWarning would show nothing at all here.
  const onToken = textOf(requireAccessBody(preflight({ callerMethod: "token", safeToDisableToken: false })));
  ok("a caller on the token itself is refused too", !onToken.includes(CLOSE_COMMAND));
  ok("with a stated reason even though the engine sent no warning text", /signed in with the shared token itself/i.test(onToken));

  // The two closed states.
  const enforced = textOf(requireAccessBody(preflight({ tokenFallbackDisabled: true, enforced: true })));
  ok("an enforced posture reports closed", /shared-token path is closed/i.test(enforced));
  ok("and offers no closing command, there being nothing left to close", !enforced.includes(CLOSE_COMMAND));
  const halfClosed = textOf(requireAccessBody(preflight({ tokenFallbackDisabled: true, accessConfigured: false, enforced: false })));
  ok("token disabled with Access unwired is reported as the lock-out risk it is", /Access is not configured/i.test(halfClosed));

  // The named factors, so an operator with none learns what to arrange.
  ok("the factor sentence names the ways in the engine can see", secondFactorSentence(preflight()).includes("an Owner passkey"));
  eq(
    secondFactorSentence(preflight({ secondFactor: { passkeyOwnerEnrolled: false, accessConfigured: false, recoveryReady: false, secondOwner: false } })),
    "Your engine reports no other way in: no Owner passkey, no Cloudflare Access, no recovery codes and no second Owner.",
    "and states plainly when there are none",
  );
}

async function requireAccessFailsSafe(): Promise<void> {
  console.log("\nrequire-access fail-safe: an unread verdict is not a permission");
  const restore = stubFetch(() => new Response("down", { status: 502 }));
  const engine = connect("https://engine.example.com") as EngineClient;
  const { renderFallbackPanel } = await import("../src/screens/access-security/fallback.ts");
  const panel = renderFallbackPanel(engine);
  document.body.appendChild(panel);
  await flushAsync();
  const text = textOf(panel);
  ok("the pre-flight is consulted on the panel that gives the advice", calls.some((c) => c.url.endsWith("/admin/policy/require-access")));
  eq(calls.find((c) => c.url.endsWith("/admin/policy/require-access"))?.method, "POST", "the pre-flight is the POST the engine serves");
  ok("a pre-flight that cannot be read withholds the closing command", !text.includes(CLOSE_COMMAND));
  ok("and says so rather than falling silent", /lock-out check could not be read/i.test(text));
  panel.remove();
  restore();
}

// ---- the removed half stays removed -------------------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

// stripComments blanks whole-line and block comments so this check grades CODE, not prose. The removal is
// deliberately DOCUMENTED where it happened (client-alerting.ts explains what went and why), and a scanner
// that read those sentences as call sites would fail on the very comment that records the fix.
//
// It is conservative on purpose: it drops only lines that OPEN with // or / * or *, and the interiors of
// block comments. Whatever it misses stays in the scanned text, so its error direction is a false ALARM the
// reader investigates, never a false clear. The self-test below pins both halves of that.
export function stripComments(code: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const line of code.split("\n")) {
    const t = line.trim();
    if (inBlock) {
      if (t.includes("*/")) inBlock = false;
      out.push("");
      continue;
    }
    if (t.startsWith("/*")) {
      if (!t.includes("*/")) inBlock = true;
      out.push("");
      continue;
    }
    if (t.startsWith("//") || t.startsWith("*")) {
      out.push("");
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

function webhookPolicyHalfStaysRemoved(): void {
  console.log("\nwebhook policy removal: no console path targets the legacy webhook policy");

  // The scanner's own honesty, first: a needle in a comment must vanish and a needle in code must survive.
  // Without this, an over-eager stripper would pass the assertions below by erasing the evidence.
  const fixture = '// getWebhookPolicy("/admin/policy/webhook")\n/*\n setWebhookPolicy\n*/\nconst live = "/admin/policy/webhook";\n';
  ok("the stripper removes a needle that is only in a comment", !stripComments(fixture).includes("getWebhookPolicy"));
  ok("and a needle inside a block comment", !stripComments(fixture).includes("setWebhookPolicy"));
  ok("and KEEPS one that is real code", stripComments(fixture).includes('const live = "/admin/policy/webhook"'));

  const files = walk(SRC);
  ok(`the scan read the console source (${files.length} files), so an absence means something`, files.length >= 200);
  const hits = files.filter((f) => stripComments(readFileSync(f, "utf8")).includes("/admin/policy/webhook")).map((f) => path.relative(SRC, f));
  eq(hits.join(", "), "", "no console module builds a request to /admin/policy/webhook");
  const methodHits = files
    .filter((f) => /\b(get|set|delete)WebhookPolicy\b/.test(stripComments(readFileSync(f, "utf8"))))
    .map((f) => path.relative(SRC, f));
  eq(methodHits.join(", "), "", "and no console module declares or calls a webhook-policy client method");
  // The replacement is real, not merely absent: the operator sets a webhook destination as a notify channel.
  const channels = readFileSync(path.join(SRC, "screens", "notifications", "channels.ts"), "utf8");
  ok("the capability is still operator-reachable, on the Notifications channels screen", channels.includes("upsertNotifyChannel"));

  // The MIRROR types that shadowed the removed engine surface must go with it, or the console keeps
  // a vocabulary member the engine can no longer emit -- a promised-but-empty class, the shape the
  // dead-vocab gate exists to refuse. The engine's ConfigChange area union dropped "notify-webhook" when
  // diffNotifyWebhook went, so the console's ConfigDiffArea must not still offer it. Read as SOURCE with
  // comments stripped, so a tombstone comment naming the old area cannot satisfy this.
  const diffTypes = stripComments(readFileSync(path.join(SRC, "lib", "api", "types", "config-history.ts"), "utf8"));
  ok("the ConfigDiffArea mirror still carries the live notify-channel area (the scan is reading the union)", diffTypes.includes('"notify-channel"'));
  ok("and no longer carries notify-webhook, which the engine cannot emit", !diffTypes.includes('"notify-webhook"'));
}

// ---- run --------------------------------------------------------------------------------------------------

await clientReadsVintages();
vintageVerdictRules();
await vintagePanelRenders();
requireAccessGating();
await requireAccessFailsSafe();
webhookPolicyHalfStaysRemoved();

console.log(failures === 0 ? "\nvalidate-surface-consumers: PASS" : `\nvalidate-surface-consumers: ${failures} FAILURE(S)`);
if (failures > 0) process.exitCode = 1;
process.exit(failures === 0 ? 0 : 1);
