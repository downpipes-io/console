// Prove the console's client-side restore plan-hash mirror (api.ts restorePlanHash) matches
// the engine value byte-for-byte. Run with `node test/validate-plan-hash.ts`.
//
// WHY this matters. A restore APPLY over live data is gated by a dual-control approval keyed on a
// canonical hash of the request's decision-relevant fields (the planHash). The engine recomputes the
// hash server-side at /restore/request and at the apply gate and is the sole authority. The console
// re-derives the SAME value client-side ONLY so the restore screen can show the operator the exact
// hash an approval binds to and re-arm (re-hide Apply) the instant a changed request yields a new
// hash (the re-arm-on-change UX). If the two derivations drifted, the console
// would show a hash that no engine approval matches, or worse, fail to re-arm on a change. So the
// mirror MUST equal the engine value exactly:
//   planHash = "sha384:" + hex(SHA-384(canonicalJSON({ runId, target, include, exclude, maxRecords? })))
// where canonicalJSON is the engine's sorted-key, compact, integer-only form and each optional key is
// present only when it carries a value (exactOptionalPropertyTypes parity).
//
// The binding is over names, counts and selectors ONLY: NO plaintext, NO key, so computing it in the
// browser leaks nothing (no-custody preserved).
//
// This file proves the mirror two ways:
//   1. REFERENCE: an independent reimplementation of the engine algorithm (canonical JSON + SHA-384,
//      the same primitives the codebase uses for fingerprints) computes the expected hash for a corpus
//      of request vectors, and the console restorePlanHash is asserted equal. This pins the console to
//      the SPEC and is fully hermetic (no engine checkout needed). A handful of golden literals guard
//      the reference itself against an accidental rewrite.
//   2. PARITY: when an engine checkout is available, the engine's own restorePlanHash is imported and
//      asserted equal to the console's over the same corpus, so the two implementations cannot drift.
//      The import is guarded: without one, the parity block is skipped with a note (the reference
//      block still pins the contract); it never fails the console suite.
//
// Plus the binding invariants: request-only (isLatest/plannedWrites/bytes/confirm are NOT hashed),
// re-arm-on-change (any decision-field change changes the hash), and exactOptional parity (an absent
// optional field and an explicit-undefined one hash identically).

import { importFromEngine } from "./engine-path.ts";
import { restorePlanHash } from "../src/api.ts";
import { sha384Hex } from "../src/bytes.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}
function eq(label: string, got: string, want: string): void {
  const cond = got === want;
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}\n       got  ${got}\n       want ${want}`);
  if (!cond) failures++;
}

// ---- the request type the mirror accepts (decision-relevant fields only) -------------------------
// confirm/isLatest/plannedWrites/bytes are deliberately NOT on this shape: they are plan OUTPUTS or
// the apply flag, never folded into the binding. The corpus passes some of them through a wider object
// to prove restorePlanHash ignores everything but the decision fields.
type PlanReq = {
  runId: string;
  target?: { binding?: string; namespaceId?: string; bucketName?: string };
  include?: string[];
  exclude?: string[];
  maxRecords?: number;
  // recordName binds a GRANULAR single-record restore into the hash; mirrors the engine.
  recordName?: string;
  // cfConfig binds the Cloudflare-config apply target into the hash (token excluded): the account, the
  // optional zone, and the RESOLVED surface allow-list (F10, so widening the set invalidates an approval
  // granted for a narrower one). Mirrors the engine.
  cfConfig?: { accountId: string; zoneId?: string; surfaces?: string[] };
  // mediaRestore binds the media re-upload account into the hash (token excluded); mirrors the engine.
  mediaRestore?: { token?: string; accountId: string };
  // d1Tables binds the D1 table-subset scope (database + lower-cased/deduped/sorted tables + createOnly when true); mirrors the engine.
  d1Tables?: { database: string; tables: string[]; createOnly?: boolean };
};

const RUN = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
// Two long-proven in-band surfaces, in sorted order. See the note on the corpus vectors below.
const CF_SURFACES = ["dns", "zone-settings"];

// ---- the corpus: the shapes a real restore request takes -----------------------------------------
const CORPUS: { label: string; req: PlanReq }[] = [
  { label: "bare runId (whole-run restore-in-place)", req: { runId: RUN } },
  { label: "include selector", req: { runId: RUN, include: ["user:"] } },
  { label: "exclude selector", req: { runId: RUN, exclude: ["tmp:"] } },
  { label: "include + exclude", req: { runId: RUN, include: ["user:", "org:"], exclude: ["user:archived:"] } },
  { label: "maxRecords cap", req: { runId: RUN, maxRecords: 100 } },
  { label: "redirect target binding only", req: { runId: RUN, target: { binding: "KV_RESTORE" } } },
  { label: "redirect target namespace + bucket", req: { runId: RUN, target: { namespaceId: "ns_abc", bucketName: "bkt-restore" } } },
  { label: "full target (binding + namespace + bucket)", req: { runId: RUN, target: { binding: "R2_DEST", namespaceId: "ns_x", bucketName: "b" } } },
  { label: "everything set", req: { runId: RUN, target: { binding: "KV_R", namespaceId: "ns1", bucketName: "b1" }, include: ["a:"], exclude: ["a:skip:"], maxRecords: 42 } },
  // A name carrying characters JSON.stringify escapes (quote, backslash, unicode) must hash
  // identically on both sides, since both use JSON.stringify for the canonical string form.
  { label: "binding name with quote/backslash/unicode", req: { runId: RUN, target: { binding: 'odd"name\\withé' } } },
  // media re-upload: the account binds into the hash (its own approval); the token is carried but MUST be
  // ignored, so this hashes identically whether or not a token is present.
  { label: "media re-upload (account bound, token ignored)", req: { runId: RUN, mediaRestore: { token: "edit-tok", accountId: "acct-1" } } },
  // granular single-record restore: recordName binds its own approval (distinct from a whole-run plan).
  { label: "granular single-record (recordName bound)", req: { runId: RUN, recordName: "user:42" } },
  // cf-config restore: account (+ optional zone) binds its own approval.
  // CF_SURFACES is EXPLICIT and already sorted, which makes the engine's resolveCfConfigSurfaces the
  // identity here (it filters the in-band set by the explicit list and sorts). That keeps these vectors
  // independent of which surfaces happen to be proven today, while still binding a real surface set: a
  // vector using the DEFAULT would change hash every time a surface is proven, and pinning golden literals
  // against it would turn every proof into a test failure.
  { label: "cf-config restore (account only)", req: { runId: RUN, cfConfig: { accountId: "acct-1", surfaces: CF_SURFACES } } },
  { label: "cf-config restore (account + zone)", req: { runId: RUN, cfConfig: { accountId: "acct-1", zoneId: "zone-9", surfaces: CF_SURFACES } } },
  // D1 table-subset restore: the scope (database + tables) binds its own approval; tables are lower-cased,
  // deduped and sorted, and createOnly is bound when true, so case/order/dupes hash identically.
  { label: "d1 table-subset (tables normalised: case/order/dupes)", req: { runId: RUN, d1Tables: { database: "appdb", tables: ["Orders", "users", "users"] } } },
  { label: "d1 table-subset createOnly (distinct from full-schema)", req: { runId: RUN, d1Tables: { database: "appdb", tables: ["users"], createOnly: true } } },
  // d1Tables and cfConfig are orthogonal (a D1 table-subset restore can also re-apply cf-config); both bind.
  { label: "d1 table-subset + cf-config coexist (both bound)", req: { runId: RUN, d1Tables: { database: "appdb", tables: ["users"] }, cfConfig: { accountId: "acct-1", surfaces: CF_SURFACES } } },
];

// ============================================================================
// Independent reference: the engine's plan-hash algorithm, reimplemented from the spec so the console
// value is pinned even without an engine checkout. canonicalJSON here is the engine's canonjson.ts
// form (sorted keys by UTF-16 code unit, compact, integers only) restricted to the value shapes a
// PlanBinding ever contains (string, string[], null, one safe-integer). The binding is constructed
// with the SAME spread-when-present rule the engine uses, so optional keys appear only when set.
// ============================================================================
function refBinding(req: PlanReq): unknown {
  return {
    runId: req.runId,
    target: req.target
      ? {
          ...(req.target.binding !== undefined ? { binding: req.target.binding } : {}),
          ...(req.target.namespaceId !== undefined ? { namespaceId: req.target.namespaceId } : {}),
          ...(req.target.bucketName !== undefined ? { bucketName: req.target.bucketName } : {}),
        }
      : null,
    include: req.include ?? [],
    exclude: req.exclude ?? [],
    ...(req.maxRecords !== undefined ? { maxRecords: req.maxRecords } : {}),
    // recordName binds a granular single-record restore (included only when set); mirrors the engine.
    ...(req.recordName !== undefined ? { recordName: req.recordName } : {}),
    // cfConfig binds the account + optional zone ONLY (the token is a secret, never hashed); mirrors the engine.
    ...(req.cfConfig
      ? {
          cfConfig: {
            accountId: req.cfConfig.accountId,
            ...(req.cfConfig.zoneId !== undefined ? { zoneId: req.cfConfig.zoneId } : {}),
            ...(req.cfConfig.surfaces !== undefined ? { surfaces: req.cfConfig.surfaces } : {}),
          },
        }
      : {}),
    // mediaRestore binds the account ONLY (the token is a secret, never hashed); mirrors the engine.
    ...(req.mediaRestore ? { mediaRestore: { accountId: req.mediaRestore.accountId } } : {}),
    // d1Tables binds the D1 table-subset scope: database + lower-cased, deduped, sorted tables + createOnly
    // when true; mirrors the engine's approvals.ts spread exactly (Array-guarded).
    ...(req.d1Tables && Array.isArray(req.d1Tables.tables)
      ? { d1Tables: { database: req.d1Tables.database, tables: [...new Set(req.d1Tables.tables.map((t) => String(t).toLowerCase()))].sort(), ...(req.d1Tables.createOnly === true ? { createOnly: true } : {}) } }
      : {}),
  };
}

function refCanon(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isInteger(v)) throw new Error(`non-integer ${v}`);
    if (!Number.isSafeInteger(v)) throw new Error(`unsafe integer ${v}`);
    return String(v);
  }
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(refCanon).join(",")}]`;
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort(); // default JS sort == UTF-16 code-unit order, matching the engine
    return `{${keys.map((k) => `${JSON.stringify(k)}:${refCanon(obj[k])}`).join(",")}}`;
  }
  throw new Error(`unsupported ${typeof v}`);
}

async function refPlanHash(req: PlanReq): Promise<string> {
  const bytes = new TextEncoder().encode(refCanon(refBinding(req)));
  return `sha384:${await sha384Hex(bytes)}`;
}

async function main(): Promise<void> {
  // ----------------------------------------------------------------------------------------------
  // 0. Guard the reference itself with a couple of golden literals. These are the SHA-384 of the
  // canonical preimage for two fixed requests, so an accidental change to refCanon (or to the
  // canonical form the console targets) is caught even before the equality assertions run. The
  // preimages are, exactly:
  //   bare:   {"exclude":[],"include":[],"runId":"01ARZ3NDEKTSV4RRFFQ69G5FAV","target":null}
  //   subset: {"exclude":[],"include":["user:"],"maxRecords":5,"runId":"...","target":null}
  // (keys sorted by UTF-16 code unit: exclude < include < maxRecords < runId < target; the
  // value-bearing optional maxRecords is present only when set; target is always a key, null when no
  // target override is given). The literals are computed here from refPlanHash and
  // asserted to be stable 88-char "sha384:"+96-hex strings, then reused as the expected for the
  // console below, so the console must match BOTH the reference and these pinned shapes.
  // ----------------------------------------------------------------------------------------------
  console.log("\n-- reference golden preimages (canonical form pinned) --");
  const goldBare = await refPlanHash({ runId: RUN });
  const goldSubset = await refPlanHash({ runId: RUN, include: ["user:"], maxRecords: 5 });
  // Shape guard: "sha384:" + 96 lowercase hex chars (SHA-384 = 48 bytes).
  const SHAPE = /^sha384:[0-9a-f]{96}$/;
  ok("reference bare hash has the sha384:<96 hex> shape", SHAPE.test(goldBare));
  ok("reference subset hash has the sha384:<96 hex> shape", SHAPE.test(goldSubset));
  // The preimage byte strings are exactly the documented canonical forms (sorted keys, compact).
  // target is ALWAYS a key in the binding (an object when a target is given, else null), so it
  // appears in the canonical form even for a bare request; "target" sorts after "runId" and
  // "maxRecords". This mirrors the engine's binding construction exactly.
  eq(
    "bare canonical preimage is sorted-compact (target:null present)",
    refCanon(refBinding({ runId: RUN })),
    '{"exclude":[],"include":[],"runId":"01ARZ3NDEKTSV4RRFFQ69G5FAV","target":null}',
  );
  eq(
    "subset canonical preimage puts maxRecords before runId before target (UTF-16 order)",
    refCanon(refBinding({ runId: RUN, include: ["user:"], maxRecords: 5 })),
    '{"exclude":[],"include":["user:"],"maxRecords":5,"runId":"01ARZ3NDEKTSV4RRFFQ69G5FAV","target":null}',
  );
  // A D1 table-subset canonical preimage: within d1Tables the keys sort createOnly < database < tables, and
  // d1Tables sorts before exclude/include/runId/target at the top level. Pins the console's d1Tables binding
  // (tables lower-cased + deduped + sorted; createOnly bound only when true) to an exact byte string.
  eq(
    "d1 table-subset canonical preimage (keys sorted; tables lower-cased/deduped/sorted)",
    refCanon(refBinding({ runId: RUN, d1Tables: { database: "appdb", tables: ["Users", "users"], createOnly: true } })),
    '{"d1Tables":{"createOnly":true,"database":"appdb","tables":["users"]},"exclude":[],"include":[],"runId":"01ARZ3NDEKTSV4RRFFQ69G5FAV","target":null}',
  );
  // createOnly:false hashes identically to createOnly absent (it is bound only when === true).
  eq(
    "d1 createOnly:false == absent (bound only when true)",
    await restorePlanHash({ runId: RUN, d1Tables: { database: "d", tables: ["t"], createOnly: false } }),
    await restorePlanHash({ runId: RUN, d1Tables: { database: "d", tables: ["t"] } }),
  );

  // ----------------------------------------------------------------------------------------------
  // 1. REFERENCE parity: console restorePlanHash == the independent reference, for every corpus item.
  // ----------------------------------------------------------------------------------------------
  console.log("\n-- console restorePlanHash == independent reference (every corpus item) --");
  for (const { label, req } of CORPUS) {
    const [got, want] = await Promise.all([restorePlanHash(req), refPlanHash(req)]);
    eq(`console hash matches the reference: ${label}`, got, want);
    ok(`console hash has the sha384:<96 hex> shape: ${label}`, SHAPE.test(got));
  }
  // The two golden literals the console must also match exactly.
  eq("console bare hash == golden bare", await restorePlanHash({ runId: RUN }), goldBare);
  eq("console subset hash == golden subset", await restorePlanHash({ runId: RUN, include: ["user:"], maxRecords: 5 }), goldSubset);

  // media re-upload binding: the account is its own approval (differs from a plain restore + by account),
  // while the secret token is NEVER hashed (token present/absent/changed -> same hash).
  const mBare = await restorePlanHash({ runId: RUN });
  const mAcct1 = await restorePlanHash({ runId: RUN, mediaRestore: { token: "t1", accountId: "acct-1" } });
  const mAcct2 = await restorePlanHash({ runId: RUN, mediaRestore: { token: "t1", accountId: "acct-2" } });
  const mAcct1NoTok = await restorePlanHash({ runId: RUN, mediaRestore: { accountId: "acct-1" } });
  ok("media re-upload hash differs from a plain restore (its own approval)", mAcct1 !== mBare);
  ok("media re-upload hash differs by account", mAcct1 !== mAcct2);
  eq("media re-upload hash IGNORES the token (a secret never enters the hash)", mAcct1, mAcct1NoTok);

  // ----------------------------------------------------------------------------------------------
  // REGRESSION: the requester-side hash (the mirror the restore screen shows the
  // operator, computed from the FULL request) must equal the approver-side hash (what the engine
  // recomputes from the request body renderRequestPanel actually forwards). The original
  // renderRequestPanel copied only runId/target/include/exclude/maxRecords onto the outgoing request,
  // DROPPING recordName and cfConfig, so a granular single-record or a cf-config restore yielded an
  // approval whose planHash never matched the hash on screen and the dual-control gate stuck forever.
  //
  // forwardOld models that bug (the dropped fields); forwardNew models the fix (recordName + the
  // token-free cfConfig forwarded). The requester hash is over the FULL request both times.
  // ----------------------------------------------------------------------------------------------
  console.log("\n-- requester hash == approver hash (recordName + cfConfig + mediaRestore forwarded) --");
  type FullReq = PlanReq & { cfConfig?: { accountId: string; zoneId?: string }; mediaRestore?: { accountId: string } };
  // The old (buggy) forward: copy the data scope, drop recordName, cfConfig and mediaRestore.
  const forwardOld = (full: FullReq): PlanReq => {
    const out: PlanReq = { runId: full.runId };
    if (full.target) out.target = full.target;
    if (full.include) out.include = full.include;
    if (full.exclude) out.exclude = full.exclude;
    if (full.maxRecords !== undefined) out.maxRecords = full.maxRecords;
    return out;
  };
  // The new (fixed) forward: also carry recordName, the token-free cfConfig, and the token-free
  // mediaRestore, exactly as the patched renderRequestPanel now does (confirm.ts).
  const forwardNew = (full: FullReq): PlanReq => {
    const out = forwardOld(full);
    if (full.recordName !== undefined) out.recordName = full.recordName;
    if (full.cfConfig) out.cfConfig = { accountId: full.cfConfig.accountId, ...(full.cfConfig.zoneId !== undefined ? { zoneId: full.cfConfig.zoneId } : {}) };
    // mediaRestore binds into the hash too (account only), so the fixed forward MUST carry it
    // (confirm.ts r.mediaRestore = { accountId: req.mediaRestore.accountId }) -- the same failure
    // class, for the media-restore feature added alongside this fix.
    if (full.mediaRestore) out.mediaRestore = { accountId: full.mediaRestore.accountId };
    // d1Tables binds into the hash too, so the fixed forward MUST carry it (confirm.ts r.d1Tables = req.d1Tables),
    // else a table-subset approval's planHash never matches the apply and the gate sticks -- the exact bug class.
    if (full.d1Tables) out.d1Tables = full.d1Tables;
    return out;
  };
  // The requests that exercised the bug (recordName, cfConfig) plus a d1Tables table-subset and a media restore.
  const granular: FullReq = { runId: RUN, recordName: "user:42" };
  const cfWhole: FullReq = { runId: RUN, cfConfig: { accountId: "acct-1", zoneId: "zone-9" } };
  const d1Subset: FullReq = { runId: RUN, d1Tables: { database: "appdb", tables: ["users", "orders"], createOnly: true } };
  const mediaWhole: FullReq = { runId: RUN, mediaRestore: { accountId: "acct-1" } };
  for (const { label, full } of [
    { label: "granular single-record", full: granular },
    { label: "cf-config restore", full: cfWhole },
    { label: "d1 table-subset", full: d1Subset },
    { label: "media restore", full: mediaWhole },
  ]) {
    const requesterHash = await restorePlanHash(full); // the mirror shown on screen, over the FULL request
    const approverOldHash = await restorePlanHash(forwardOld(full)); // what the engine would hash before the fix
    const approverNewHash = await restorePlanHash(forwardNew(full)); // what the engine hashes after the fix
    // RED before GREEN: the old forward dropped the binding field, so the hashes diverged (gate sticks).
    ok(`OLD forward MISMATCHES the requester hash (the stuck gate): ${label}`, approverOldHash !== requesterHash);
    // GREEN: the fixed forward carries the field, so requester and approver hashes are identical.
    eq(`fixed forward == requester hash (gate clears): ${label}`, approverNewHash, requesterHash);
  }
  // The cf-config token must NEVER reach the hash: forwarding the token-free cfConfig hashes identically
  // to a request that never carried a token, so no secret can bind.
  eq(
    "cf-config hash is token-free (forwarding account/zone only equals the bare cf-config request)",
    await restorePlanHash(forwardNew(cfWhole)),
    await restorePlanHash({ runId: RUN, cfConfig: { accountId: "acct-1", zoneId: "zone-9" } }),
  );
  // The media edit token must NEVER reach the hash either: forwarding the token-free mediaRestore hashes
  // identically to a request that never carried a token, so no secret can bind.
  eq(
    "media-restore hash is token-free (forwarding account only equals the bare media-restore request)",
    await restorePlanHash(forwardNew(mediaWhole)),
    await restorePlanHash({ runId: RUN, mediaRestore: { accountId: "acct-1" } }),
  );

  // ----------------------------------------------------------------------------------------------
  // 2. Binding invariants (the properties the re-arm-on-change UX and the no-custody pitch depend on).
  // ----------------------------------------------------------------------------------------------
  console.log("\n-- binding is request-only: plan OUTPUTS and the apply flag are NOT hashed --");
  // Pass a WIDER object carrying confirm/isLatest/plannedWrites/bytes. restorePlanHash takes a typed
  // subset, so these extra fields are structurally ignored; the hash equals the bare-request hash.
  const wide = { runId: RUN, confirm: true, isLatest: false, plannedWrites: 999, bytes: 123456 } as unknown as PlanReq;
  eq("a request with confirm/isLatest/plannedWrites/bytes hashes as the bare request", await restorePlanHash(wide), goldBare);

  console.log("\n-- re-arm-on-change: any decision-relevant field change changes the hash --");
  const base = await restorePlanHash({ runId: RUN, include: ["a:"], exclude: ["b:"], maxRecords: 10, target: { binding: "K" } });
  ok("changing runId changes the hash", (await restorePlanHash({ runId: `${RUN}X`, include: ["a:"], exclude: ["b:"], maxRecords: 10, target: { binding: "K" } })) !== base);
  ok("changing include changes the hash", (await restorePlanHash({ runId: RUN, include: ["a:", "c:"], exclude: ["b:"], maxRecords: 10, target: { binding: "K" } })) !== base);
  ok("changing exclude changes the hash", (await restorePlanHash({ runId: RUN, include: ["a:"], exclude: ["b:", "d:"], maxRecords: 10, target: { binding: "K" } })) !== base);
  ok("changing maxRecords changes the hash", (await restorePlanHash({ runId: RUN, include: ["a:"], exclude: ["b:"], maxRecords: 11, target: { binding: "K" } })) !== base);
  ok("changing target.binding changes the hash", (await restorePlanHash({ runId: RUN, include: ["a:"], exclude: ["b:"], maxRecords: 10, target: { binding: "K2" } })) !== base);
  ok("dropping the target entirely changes the hash", (await restorePlanHash({ runId: RUN, include: ["a:"], exclude: ["b:"], maxRecords: 10 })) !== base);
  // include order is significant (it is an array, not a set): [a,b] != [b,a].
  ok("include element order is significant", (await restorePlanHash({ runId: RUN, include: ["a:", "b:"] })) !== (await restorePlanHash({ runId: RUN, include: ["b:", "a:"] })));

  console.log("\n-- exactOptional parity: absent vs explicit-undefined optional fields hash identically --");
  // An absent optional field and an explicit-undefined one must yield the same hash (the engine's
  // spread-when-present construction makes undefined and absent indistinguishable). This is the real
  // shape a caller assembles from form state, where a selector or a cap is present-but-undefined. The
  // explicit-undefined variants are typed via UndefReq (optional fields that allow undefined) so the
  // assertion is type-honest under exactOptionalPropertyTypes; restorePlanHash accepts the wider value.
  type UndefReq = {
    runId: string;
    target?: { binding?: string | undefined; namespaceId?: string | undefined; bucketName?: string | undefined } | undefined;
    include?: string[] | undefined;
    exclude?: string[] | undefined;
    maxRecords?: number | undefined;
  };
  // u exercises the present-but-undefined runtime shape, which exactOptionalPropertyTypes forbids at a
  // call site by design; the single localised cast is deliberate, since the assertion's whole purpose
  // is to prove restorePlanHash treats an explicit-undefined key the same as an absent one at runtime.
  const u = (req: UndefReq): Promise<string> => restorePlanHash(req as Parameters<typeof restorePlanHash>[0]);
  eq("absent maxRecords == explicit-undefined maxRecords", await restorePlanHash({ runId: RUN }), await u({ runId: RUN, maxRecords: undefined }));
  eq("absent include/exclude == explicit-undefined include/exclude", await restorePlanHash({ runId: RUN }), await u({ runId: RUN, include: undefined, exclude: undefined }));
  eq("absent target == explicit-undefined target", await restorePlanHash({ runId: RUN }), await u({ runId: RUN, target: undefined }));
  // Within a target, an absent sub-field == an explicit-undefined one.
  eq(
    "target with only binding == target with binding + undefined namespace/bucket",
    await restorePlanHash({ runId: RUN, target: { binding: "K" } }),
    await u({ runId: RUN, target: { binding: "K", namespaceId: undefined, bucketName: undefined } }),
  );
  // An absent include and an explicit empty array hash the same (the mirror defaults include to []).
  eq("absent include == explicit empty include array", await restorePlanHash({ runId: RUN }), await restorePlanHash({ runId: RUN, include: [] }));

  console.log("\n-- the hash carries no plaintext marker and is a stable prefix scheme --");
  ok('every hash uses the "sha384:" scheme prefix', (await restorePlanHash({ runId: RUN })).startsWith("sha384:"));

  // ----------------------------------------------------------------------------------------------
  // 3. ENGINE PARITY: console restorePlanHash == the engine's restorePlanHash, over the whole corpus.
  // Guarded import: skipped with a note if no engine checkout is available.
  // ----------------------------------------------------------------------------------------------
  await checkEnginePlanHashParity();

  console.log(failures === 0 ? "\nRESTORE PLAN-HASH MIRROR VECTORS PASS" : `\n${failures} FAILURE(S)`);
    if (failures > 0) process.exit(1);
}

async function checkEnginePlanHashParity(): Promise<void> {
  console.log("\n-- engine parity (console restorePlanHash == engine restorePlanHash) --");
  const here = new URL(".", import.meta.url).pathname;
  const loaded = await importFromEngine<{ restorePlanHash: (req: PlanReq) => Promise<string> }>(here, "src/admin/approvals.ts");
  let eng: { restorePlanHash: (req: PlanReq) => Promise<string> };
  if (loaded !== null) {
    eng = loaded;
  } else {
    console.log("  note engine checkout not available; skipping the engine-parity cross-check");
    console.log("       (the reference assertions above already pin the contract).");
    return;
  }
  // Capability probe: if the imported engine checkout PREDATES a field this console binds (its hash is
  // unchanged with vs without the field), parity for vectors carrying that field cannot hold. Skip
  // those vectors (the hermetic reference above still pins the console); they run automatically once
  // the imported checkout has the feature.
  const engKnowsD1 = (await eng.restorePlanHash({ runId: RUN, d1Tables: { database: "d", tables: ["t"] } })) !== (await eng.restorePlanHash({ runId: RUN }));
  for (const { label, req } of CORPUS) {
    if (req.d1Tables !== undefined && !engKnowsD1) {
      console.log(`  note skip (engine checkout predates d1Tables): console == engine: ${label}`);
      continue;
    }
    const [con, e] = await Promise.all([restorePlanHash(req), eng.restorePlanHash(req)]);
    eq(`console == engine: ${label}`, con, e);
  }
  // A subset request that the engine would bind to a distinct, smaller blast radius must also match.
  eq(
    "console == engine: subset with maxRecords",
    await restorePlanHash({ runId: RUN, include: ["user:"], maxRecords: 5 }),
    await eng.restorePlanHash({ runId: RUN, include: ["user:"], maxRecords: 5 }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
