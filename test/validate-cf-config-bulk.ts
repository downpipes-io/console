// Validate the cf-config MULTI-ZONE bulk assembly (src/screens/sources-downpipes/bulk-assemble.ts:
// assembleCfConfigBulk + defaultCfScopePreset), the source-granularity audit's fix for two real gaps:
//   (1) a customer with N Cloudflare zones had to run the New-Downpipe wizard N times (the zone picker
//       was a single-pick radio) -- assembleCfConfigBulk turns a ticked ZONE selection into one
//       downpipe per zone, reusing the same AssembledCreate shape + bulk-create path as kv/r2/d1.
//   (2) every zone-scoped cf-config downpipe ALSO re-captured every ~195 account surface (a zone
//       source's applicable() returns account surfaces too), so N zones duplicated the account config
//       N times -- the "zone-only" scope preset restricts a zone downpipe's include to exactly the
//       catalogue's scope:"zone" ids, and a ticked ACCOUNT gets its own separate account-wide downpipe
//       instead (the "all ticked -> compact auto form" invariant re-expressed here: the account-and-zone
//       preset must still send the compact include:[] + cfConfigMode:auto form, never a redundant full id
//       list).
//
// Run with `node test/validate-cf-config-bulk.ts`. No DOM, no network: every function under test is pure.

import {
  assembleCfConfigBulk,
  defaultCfScopePreset,
  type CfConfigAccountTick,
  type CfConfigZoneTick,
} from "../src/screens/sources-downpipes/bulk-assemble.ts";
import type { SourceSpec } from "../src/api.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

const ZONE_SURFACE_IDS = ["dns_records", "page_rules", "waf_custom_rules"];

function zone(id: string, zoneName: string, accountId = "acct1"): CfConfigZoneTick {
  return { zoneId: id, zoneName, accountId };
}
function account(accountId: string, accountName: string, multiAccount: boolean): CfConfigAccountTick {
  return { accountId, accountName, multiAccount };
}

async function main(): Promise<void> {
  console.log("-- defaultCfScopePreset: the default only changes once it would actually be wasteful --");
  ok("0 zones -> account-and-zone (today's exact single-zone behaviour, no zones to duplicate)", defaultCfScopePreset(0) === "account-and-zone");
  ok("1 zone -> account-and-zone (a one-zone customer sees no change at all)", defaultCfScopePreset(1) === "account-and-zone");
  ok("2 zones -> zone-only (the audit's fix: the wasteful default flips once duplication is real)", defaultCfScopePreset(2) === "zone-only");
  ok("10 zones -> zone-only", defaultCfScopePreset(10) === "zone-only");

  console.log("-- assembleCfConfigBulk: \"zone-only\" preset never duplicates the account surfaces --");
  {
    const out = assembleCfConfigBulk([zone("z1", "northwind.example")], [], "zone-only", ZONE_SURFACE_IDS, 86400, []);
    ok("one zone ticked -> one downpipe", out.length === 1);
    const src = out[0]!.dp.source;
    ok("zone-only: zoneId + accountId carried", src.zoneId === "z1" && src.accountId === "acct1");
    ok("zone-only: include is EXACTLY the zone-scoped ids, never empty (never silently \"all\")", JSON.stringify(src.include) === JSON.stringify(ZONE_SURFACE_IDS));
    ok("zone-only: cfConfigMode is manual (an explicit restricted selection, not auto-discovery)", src.cfConfigMode === "manual");
    ok("zone-only: exclude is empty", src.exclude.length === 0);
    ok("zone-only: the label is the raw zone name (failure reporting)", out[0]!.label === "northwind.example");
    ok("zone-only: the downpipe name derives via friendlyName (a domain has no SRC_/underscore to strip)", out[0]!.dp.name === "northwind.example");
  }
  {
    // Multiple zones ticked -> ONE downpipe EACH, all independently scoped to zone-only surfaces
    // (the actual bulk-create fix: an N-zone customer stops running the wizard N times).
    const ticks = [zone("z1", "alpha.example"), zone("z2", "beta.example"), zone("z3", "gamma.example")];
    const out = assembleCfConfigBulk(ticks, [], "zone-only", ZONE_SURFACE_IDS, 3600, []);
    ok("3 zones ticked -> 3 downpipes, not 1", out.length === 3);
    ok("every zone downpipe gets the SAME zone-only include list", out.every((a) => JSON.stringify(a.dp.source.include) === JSON.stringify(ZONE_SURFACE_IDS)));
    const ids = new Set(out.map((a) => a.dp.id));
    ok("every downpipe gets a distinct id (slugId's random suffix, even same-shaped names)", ids.size === 3);
    ok("every downpipe carries its own zoneId", out.map((a) => a.dp.source.zoneId).join(",") === "z1,z2,z3");
  }

  console.log("-- assembleCfConfigBulk: \"account-and-zone\" preset keeps today's exact single-zone behaviour --");
  {
    const out = assembleCfConfigBulk([zone("z1", "northwind.example")], [], "account-and-zone", ZONE_SURFACE_IDS, 86400, []);
    const src = out[0]!.dp.source;
    // console-src-054-02's invariant, re-expressed for the bulk path: "every surface" is ALWAYS the
    // compact include:[] + cfConfigMode:auto wire form, never a redundant full id list, regardless of
    // how many ids the catalogue holds.
    ok("account-and-zone: include:[] (the compact \"every surface\" form)", src.include.length === 0);
    ok("account-and-zone: cfConfigMode auto (discovery decides what's captured, not a fixed list)", src.cfConfigMode === "auto");
    ok("account-and-zone: zoneId still carried (this preset keeps the zone identity)", src.zoneId === "z1");
  }

  console.log("-- assembleCfConfigBulk: ticked ACCOUNTS get their own account-wide downpipe --");
  {
    const out = assembleCfConfigBulk([], [account("acct1", "Acct One", false)], "zone-only", ZONE_SURFACE_IDS, 86400, []);
    ok("one account ticked -> one downpipe", out.length === 1);
    const src = out[0]!.dp.source as SourceSpec;
    ok("account downpipe carries NO zoneId (the engine then yields only account surfaces)", !("zoneId" in src) || src.zoneId === undefined);
    ok("account downpipe include:[] (every account surface, auto)", src.include.length === 0 && src.cfConfigMode === "auto");
    ok("single-account label: \"Account-wide configuration\" (matches the row's own label)", out[0]!.dp.name === "Account-wide configuration");
  }
  {
    const out = assembleCfConfigBulk([], [account("acct2", "Southwind Pty Ltd", true)], "zone-only", ZONE_SURFACE_IDS, 86400, []);
    ok("multi-account label: \"<name> configuration\" disambiguates which account", out[0]!.dp.name === "Southwind Pty Ltd configuration");
  }

  console.log("-- assembleCfConfigBulk: \"account-only\" preset --");
  {
    // account-only: a ticked account -> one zoneId-less account-config downpipe. The account loop
    // (unlike the zone loop) never reads `preset` at all, so the shape is identical to the zone-only-
    // preset case above -- included here under the preset the operator actually picks in this flow.
    const out = assembleCfConfigBulk([], [account("acct1", "Acct One", false)], "account-only", ZONE_SURFACE_IDS, 86400, []);
    ok("account-only: one account ticked -> one downpipe", out.length === 1);
    const src = out[0]!.dp.source as SourceSpec;
    ok("account-only: NO zoneId on the account downpipe (the engine then yields only account surfaces)", !("zoneId" in src) || src.zoneId === undefined);
    ok("account-only: include:[] + cfConfigMode auto (the compact \"every surface\" form)", src.include.length === 0 && src.cfConfigMode === "auto");
  }
  {
    // Pinning the ACTUAL contract for a ticked ZONE under "account-only". The wizard-level invariant
    // (the C.4/C.5 preset-switch clears in editor-wizard-source-rows.ts) guarantees the operator can
    // never reach this state through the UI -- switching TO "account-only" clears every ticked zone.
    // But assembleCfConfigBulk itself is a PURE function with no defensive filter on `zones`: it loops
    // the array unconditionally regardless of preset -- only the `zoneOnly` ternary
    // (`preset === "zone-only"`) varies a zone entry's shape, and "account-only" collapses into the
    // SAME `include: []` / `cfConfigMode: "auto"` branch as "account-and-zone" (the source comment
    // above the zones loop calls this "the moot account-only, which never ticks a zone" -- moot at the
    // UI, not enforced here). So a zone tick that ever reached this function alongside "account-only"
    // would NOT be silently dropped: it still mints its own zone downpipe, indistinguishable in shape
    // from what "account-and-zone" would produce. Pinned so a future caller bug (a wizard path that
    // forgets to clear zones before calling this) fails loud in this unit test rather than silently
    // duplicating config in production.
    const out = assembleCfConfigBulk([zone("z1", "stray.example")], [], "account-only", ZONE_SURFACE_IDS, 86400, []);
    ok("account-only + an off-contract ticked zone is NOT silently dropped -- still produces a downpipe", out.length === 1);
    const src = out[0]!.dp.source;
    ok("...carrying its zoneId (the assembler has no account-only-specific zone filter)", src.zoneId === "z1");
    ok("...in the compact \"every surface\" shape (include:[] + auto), identical to what account-and-zone would produce", src.include.length === 0 && src.cfConfigMode === "auto");
  }

  console.log("-- assembleCfConfigBulk: mixed zones + accounts in one batch, fan-out, cadence --");
  {
    // The "This zone only" preset's own offer: N zone-only downpipes PLUS the one account-config
    // downpipe, backing up the account exactly once instead of N times or not at all.
    const ticks = [zone("z1", "alpha.example"), zone("z2", "beta.example")];
    const accts = [account("acct1", "Acct One", false)];
    const out = assembleCfConfigBulk(ticks, accts, "zone-only", ZONE_SURFACE_IDS, 21600, ["dest-b", "dest-a"]);
    ok("2 zones + 1 account -> 3 downpipes total", out.length === 3);
    ok("zones come first, then the account downpipe", out[0]!.dp.source.zoneId === "z1" && out[1]!.dp.source.zoneId === "z2" && !("zoneId" in out[2]!.dp.source));
    ok("every downpipe in the batch carries the SAME cadence", out.every((a) => a.dp.cadenceSeconds === 21600));
    ok("every downpipe in the batch pins the ordered destination fan-out", out.every((a) => JSON.stringify(a.dp.destinationIds) === JSON.stringify(["dest-b", "dest-a"])));
  }
  {
    // An empty destination selection follows the default (no destinationIds field at all), exactly
    // like assembleBulkDownpipes's kv/r2/d1 assembly.
    const out = assembleCfConfigBulk([zone("z1", "alpha.example")], [account("acct1", "Acct One", false)], "zone-only", ZONE_SURFACE_IDS, 86400, []);
    ok("empty destinationIds -> the field is OMITTED (follows the default), on both a zone and an account downpipe", out.every((a) => !("destinationIds" in a.dp)));
  }
  {
    const out = assembleCfConfigBulk([], [], "zone-only", ZONE_SURFACE_IDS, 86400, []);
    ok("nothing ticked -> an empty batch (no phantom downpipe)", out.length === 0);
  }

  console.log(failures === 0 ? "\nCF-CONFIG BULK VECTORS PASS" : `\n${failures} FAILURE(S)`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
