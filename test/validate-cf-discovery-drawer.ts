// The cf-config discovery drawer must render THREE populations, not one bare "unavailable" count.
//
// THE GAP. The engine's cf-config surface-discovery probe (cf-config-discovery.ts, probeCfConfig) has
// always partitioned a surface it could not read into two closed buckets with opposite remedies: `gated`
// (a DEFINITIVE Cloudflare account-plan/entitlement refusal -- benign, nothing to capture, no token or
// rediscovery fixes it) and `unavailable` (a token-scope gap or other actionable/ambiguous fault -- the
// operator needs to widen the discovery token). CfConfigDiscovery on the wire has always carried both
// arrays, but the console's mirror type (src/lib/api/types/sources.ts) only ever declared `unavailable`,
// so `gated` silently read as undefined and the drawer folded both populations into one bare count with no
// way to tell a plan limitation from a permission group to add. This pins that both populations render,
// with their own counts, their own surface ids on expansion, and (for the actionable one) the doc link
// naming which permission group each surface needs.
//
//   node test/validate-cf-discovery-drawer.ts
//
// Australian English, no em dashes, no rule-of-three, precise claims.

import { installDomShim, qsa, textOf } from "./dom-shim.ts";

installDomShim();

const { cfConfigDiscoverySection } = await import("../src/screens/sources-downpipes/detail-config-section.ts");
const nav = await import("../src/lib/nav.ts");
nav.installNav({ navigate: () => {}, onUnauthorised: () => {}, refreshIdentity: async () => {}, onAuthenticated: async () => {}, signOut: () => {} });

let failures = 0;
function ok(what: string, cond: boolean): void {
  console.log(cond ? `  ok   ${what}` : `  FAIL ${what}`);
  if (!cond) failures++;
}

type Disc = { at: number; present: string[]; empty: string[]; gated: string[]; unavailable: string[] };

const fakeEngine = {} as never; // neither button is clicked below, so no engine call is ever made
const dp = { id: "dp1", name: "cf", source: { type: "cf-config", include: [], exclude: [] } } as never;

function render(disc: Disc | undefined): { root: unknown; text: string } {
  const state = { config: dp, cfConfigDiscovery: disc } as never;
  const root = cfConfigDiscoverySection(fakeEngine, dp as never, state, true, () => {});
  return { root, text: textOf(root as never) };
}

console.log("-- both populations present: each renders its own count, names and remedy --");
{
  const disc: Disc = {
    at: Date.now(),
    present: ["dns-records", "workers-routes"],
    empty: ["page-rules-legacy"],
    gated: ["logpush", "account-logpush"],
    unavailable: ["access-groups"],
  };
  const { root, text } = render(disc);
  ok("the captured count still renders", /2 surfaces in use/.test(text));
  ok("the plan-gated row states its own count", /2 surfaces not carried by this account's Cloudflare plan/.test(text));
  ok("the token-unavailable row states its own count", /1 surface not readable with this token/.test(text));
  ok("the bare 'unavailable' figure is gone from the summary hint line", !/2 unused · \d+ unavailable/.test(text));
  ok("the plan-gated remedy names a plan decision, not a token", /plan decision, not a permission gap/.test(text));
  ok("the token-unavailable remedy points at a permission group", /permission group/.test(text));
  ok("both surface ids the plan gate hit are named on the record", text.includes("logpush") && text.includes("account-logpush"));
  ok("the surface id the token gap hit is named on the record", text.includes("access-groups"));
  const links = qsa(root as never, "a").map((a) => (a as unknown as { getAttribute: (k: string) => string | null }).getAttribute("href"));
  ok(
    "the token-unavailable row links the docs permission-group table by its real anchor",
    links.includes("https://docs.downpipes.io/operations/cloudflare-config-backup-restore#permission-groups-the-read-all-resources-template-does-not-reliably-include"),
  );
  ok("the plan-gated row carries no doc link (there is no permission group to add)", links.filter((h) => h?.includes("permission-groups")).length === 1);
}

console.log("\n-- neither population: a fully readable token draws neither row --");
{
  const disc: Disc = { at: Date.now(), present: ["dns-records"], empty: [], gated: [], unavailable: [] };
  const { text } = render(disc);
  ok("no plan-gated row", !/not carried by this account's Cloudflare plan/.test(text));
  ok("no token-unavailable row", !/not readable with this token/.test(text));
}

console.log("\n-- only one population non-empty: the other row is absent, not a phantom zero --");
{
  const disc: Disc = { at: Date.now(), present: [], empty: [], gated: ["logpush"], unavailable: [] };
  const { text } = render(disc);
  ok("the plan-gated row renders", /1 surface not carried by this account's Cloudflare plan/.test(text));
  ok("no token-unavailable row for a zero population", !/not readable with this token/.test(text));
}

console.log("\n-- singular vs plural in the summary line --");
{
  const one = render({ at: Date.now(), present: [], empty: [], gated: [], unavailable: ["access-groups"] }).text;
  ok("one surface reads singular", /1 surface not readable with this token/.test(one));
  const two = render({ at: Date.now(), present: [], empty: [], gated: [], unavailable: ["access-groups", "logpush"] }).text;
  ok("two surfaces read plural", /2 surfaces not readable with this token/.test(two));
}

console.log("\n-- never discovered: neither row renders and the existing absence copy is untouched --");
{
  const { text } = render(undefined);
  ok("the not-yet-discovered hint still shows", /Not yet discovered/.test(text));
  ok("no plan-gated row with nothing discovered", !/not carried by this account's Cloudflare plan/.test(text));
  ok("no token-unavailable row with nothing discovered", !/not readable with this token/.test(text));
}

console.log(failures === 0 ? "\nCF-DISCOVERY DRAWER PASS" : `\n${failures} FAILURE(S)`);
console.log(`VERDICT: ${failures === 0 ? "PASS" : "FAIL"} failures=${failures} entry=${new URL(import.meta.url).pathname}`);
process.exit(failures === 0 ? 0 : 1);
