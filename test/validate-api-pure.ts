// validate-api: the pure helpers in src/api.ts and the client/server plan-hash parity.
//
// Coverage (sections 1-5, unchanged from the original single-file suite):
//   1: restorePlanHash CLIENT/SERVER PARITY (the highest-risk assertion)
//   2: engineOriginError / EngineClient origin guard
//   3: roleRank / hasRole
//   4: projectMonthlyKVReads
//   5: listHistory .entries unwrap (logic parity, no network)
//
// NOTE: projectMonthlyKVReads(n, 0) is guarded to 0 (see section 4e); the source's own
// behaviour is asserted, not changed.

import {
  restorePlanHash as consoleRestorePlanHash,
  EngineClient,
  engineOriginError,
  hasRole,
  projectMonthlyKVReads,
  type Role,
  type RunHistoryEntry,
  type RestoreRequest,
  roleRank,
} from "../src/api.ts";
import { cadenceSecondsToRunsPerMonth } from "../src/lib/cost-model.ts";


import { importFromEngine } from "./engine-path.ts";
import { type Harness, unwrapEntries } from "./validate-api-shared.ts";

export async function runPure(h: Harness): Promise<void> {
  const ok = h.ok.bind(h);
  const eq = h.eq.bind(h);
  await runPlanHashParity(h);


  // ==========================================================================
  // SECTION 2: engineOriginError / EngineClient origin guard
  // ==========================================================================
  console.log("\n-- engineOriginError / EngineClient origin guard --");

  // 2a. Acceptable origins (should return null).
  ok("https scheme accepted (null)", engineOriginError("https://engine.example.com") === null);
  ok("https with path accepted (null)", engineOriginError("https://engine.example.com/admin") === null);
  ok("http://localhost accepted (null)", engineOriginError("http://localhost") === null);
  ok("http://localhost:8787 accepted (null)", engineOriginError("http://localhost:8787") === null);
  ok("http://127.0.0.1 accepted (null)", engineOriginError("http://127.0.0.1") === null);
  ok("http://127.0.0.1:8787 accepted (null)", engineOriginError("http://127.0.0.1:8787") === null);
  ok("http://[::1] accepted (null)", engineOriginError("http://[::1]") === null);
  ok("http://[::1]:8787 accepted (null)", engineOriginError("http://[::1]:8787") === null);
  ok("http://foo.localhost accepted (null)", engineOriginError("http://foo.localhost") === null);
  ok("http://dev.localhost:9000 accepted (null)", engineOriginError("http://dev.localhost:9000") === null);

  // 2b. Rejected origins (non-null error message).
  ok("http on non-loopback rejected", engineOriginError("http://example.com") !== null);
  ok("http on LAN IP rejected", engineOriginError("http://192.168.1.1") !== null);
  ok("http on 0.0.0.0 rejected", engineOriginError("http://0.0.0.0:8787") !== null);
  ok("ftp scheme rejected", engineOriginError("ftp://localhost") !== null);
  ok("unparseable URL rejected", engineOriginError("not-a-url") !== null);
  ok("empty string rejected", engineOriginError("") !== null);
  ok("bare ::1 without brackets rejected", engineOriginError("http://::1") !== null);

  // 2c. Error message content.
  const nonLocalhostMsg = engineOriginError("http://example.com");
  ok("non-localhost error mentions https", (nonLocalhostMsg?.toLowerCase().includes("https") ?? false));
  const invalidMsg = engineOriginError("garbage");
  ok("invalid URL error mentions valid URL", (invalidMsg?.toLowerCase().includes("valid url") ?? false));

  // 2d. EngineClient constructor enforces the same guard (throws on rejection).
  {
    let threw = false;
    try {
      new EngineClient("http://example.com");
    } catch {
      threw = true;
    }
    ok("EngineClient throws on http non-loopback", threw);
  }
  {
    let threw = false;
    try {
      new EngineClient("not-a-url");
    } catch {
      threw = true;
    }
    ok("EngineClient throws on invalid URL", threw);
  }
  // Acceptable origins must NOT throw.
  {
    let threw = false;
    try {
      new EngineClient("https://engine.example.com");
    } catch {
      threw = true;
    }
    ok("EngineClient does not throw on https", !threw);
  }
  {
    let threw = false;
    try {
      new EngineClient("http://localhost:8787");
    } catch {
      threw = true;
    }
    ok("EngineClient does not throw on http localhost", !threw);
  }

  // ==========================================================================
  // SECTION 3: roleRank and hasRole
  // ==========================================================================
  console.log("\n-- roleRank / hasRole --");

  // 3a. Rank ordering: viewer=0, operator=1, approver=2, owner=3.
  eq(roleRank("viewer"), 0, "roleRank(viewer) = 0");
  eq(roleRank("operator"), 1, "roleRank(operator) = 1");
  eq(roleRank("approver"), 2, "roleRank(approver) = 2");
  eq(roleRank("owner"), 3, "roleRank(owner) = 3");
  ok("viewer < operator < approver < owner (strict ordering)", roleRank("viewer") < roleRank("operator") && roleRank("operator") < roleRank("approver") && roleRank("approver") < roleRank("owner"));

  // 3b. hasRole: cumulative, >= check.
  const roles: Role[] = ["viewer", "operator", "approver", "owner"];
  for (const role of roles) {
    ok(`hasRole(${role}, ${role}) is true (self)`, hasRole(role, role));
  }
  ok("hasRole(owner, viewer) is true", hasRole("owner", "viewer"));
  ok("hasRole(owner, operator) is true", hasRole("owner", "operator"));
  ok("hasRole(owner, approver) is true", hasRole("owner", "approver"));
  ok("hasRole(approver, viewer) is true", hasRole("approver", "viewer"));
  ok("hasRole(approver, operator) is true", hasRole("approver", "operator"));
  ok("hasRole(operator, viewer) is true", hasRole("operator", "viewer"));

  // 3c. hasRole: lower roles do NOT satisfy higher thresholds.
  ok("hasRole(viewer, operator) is false", !hasRole("viewer", "operator"));
  ok("hasRole(viewer, approver) is false", !hasRole("viewer", "approver"));
  ok("hasRole(viewer, owner) is false", !hasRole("viewer", "owner"));
  ok("hasRole(operator, approver) is false", !hasRole("operator", "approver"));
  ok("hasRole(operator, owner) is false", !hasRole("operator", "owner"));
  ok("hasRole(approver, owner) is false", !hasRole("approver", "owner"));

  // ==========================================================================
  // SECTION 4: projectMonthlyKVReads
  // ==========================================================================
  console.log("\n-- projectMonthlyKVReads --");

  // The month these cases are stated in is the cost library's DAYS_PER_MONTH (30.44), the
  // averaging constant every runs-per-month figure in the console is computed over. The
  // expected figures below are written out from that requirement, NOT copied back out of the
  // implementation: a month is 30.44 x 86400 = 2 630 016 seconds, so the runs-per-month for a
  // cadence is 2 630 016 / cadenceSeconds.
  //
  // Until these three cases asserted a 30-day month (720 000, 15 000, 370 286),
  // which is what src/lib/api/helpers.ts computed at the time and 1.4 per cent under what the
  // costs screen priced the same schedule at. The assertions were wrong about the month, not
  // about the behaviour; they are restated here rather than relaxed.

  // 4a. Hourly cadence (3600 s): runs/month = 2 630 016 / 3600 = 730.56.
  //     1000 records * 730.56 runs = 730 560.
  eq(projectMonthlyKVReads(1000, 3600), 730_560, "1000 records hourly = 730 560 reads/month");

  // 4b. Daily cadence (86400 s): runs/month = 2 630 016 / 86400 = 30.44 (the month itself).
  //     500 records * 30.44 runs = 15 220.
  eq(projectMonthlyKVReads(500, 86400), 15_220, "500 records daily = 15 220 reads/month");

  // 4c. Zero records produces 0 regardless of cadence.
  eq(projectMonthlyKVReads(0, 3600), 0, "0 records => 0 reads (hourly)");
  eq(projectMonthlyKVReads(0, 86400), 0, "0 records => 0 reads (daily)");

  // 4d. The result is a whole number (Math.round applied).
  //     1 record, cadence = 7 s: runs/month = 2 630 016 / 7 = 375 716.571... -> round -> 375 717.
  //     The expected value is written out, not recomputed from the same expression the source
  //     uses, so this case can actually fail if the projection changes.
  eq(projectMonthlyKVReads(1, 7), 375_717, "result is rounded (fractional runs)");
  ok("a fractional-run projection is an integer", Number.isInteger(projectMonthlyKVReads(1, 7)));

  // 4f. The steer and the price agree. The downpipe editor's bill-shock projection and the
  //     costs screen must report the same runs-per-month for the same cadence; they disagreed
  //     by 1.4 per cent while this projection carried its own 30-day month. This is the
  //     cross-module requirement, so it is asserted against the cost library directly.
  for (const cadenceSeconds of [900, 3600, 21600, 86400, 604800]) {
    eq(
      projectMonthlyKVReads(1000, cadenceSeconds),
      Math.round(1000 * cadenceSecondsToRunsPerMonth(cadenceSeconds)),
      `cadence ${cadenceSeconds}s projects the cost library's runs-per-month`,
    );
  }

  // 4e. cadenceSeconds=0 (an invalid or not-yet-set cadence) must yield 0, never a
  //     division-by-zero Infinity that would poison downstream cost estimates.
  const zeroCadence = projectMonthlyKVReads(100, 0);
  eq(zeroCadence, 0, "cadenceSeconds=0 yields 0 reads, not Infinity");
  ok("cadenceSeconds=0 result is finite", Number.isFinite(zeroCadence));

  // ==========================================================================
  // SECTION 5: listHistory .entries unwrap (logic parity, no network)
  // ==========================================================================
  console.log("\n-- listHistory .entries unwrap logic --");

  // 5a. Envelope with entries array unwraps to the array.
  {
    const entry: RunHistoryEntry = { runId: "r1", index: 1, startedAt: "2026-01-01T00:00:00Z", status: "ok" };
    const result = unwrapEntries({ entries: [entry] });
    ok(".entries with one entry unwraps to length-1 array", result.length === 1);
    ok(".entries[0].runId is preserved", result[0]?.runId === "r1");
  }

  // 5b. Empty entries array stays empty.
  {
    const result = unwrapEntries({ entries: [] });
    ok(".entries:[] unwraps to empty array", result.length === 0);
  }

  // 5c. No entries key (absent): fallback to [].
  {
    const result = unwrapEntries({});
    ok("absent .entries falls back to []", result.length === 0);
  }

  // 5d. Entries: undefined (exact-optional: absent and undefined are the same at runtime).
  {
    // exactOptionalPropertyTypes: we cannot pass entries:undefined to the typed helper without
    // a cast, so use the cast to match what a real JSON parse might produce.
    const result = unwrapEntries({ entries: undefined } as unknown as { entries?: RunHistoryEntry[] });
    ok(".entries:undefined falls back to []", result.length === 0);
  }

  // 5e. Multiple entries are all preserved.
  {
    const e1: RunHistoryEntry = { runId: "r1", index: 1, startedAt: "2026-01-01T00:00:00Z", status: "ok" };
    const e2: RunHistoryEntry = { runId: "r2", index: 2, startedAt: "2026-01-02T00:00:00Z", status: "failed", error: "timeout" };
    const result = unwrapEntries({ entries: [e1, e2] });
    ok(".entries with two entries preserves both", result.length === 2);
    ok(".entries[1].status is 'failed'", result[1]?.status === "failed");
  }
}

// The engine's authoritative restorePlanHash (the server side of the dual-control hash), loaded by
// a guarded dynamic import rather than a static one, so a checkout with no engine available skips
// the parity block with a visible note instead of dying at module load; see test/engine-path.ts.
interface EngineApprovals {
  restorePlanHash: (req: RestoreRequest) => Promise<string>;
  resolveCfConfigSurfaces: (explicit?: readonly string[]) => string[];
}
async function loadEngineApprovals(): Promise<EngineApprovals | null> {
  const here = new URL(".", import.meta.url).pathname;
  return await importFromEngine<EngineApprovals>(here, "src/admin/approvals.ts");
}

// Section 1, extracted so the engine-parity cross-check can be skipped as a unit when the engine is
// not checked out beside this repo, without taking sections 2 to 5 down with it.
async function runPlanHashParity(h: Harness): Promise<void> {
  const ok = h.ok.bind(h);
  const _eq = h.eq.bind(h);
  console.log("\n-- plan-hash parity --");
  const engineApprovals = await loadEngineApprovals();
  const engineRestorePlanHash = engineApprovals?.restorePlanHash ?? null;
  const engineResolveSurfaces = engineApprovals?.resolveCfConfigSurfaces ?? null;
  if (engineRestorePlanHash === null) {
    console.log("  note engine checkout not available; skipping the plan-hash parity cross-check");
    return;
  }


  // 1a. Minimal request: runId only, no optional fields.
  {
    const req = { runId: "01HXYZ-MINIMAL" };
    const ch = await consoleRestorePlanHash(req);
    const eh = await engineRestorePlanHash(req);
    ok("parity: minimal request (runId only)", ch === eh);
    ok("hash has sha384: prefix", ch.startsWith("sha384:"));
    ok("hash hex is 96 chars after prefix", ch.slice("sha384:".length).length === 96);
  }

  // 1b. Full request: all decision-relevant fields present.
  {
    const req = {
      runId: "01HXYZ-FULL",
      target: { binding: "MY_KV", namespaceId: "ns-abc123", bucketName: "my-bucket" },
      include: ["prefix/a/", "prefix/b/"],
      exclude: ["secret/", "tmp/"],
      maxRecords: 500,
    };
    const ch = await consoleRestorePlanHash(req);
    const eh = await engineRestorePlanHash(req);
    ok("parity: full request (all fields)", ch === eh);
  }

  // 1c. Target with only namespaceId (partial target, no binding or bucketName).
  {
    const req = { runId: "01HXYZ-PARTIAL", target: { namespaceId: "ns-only" } };
    const ch = await consoleRestorePlanHash(req);
    const eh = await engineRestorePlanHash(req);
    ok("parity: partial target (namespaceId only)", ch === eh);
  }

  // 1d. Include/exclude present but target absent.
  {
    const req = { runId: "01HXYZ-SELECTORS", include: ["a/", "b/"], exclude: ["c/"] };
    const ch = await consoleRestorePlanHash(req);
    const eh = await engineRestorePlanHash(req);
    ok("parity: selectors, no target", ch === eh);
  }

  // 1e. maxRecords present vs absent: different hashes, but each side agrees.
  {
    const reqWith = { runId: "01HXYZ-CAP", maxRecords: 100 };
    const reqWithout = { runId: "01HXYZ-CAP" };
    const cWith = await consoleRestorePlanHash(reqWith);
    const eWith = await engineRestorePlanHash(reqWith);
    const cWithout = await consoleRestorePlanHash(reqWithout);
    const eWithout = await engineRestorePlanHash(reqWithout);
    ok("parity: maxRecords present", cWith === eWith);
    ok("parity: maxRecords absent", cWithout === eWithout);
    ok("optional maxRecords: absent != present (re-arm)", cWithout !== cWith);
  }

  // 1f. Target key-order independence: inserting object properties in a different order
  //     must produce the same hash (canonical JSON sorts keys).
  {
    const reqA = {
      runId: "01HXYZ-ORDER",
      target: { binding: "B", namespaceId: "N", bucketName: "K" },
      include: ["p/"],
      exclude: [],
    };
    // Same data but target properties in reverse insertion order.
    const reqB = {
      include: ["p/"],
      runId: "01HXYZ-ORDER",
      target: { bucketName: "K", binding: "B", namespaceId: "N" },
      exclude: [],
    };
    const hA = await consoleRestorePlanHash(reqA);
    const hB = await consoleRestorePlanHash(reqB);
    ok("key-order independence: console hashes equal regardless of insertion order", hA === hB);
    // Engine also produces the same value (already validated via parity above, belt-and-braces).
    const hAe = await engineRestorePlanHash(reqA);
    ok("key-order independence: engine agrees with console hash", hA === hAe);
  }

  // 1g. Re-arm invariant: every decision-field change yields a different hash.
  {
    const base = {
      runId: "01HXYZ-BASE",
      target: { binding: "KV" },
      include: ["a/"],
      exclude: ["b/"],
      maxRecords: 10,
    };
    const hBase = await consoleRestorePlanHash(base);

    const changedRunId = { ...base, runId: "01HXYZ-OTHER" };
    ok("re-arm: changed runId => different hash", hBase !== await consoleRestorePlanHash(changedRunId));

    const changedBinding = { ...base, target: { binding: "KV2" } };
    ok("re-arm: changed target.binding => different hash", hBase !== await consoleRestorePlanHash(changedBinding));

    const changedInclude = { ...base, include: ["x/"] };
    ok("re-arm: changed include => different hash", hBase !== await consoleRestorePlanHash(changedInclude));

    const changedExclude = { ...base, exclude: ["y/"] };
    ok("re-arm: changed exclude => different hash", hBase !== await consoleRestorePlanHash(changedExclude));

    const changedMaxRecords = { ...base, maxRecords: 99 };
    ok("re-arm: changed maxRecords => different hash", hBase !== await consoleRestorePlanHash(changedMaxRecords));

    const droppedTarget = { runId: base.runId, include: base.include, exclude: base.exclude, maxRecords: base.maxRecords };
    ok("re-arm: target removed => different hash", hBase !== await consoleRestorePlanHash(droppedTarget));
  }

  // 1h. confirm field is NOT decision-relevant: including or omitting it must not change the hash.
  //     The console's restorePlanHash signature does not accept confirm, so we verify the engine
  //     likewise ignores it by passing a RestoreRequest with confirm:true vs omitted.
  {
    const reqDry = { runId: "01HXYZ-CONFIRM", include: ["k/"] };
    const reqConfirm = { runId: "01HXYZ-CONFIRM", confirm: true as const, include: ["k/"] };
    const hDry = await engineRestorePlanHash(reqDry);
    const hConfirm = await engineRestorePlanHash(reqConfirm);
    ok("confirm field is NOT hashed (dry-run == apply request hash)", hDry === hConfirm);
    // Console mirror also matches (confirm not in its signature, so hDry is the canonical value).
    const hConsole = await consoleRestorePlanHash(reqDry);
    ok("parity: confirm-ignored engine hash == console hash", hConsole === hDry);
  }

  // 1i. GRANULAR single-record request ({ runId, recordName }): the recordName branch
  //     (helpers.ts:134, engine approvals.ts) must hash identically on both sides, and a
  //     single-record plan must differ from the whole-run plan so a granular apply carries
  //     its own approval. This is the exact branch the confirm.ts field-drop bug lived in.
  {
    const req = { runId: "01HXYZ-RECORD", recordName: "prefix/key-007" };
    const ch = await consoleRestorePlanHash(req);
    const eh = await engineRestorePlanHash(req);
    ok("parity: single-record request (runId + recordName)", ch === eh);
    const whole = await consoleRestorePlanHash({ runId: "01HXYZ-RECORD" });
    ok("re-arm: recordName present != absent (granular plan differs from whole-run)", ch !== whole);
    const otherRecord = await consoleRestorePlanHash({ runId: "01HXYZ-RECORD", recordName: "prefix/key-008" });
    ok("re-arm: changed recordName => different hash", ch !== otherRecord);
  }

  // 1j. cf-config request: the cfConfig branch must hash identically on both sides.
  //
  // THE SURFACE SET IS PART OF THE BINDING (F10), and that is what this block is really pinning. Widening
  // the set of Cloudflare surfaces a restore may write must invalidate an approval granted for a narrower
  // one, so the engine binds the RESOLVED allow-list, not just the account and zone.
  //
  // The console cannot re-derive that list: the default is the engine's proven set, and a second copy of
  // that rule in the console would drift the moment a surface is proven. So the engine reports the list it
  // resolved on the plan (RestorePlan.cfConfigSurfaces) and the console hashes THAT. This asserts the real
  // contract by driving both sides with the engine's own resolver.
  //
  // This block was failing for a real reason before that wiring existed: the engine bound the surfaces and
  // the console did not, so every cf-config restore showed the operator a hash the approval did not bind
  // to. It is asserted in BOTH directions now, because a mirror that ignores the surface set passes any
  // test that only ever supplies one value for it.
  {
    const surfaces = engineResolveSurfaces === null ? [] : engineResolveSurfaces(undefined);
    ok("the engine resolves a non-empty default surface set, so the assertions below are not vacuous", surfaces.length > 0);
    const cf = { accountId: "acc-123", zoneId: "zone-abc" };
    const req = { runId: "01HXYZ-CFCFG", cfConfig: { ...cf, surfaces } };
    const ch = await consoleRestorePlanHash(req);
    // The engine takes the request as the console SENDS it (no surfaces on the wire) and resolves the
    // default itself, which is exactly what happens at /restore/request and at the apply gate.
    // The ENGINE's cfConfig requires a token; the console mirror's type does not carry one at all, because
    // the token is a credential the hash preimage must never include. That asymmetry is the contract, so the
    // token supplied here is a throwaway literal and the assertion below is what proves it is not hashed:
    // the console computes the same digest from an object that has no token field to give.
    const eh = await engineRestorePlanHash({ runId: "01HXYZ-CFCFG", cfConfig: { ...cf, token: "dp-not-hashed" } });
    ok("parity: console hashing the engine's resolved surfaces == engine resolving them itself", ch === eh);

    // The direction that catches a mirror which drops the field: omitting the surfaces must NOT produce the
    // same hash, or the binding is decorative and F10 buys nothing.
    const noSurfaces = await consoleRestorePlanHash({ runId: "01HXYZ-CFCFG", cfConfig: cf });
    ok("a mirror that omits the surface set does NOT match the engine", noSurfaces !== eh);
    const narrower = await consoleRestorePlanHash({ runId: "01HXYZ-CFCFG", cfConfig: { ...cf, surfaces: surfaces.slice(0, Math.max(1, surfaces.length - 1)) } });
    ok("re-arm: a NARROWER surface set => different hash", narrower !== ch);

    // EXPLICIT-UNDEFINED PARITY, which is what this actually tests. There is no token in cfConfig at all:
    // the media edit token lives on mediaRestore and
    // helpers.ts already documents that only its accountId is bound. What is being pinned here is the
    // documented rule one line below that: an absent optional key and an explicit-undefined one must hash
    // identically, because the engine builds its preimage by spread-when-present.
    //
    // The cast is deliberate and cannot be avoided by writing the call differently. exactOptionalPropertyTypes
    // makes `mediaRestore: undefined` a type error at the call site, and passing it is the entire point of the
    // assertion, so the alternative is to delete the property and compare an expression with itself.
    const explicitUndefined = await consoleRestorePlanHash({ runId: "01HXYZ-CFCFG", cfConfig: { ...cf, surfaces }, mediaRestore: undefined } as unknown as Parameters<typeof consoleRestorePlanHash>[0]);
    ok("an explicit-undefined optional hashes the same as an absent one (spread-when-present parity)", ch === explicitUndefined);
    const otherZone = await consoleRestorePlanHash({ runId: "01HXYZ-CFCFG", cfConfig: { accountId: "acc-123", zoneId: "zone-xyz", surfaces } });
    ok("re-arm: changed cfConfig.zoneId => different hash", ch !== otherZone);
    const noZone = await consoleRestorePlanHash({ runId: "01HXYZ-CFCFG", cfConfig: { accountId: "acc-123", surfaces } });
    ok("re-arm: cfConfig zoneId present != absent", ch !== noZone);
  }
}

