// Control-plane recovery — the console face of the engine's silence-killer. Validates the PURE
// model (the banner decision + the reconcile-form validation), the EngineClient methods against a recording
// fetch stub (the exact route / verb / auth header / body each emits, and the no-custody handling), and the
// recovery-banner's validate→submit pipeline (_testRunReconcile) without a DOM or network.
// Run with: node test/validate-control-plane-recovery.ts
//
// Coverage:
//   recoveryBannerModel (pure): shows ONLY on a confirmed recoveryRequired latch (never on healthy, a
//     brand-new empty account, or a null/unknown status); carries the engine reason; the copy is the pinned
//     standing strings; tone is always danger when shown.
//   parseReconcileInput (pure): rejects empty/non-JSON/not-an-export export, an empty signature, an empty
//     token; accepts a well-formed trio and TRIMS; the parsed export is the opaque parsed value (never
//     re-serialised by the console).
//   controlPlaneStatus (client): GET /admin/control-plane/status, session bearer, credentials:include, body
//     passed through verbatim; a non-2xx throws verb+status.
//   controlPlaneRestore (client): POST /admin/control-plane/restore, the ADMIN_TOKEN as a one-off Bearer
//     (NOT the session token), credentials:include, body { export, signature }; a 401 / 400 throw the
//     specific operator-facing messages; success parses the reconcile result.
//   _testRunReconcile (banner pipeline): a validation error keeps the modal open + sets the form error and
//     NEVER calls reconcile; a valid trio relays the token + export + signature to reconcile, notifies, calls
//     onReconciled and returns true (close); an engine refusal surfaces the message and keeps open (false).

import { EngineClient } from "../src/api.ts";
import {
  RECOVERY_BANNER_BODY,
  RECOVERY_BANNER_TITLE,
  parseReconcileInput,
  recoveryBannerModel,
  type ReconcileInput,
} from "../src/lib/control-plane-recovery.ts";
import { _testRunApplyStaged, _testRunReconcile, type RecoveryBannerDeps } from "../src/components/recovery-banner.ts";
import type { ControlPlaneApplyStagedResult, ControlPlaneReconcileResult, ControlPlaneStagedSummary, ControlPlaneStatus } from "../src/lib/api/types/control-plane.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}
function eq(actual: unknown, expected: unknown, label: string): void {
  ok(`${label} (got ${JSON.stringify(actual)})`, actual === expected);
}

// A canonical valid export artefact (the shape the engine writes; the console only shape-checks + forwards).
const VALID_EXPORT = {
  v: 1,
  exportedAt: "2026-06-28T00:00:00.000Z",
  configVersion: 7,
  configContentHash: "sha384:abc",
  engineAccountId: "acct-1",
  priorAuditHead: { headSeq: 42, headHash: "sha384:head" },
  downpipes: [{ id: "dp-1" }],
  destinations: [{ id: "d1", secret: { reestablish: true } }],
  defaultDestinationId: "d1",
  roles: [{ subject: "subj-owner", email: "owner@example.com", role: "owner", grantedBy: "x", grantedAt: "t" }],
  groupRoles: [],
  customRoles: [],
  discovery: null,
  orgPolicy: { requireConfigApproval: false },
  reestablish: ["destination-credentials", "session-keys"],
};

async function main(): Promise<void> {
  // ---- recoveryBannerModel (pure) -----------------------------------------------------------------
  console.log("\n-- recoveryBannerModel --");
  const shownStatus: ControlPlaneStatus = { recoveryRequired: true, reason: "config empty but the bucket has runs", configEmpty: true };
  const shown = recoveryBannerModel(shownStatus);
  ok("model: shows when the engine latched recoveryRequired", shown.show === true);
  eq(shown.tone, "danger", "model: tone is danger when shown");
  eq(shown.title, RECOVERY_BANNER_TITLE, "model: pinned title");
  eq(shown.body, RECOVERY_BANNER_BODY, "model: pinned body");
  eq(shown.reason, "config empty but the bucket has runs", "model: carries the engine reason");
  // The body must name the consequence + the data-safe reassurance + the remedy (no over-claim).
  ok("model: body says backups stopped", RECOVERY_BANNER_BODY.includes("backups have stopped"));
  ok("model: body reassures data is unaffected", RECOVERY_BANNER_BODY.toLowerCase().includes("data is unaffected"));

  const healthy = recoveryBannerModel({ recoveryRequired: false, reason: null, configEmpty: false });
  ok("model: hidden on a healthy plane", healthy.show === false && healthy.reason === null);
  // A brand-new account: empty config but the engine does NOT latch recoveryRequired (no runs in the bucket).
  const freshAccount = recoveryBannerModel({ recoveryRequired: false, reason: null, configEmpty: true });
  ok("model: hidden on a brand-new empty account (configEmpty but not recoveryRequired)", freshAccount.show === false);
  const unknown = recoveryBannerModel(null);
  ok("model: hidden on a null/unknown status (never alarm on unknown)", unknown.show === false && unknown.reason === null);

  // ---- recoveryBannerModel carries the auto-heal's staged summary ---------------------------
  console.log("\n-- recoveryBannerModel: staged --");
  const STAGED: ControlPlaneStagedSummary = { sourceKey: "_RECOVERY/CONTROL-PLANE/7-2026-08-01.sealed.json", version: 7, stagedAt: "2026-08-01T00:00:00.000Z", downpipes: 3, resumeApplied: true };
  const shownStaged = recoveryBannerModel({ recoveryRequired: true, reason: "amnesia", configEmpty: true, staged: STAGED });
  ok("model: carries the staged summary when the engine sent one", shownStaged.staged !== null && shownStaged.staged?.version === 7 && shownStaged.staged?.downpipes === 3);
  const shownUnstaged = recoveryBannerModel({ recoveryRequired: true, reason: "amnesia", configEmpty: true, staged: null });
  ok("model: staged is null when the engine explicitly sent null", shownUnstaged.staged === null);
  const shownOlderEngine = recoveryBannerModel({ recoveryRequired: true, reason: "amnesia", configEmpty: true });
  ok("model: staged degrades to null on an older engine build that never sends the field", shownOlderEngine.staged === null);
  ok("model: staged is null when the banner itself is not shown (never surfaced on a healthy plane)", recoveryBannerModel({ recoveryRequired: false, reason: null, configEmpty: false, staged: STAGED }).staged === null);

  // ---- parseReconcileInput (pure) -----------------------------------------------------------------
  console.log("\n-- parseReconcileInput --");
  const exportText = JSON.stringify(VALID_EXPORT);
  const empty = parseReconcileInput({ exportText: "   ", signature: "sig", token: "tok" });
  ok("parse: empty export rejected", empty.ok === false && /Paste the signed control-plane export/.test(empty.error));
  const badJson = parseReconcileInput({ exportText: "{not json", signature: "sig", token: "tok" });
  ok("parse: non-JSON export rejected", badJson.ok === false && /not valid JSON/.test(badJson.error));
  const notExport = parseReconcileInput({ exportText: JSON.stringify({ v: 1, hello: "world" }), signature: "sig", token: "tok" });
  ok("parse: JSON that is not a control-plane export rejected", notExport.ok === false && /does not look like a control-plane export/.test(notExport.error));
  const noSig = parseReconcileInput({ exportText, signature: "  ", token: "tok" });
  ok("parse: empty signature rejected", noSig.ok === false && /detached signature/.test(noSig.error));
  const noToken = parseReconcileInput({ exportText, signature: "sig", token: "  " });
  ok("parse: empty token rejected", noToken.ok === false && /break-glass token/.test(noToken.error));

  const good = parseReconcileInput({ exportText: `  ${exportText}  `, signature: "  the-sig  ", token: "  the-token  " });
  ok("parse: a well-formed trio is accepted", good.ok === true);
  if (good.ok) {
    eq(good.value.signature, "the-sig", "parse: signature is trimmed");
    eq(good.value.token, "the-token", "parse: token is trimmed");
    // The export is the opaque PARSED value (an object), never the raw string — the client forwards it as
    // `export: value`, so the engine receives the same bytes JSON.stringify produces, with no console mutation.
    ok("parse: export is the parsed object (not the raw string)", typeof good.value.exportArtefact === "object" && (good.value.exportArtefact as { v: number }).v === 1);
  }

  // ---- EngineClient methods (recording fetch stub) ------------------------------------------------
  console.log("\n-- controlPlaneStatus + controlPlaneRestore (fetch-stubbed) --");
  interface RecordedCall { url: string; method: string; headers: Record<string, string>; body: string | null; credentials: string | undefined }
  const calls: RecordedCall[] = [];
  const last = (): RecordedCall => {
    const c = calls[calls.length - 1];
    if (!c) throw new Error("no recorded fetch call");
    return c;
  };
  let nextResponse: () => Response = () => new Response("{}", { status: 200 });
  const realFetch = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = (async (input: unknown, init?: { method?: string; headers?: Record<string, string>; body?: string; credentials?: string }) => {
    calls.push({ url: String(input), method: init?.method ?? "GET", headers: (init?.headers as Record<string, string>) ?? {}, body: typeof init?.body === "string" ? init.body : null, credentials: init?.credentials });
    return nextResponse();
  }) as typeof fetch;

  try {
    const client = new EngineClient("https://engine.example.com", "session-tok");

    // controlPlaneStatus: GET, session bearer, credentials:include, body verbatim.
    const statusBody: ControlPlaneStatus = { recoveryRequired: true, reason: "amnesia", configEmpty: true };
    nextResponse = () => new Response(JSON.stringify(statusBody), { status: 200 });
    const gotStatus = await client.controlPlaneStatus();
    eq(last().url, "https://engine.example.com/admin/control-plane/status", "status: GET /admin/control-plane/status");
    eq(last().method, "GET", "status: is a GET");
    eq(last().headers.authorization, "Bearer session-tok", "status: carries the session bearer");
    eq(last().credentials, "include", "status: credentials:include");
    eq(JSON.stringify(gotStatus), JSON.stringify(statusBody), "status: body passes through verbatim");

    // status non-2xx throws verb+status.
    nextResponse = () => new Response("nope", { status: 500 });
    let statusThrew = "";
    try { await client.controlPlaneStatus(); } catch (e) { statusThrew = e instanceof Error ? e.message : String(e); }
    eq(statusThrew, "control-plane status: 500", "status: non-2xx throws verb + status");

    // controlPlaneRestore: POST, ADMIN_TOKEN as a one-off Bearer (NOT the session tok), credentials:include,
    // body { export, signature } (no force: a recovery rebuilds a wiped plane, it never overwrites a live one).
    const reconcileBody: ControlPlaneReconcileResult = { ok: true, downpipes: 1, destinations: 2, roles: 1, bridgedFrom: { headSeq: 42, headHash: "sha384:head" } };
    nextResponse = () => new Response(JSON.stringify(reconcileBody), { status: 200 });
    const gotReconcile = await client.controlPlaneRestore("BREAK-GLASS-TOKEN", VALID_EXPORT, "the-sig");
    eq(last().url, "https://engine.example.com/admin/control-plane/restore", "restore: POST /admin/control-plane/restore");
    eq(last().method, "POST", "restore: is a POST");
    eq(last().headers.authorization, "Bearer BREAK-GLASS-TOKEN", "restore: uses the ADMIN_TOKEN as a one-off Bearer (not the session token)");
    eq(last().credentials, "include", "restore: credentials:include");
    const sentBody = JSON.parse(last().body ?? "{}") as { export?: unknown; signature?: unknown; force?: unknown };
    ok("restore: body carries the export verbatim", JSON.stringify(sentBody.export) === JSON.stringify(VALID_EXPORT));
    eq(sentBody.signature, "the-sig", "restore: body carries the signature");
    ok("restore: body carries NO force flag (there is no force overwrite)", sentBody.force === undefined);
    eq(JSON.stringify(gotReconcile), JSON.stringify(reconcileBody), "restore: result parsed verbatim");

    // restore 401 -> the break-glass-token message.
    nextResponse = () => new Response("unauthorised", { status: 401 });
    let r401 = "";
    try { await client.controlPlaneRestore("wrong", VALID_EXPORT, "s"); } catch (e) { r401 = e instanceof Error ? e.message : String(e); }
    ok("restore: 401 names the break-glass token", /break-glass token.*was not accepted/.test(r401));

    // restore 400 -> the export-refused message (carries the engine detail).
    nextResponse = () => new Response("the export signature did not verify", { status: 400 });
    let r400 = "";
    try { await client.controlPlaneRestore("tok", VALID_EXPORT, "s"); } catch (e) { r400 = e instanceof Error ? e.message : String(e); }
    ok("restore: 400 surfaces the refusal + the engine detail", /export was refused/.test(r400) && /did not verify/.test(r400));

    // ---- controlPlaneApplyStaged (client) --------------------------------------------------
    console.log("\n-- controlPlaneApplyStaged (fetch-stubbed) --");
    const stagedResult: ControlPlaneApplyStagedResult = { ok: true, roles: 2, bridgedFrom: { headSeq: 9, headHash: "sha384:h" } };
    nextResponse = () => new Response(JSON.stringify(stagedResult), { status: 200 });
    const gotStaged = await client.controlPlaneApplyStaged("BREAK-GLASS-TOKEN");
    eq(last().url, "https://engine.example.com/admin/control-plane/apply-staged", "apply-staged: POST /admin/control-plane/apply-staged");
    eq(last().method, "POST", "apply-staged: is a POST");
    eq(last().headers.authorization, "Bearer BREAK-GLASS-TOKEN", "apply-staged: uses the ADMIN_TOKEN as a one-off Bearer");
    eq(last().credentials, "include", "apply-staged: credentials:include");
    ok("apply-staged: the request carries NO body (no export, no signature -- already verified when staged)", last().body === null || last().body === "");
    eq(JSON.stringify(gotStaged), JSON.stringify(stagedResult), "apply-staged: result parsed verbatim");

    nextResponse = () => new Response("unauthorised", { status: 401 });
    let as401 = "";
    try { await client.controlPlaneApplyStaged("wrong"); } catch (e) { as401 = e instanceof Error ? e.message : String(e); }
    ok("apply-staged: 401 names the break-glass token", /break-glass token.*was not accepted/.test(as401));

    nextResponse = () => new Response("the role table is not empty", { status: 403 });
    let as403 = "";
    try { await client.controlPlaneApplyStaged("tok"); } catch (e) { as403 = e instanceof Error ? e.message : String(e); }
    ok("apply-staged: 403 names the break-glass-token-only gate", /only the break-glass token can confirm/.test(as403));

    nextResponse = () => new Response("nothing is staged for recovery", { status: 400 });
    let as400 = "";
    try { await client.controlPlaneApplyStaged("tok"); } catch (e) { as400 = e instanceof Error ? e.message : String(e); }
    ok("apply-staged: 400 surfaces the refusal + the engine detail", /staged recovery could not be confirmed/.test(as400) && /nothing is staged/.test(as400));
  } finally {
    (globalThis as { fetch: unknown }).fetch = realFetch;
  }

  // ---- _testRunReconcile (the banner validate->submit pipeline) -----------------------------------
  console.log("\n-- recovery-banner reconcile pipeline --");
  // A validation error keeps the modal open, sets the form error, and NEVER calls reconcile.
  {
    let reconcileCalls = 0;
    let formError = "";
    const deps: RecoveryBannerDeps = { reconcile: async () => { reconcileCalls++; return { ok: true, downpipes: 0, destinations: 0, roles: 0, bridgedFrom: { headSeq: 0, headHash: "" } }; } };
    const result = await _testRunReconcile({ exportText: "{bad", signature: "s", token: "t" }, deps, (m) => { formError = m; });
    ok("pipeline: a validation error keeps the modal open (false)", result === false);
    ok("pipeline: the form error is surfaced", /not valid JSON/.test(formError));
    eq(reconcileCalls, 0, "pipeline: reconcile is NOT called on a validation error");
  }
  // A valid trio relays the token + export + signature to reconcile, notifies, calls onReconciled, closes.
  {
    let captured: ReconcileInput | null = null;
    let notified = "";
    let reconciledResult: ControlPlaneReconcileResult | null = null;
    const deps: RecoveryBannerDeps = {
      reconcile: async (input) => { captured = input; return { ok: true, downpipes: 3, destinations: 2, roles: 1, bridgedFrom: { headSeq: 9, headHash: "sha384:h" } }; },
      notify: (m) => { notified = m; },
      onReconciled: (r) => { reconciledResult = r; },
    };
    const result = await _testRunReconcile({ exportText: JSON.stringify(VALID_EXPORT), signature: "the-sig", token: "BREAK-GLASS" }, deps, () => {});
    ok("pipeline: a valid reconcile returns true (close)", result === true);
    const cap = captured as ReconcileInput | null;
    ok("pipeline: the break-glass token is relayed to reconcile", cap?.token === "BREAK-GLASS");
    ok("pipeline: the signature is relayed", cap?.signature === "the-sig");
    ok("pipeline: the export object is relayed (no re-serialise mutation)", JSON.stringify(cap?.exportArtefact) === JSON.stringify(VALID_EXPORT));
    ok("pipeline: a success toast is fired naming the rebuilt counts", /3 downpipe/.test(notified) && /2 destination/.test(notified));
    ok("pipeline: onReconciled receives the result", (reconciledResult as ControlPlaneReconcileResult | null)?.downpipes === 3);
  }
  // An engine refusal surfaces the message and keeps the modal open.
  {
    let formError = "";
    const deps: RecoveryBannerDeps = { reconcile: async () => { throw new Error("the export was refused: bad signature"); } };
    const result = await _testRunReconcile({ exportText: JSON.stringify(VALID_EXPORT), signature: "s", token: "t" }, deps, (m) => { formError = m; });
    ok("pipeline: an engine refusal keeps the modal open (false)", result === false);
    ok("pipeline: the engine refusal message is surfaced", /export was refused/.test(formError));
  }
  // A SEALED export pasted into the manual reconcile form is refused with the TRUE cause (a format
  // this form cannot open), not the generic "does not look like a control-plane export" shape message a
  // sealed artefact used to get -- and reconcile is never called (nothing to relay: the plaintext this route
  // needs does not exist).
  {
    // A minimal, structurally-valid SEALED shape (looksLikeSealedControlPlaneExport's gate is purely
    // structural; it does not need a real signature or a decryptable body for THIS pre-check to fire).
    const SEALED_SHAPE = { v: 1, exportedAt: "2026-08-01T00:00:00.000Z", configVersion: 7, recipients: [{ role: "break-glass", fingerprint: "fp1" }], capsule: [{ fingerprint: "fp1", kemCiphertext: "x", sealed: "y" }], body: "ciphertext-b64url" };
    let reconcileCalls = 0;
    let formError = "";
    const deps: RecoveryBannerDeps = { reconcile: async () => { reconcileCalls++; return { ok: true, downpipes: 0, destinations: 0, roles: 0, bridgedFrom: { headSeq: 0, headHash: "" } }; } };
    const result = await _testRunReconcile({ exportText: JSON.stringify(SEALED_SHAPE), signature: "the-sealed-sig", token: "t" }, deps, (m) => { formError = m; });
    ok("pipeline: a sealed paste keeps the modal open (false)", result === false);
    ok("pipeline: the message names the TRUE cause (a sealed export, not a shape problem)", /SEALED control-plane export/.test(formError));
    ok("pipeline: the message does NOT use the generic shape-refusal wording", !/does not look like a control-plane export/.test(formError));
    ok("pipeline: it points at the auto-heal confirm action as the likely real path", /Confirm and restore access/.test(formError));
    ok("pipeline: still carries the DP-R03 code (same code, corrected wording)", /\(DP-R03\)/.test(formError));
    eq(reconcileCalls, 0, "pipeline: reconcile is NOT called on a sealed paste (nothing plaintext to relay)");
  }

  // ---- _testRunApplyStaged (the auto-heal confirm pipeline) ---------------------------------
  console.log("\n-- recovery-banner apply-staged (auto-heal confirm) pipeline --");
  // An empty token is refused before any network call, mirroring parseReconcileInput's DP-R06 wording.
  {
    let applyCalls = 0;
    let formError = "";
    const deps: RecoveryBannerDeps = { reconcile: async () => { throw new Error("unused"); }, applyStaged: async () => { applyCalls++; return { ok: true, roles: 0, bridgedFrom: { headSeq: 0, headHash: "" } }; } };
    const result = await _testRunApplyStaged("   ", deps, (m) => { formError = m; });
    ok("apply-staged pipeline: an empty token keeps the modal open (false)", result === false);
    ok("apply-staged pipeline: the form error names the break-glass token", /break-glass token/.test(formError));
    ok("apply-staged pipeline: carries the DP-R06 code (same as the reconcile form's empty-token refusal)", /\(DP-R06\)/.test(formError));
    eq(applyCalls, 0, "apply-staged pipeline: applyStaged is NOT called on an empty token");
  }
  // A well-formed token relays to deps.applyStaged, notifies, calls onApplied, and closes -- carrying NO
  // export and NO signature (there is nothing plaintext to paste; the engine already verified this when it
  // staged the recovery).
  {
    let captured: string | null = null;
    let notified = "";
    let appliedResult: ControlPlaneApplyStagedResult | null = null;
    const deps: RecoveryBannerDeps = {
      reconcile: async () => { throw new Error("unused"); },
      applyStaged: async (token) => { captured = token; return { ok: true, roles: 4, bridgedFrom: { headSeq: 11, headHash: "sha384:hh" } }; },
      notify: (m) => { notified = m; },
      onApplied: (r) => { appliedResult = r; },
    };
    const result = await _testRunApplyStaged("  BREAK-GLASS  ", deps, () => {});
    ok("apply-staged pipeline: a valid confirm returns true (close)", result === true);
    eq(captured, "BREAK-GLASS", "apply-staged pipeline: the token is trimmed and relayed to applyStaged");
    ok("apply-staged pipeline: a success toast names the restored role count", /4 role/.test(notified));
    ok("apply-staged pipeline: the toast never asks for an export (there is nothing to paste)", !/export/i.test(notified));
    ok("apply-staged pipeline: onApplied receives the result", (appliedResult as ControlPlaneApplyStagedResult | null)?.roles === 4);
  }
  // An engine refusal surfaces the message and keeps the modal open (e.g. the role table was not empty).
  {
    let formError = "";
    const deps: RecoveryBannerDeps = { reconcile: async () => { throw new Error("unused"); }, applyStaged: async () => { throw new Error("only the break-glass token can confirm a staged recovery: the role table is not empty (DP-R11)"); } };
    const result = await _testRunApplyStaged("tok", deps, (m) => { formError = m; });
    ok("apply-staged pipeline: an engine refusal keeps the modal open (false)", result === false);
    ok("apply-staged pipeline: the engine refusal message is surfaced", /role table is not empty/.test(formError));
  }
  // A caller that omits applyStaged (an older wiring) degrades honestly rather than throwing.
  {
    let formError = "";
    const deps: RecoveryBannerDeps = { reconcile: async () => { throw new Error("unused"); } };
    const result = await _testRunApplyStaged("tok", deps, (m) => { formError = m; });
    ok("apply-staged pipeline: a missing applyStaged collaborator keeps the modal open, never throws", result === false);
    ok("apply-staged pipeline: it says so honestly rather than a raw crash", formError.length > 0);
  }

  console.log(failures === 0 ? "\nCONTROL-PLANE-RECOVERY VECTORS PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\nVALIDATE-CONTROL-PLANE-RECOVERY THREW:", err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
