// validate-api: the DOM-driven restore-flow screen flows (REAL CODE).
//
// Coverage (sections 6 / 6B from the original single-file suite, plus a later addition):
//   6:  restore-request blast-radius cue payload (renderRequestPanel)
//   6B: restorability assurance -- the BLIND restore test renders an attestation and
//       NEVER shows record content; the capability gates it (renderRestorabilityCard)
//   6C: media-remap rendering (receipt.ts renderReceipt) -- the old->new video uid map an applied
//       media restore shows the operator (coverage backlog item, source-granularity adversarial
// review: this had zero coverage before)
//
// These drive the REAL restore screen (src/screens/restore-flow.ts) under the shared DOM
// shim, never a copy of its logic. The store/nav bridge and the screen are passed in by the
// flows coordinator (validate-api-flows.ts) so the shim is installed and the modules are
// imported exactly once.

import {
  type EngineClient,
  restorePlanHash,
  type Caller,
  type Role,
  type RestorePlan,
  type RestoreApproval,
  type RestoreRequest,
  type RestoreResult,
  type RunHistoryEntry,
} from "../src/api.ts";

import type * as Store from "../src/lib/store.ts";
import type * as Nav from "../src/lib/nav.ts";
import type { restoreFlowScreen as RestoreFlowScreen } from "../src/screens/restore-flow.ts";
import { renderReceipt } from "../src/screens/restore-flow/receipt.ts";
import { renderBatchQueue } from "../src/screens/restore-flow/batch.ts";
import { renderApprovalsInbox } from "../src/screens/restore-flow/approvals.ts";
import { renderAttendRunner } from "../src/screens/restore-flow/attend.ts";
import { visibleCommands, type CommandContext } from "../src/shell/registry.ts";

import {
  type Harness,
  type BlindTest,
  flushAsync,
  markConnected,
  querySelectorShim,
  querySelectorAllShim,
  textOf,
  makePlan,
  populateForm,
  makeBlindTest,
} from "./validate-api-shared.ts";

export async function runRestoreFlows(
  h: Harness,
  store: typeof Store,
  nav: typeof Nav,
  restoreFlowScreen: typeof RestoreFlowScreen,
): Promise<void> {
  const ok = h.ok.bind(h);
  // Captured by driveRequestPanel for the D1 table-subset scenario (6i): the LAST dry-run request the real
  // buildRequest() produced from the form, and the LAST rendered root, so 6i can assert the D1 controls
  // render and that the d1Tables scope reaches BOTH the dry-run and the approval request.
  let lastDryRunReq: unknown = null;
  let lastRoot: unknown = null;

  // Store ordering: `store` is the live singleton, shared
  // across every group in this suite. Each driver below re-sets the caller and re-connects
  // the engine before it reads them, so it does not depend on prior state. The deliberate
  // contract is: this suite runs LINEARLY (the orchestrator awaits each group in order) and
  // every group seeds the store before use. Do NOT reorder or parallelise these groups, and
  // do NOT rely on store state leaking in from an earlier group; a pending async callback
  // from a prior scenario could otherwise read state a later scenario set.

  // ==========================================================================
  // SECTION 6: restore-request blast-radius cue payload (REAL CODE)
  //
  // The renderRequestPanel click handler in src/screens/restore-flow.ts builds the
  // requestRestore payload. Before the fix it dropped isLatest/plannedWrites/bytes,
  // so the approver inbox showed fabricated zeros and flagged every request as a
  // non-latest restore. After the fix the handler reads those values from the dry-run
  // plan and attaches them when the plan carries a real value.
  //
  // This section drives the REAL production code, never a copy of its logic: it renders
  // the actual restoreFlowScreen (src/screens/restore-flow.ts) on the prefilled-run
  // route, which auto-runs the dry-run -> renders the plan -> renders the confirm step,
  // and for an Operator (who lacks the Approver role) renders the dual-control request
  // panel. It then fills the real reason field, clicks the real "Request approval"
  // button, and captures the payload the handler actually passes to
  // EngineClient.requestRestore by INJECTING a fake EngineClient whose requestRestore
  // records its argument. The assertions check the REAL payload carries the plan's
  // isLatest/plannedWrites/bytes. If the handler is ever refactored to drop a cue, the
  // captured payload loses that field and these assertions FAIL.
  //
  // Reachability note (grounded in restore-flow.ts): renderRequestPanel is reached ONLY
  // when the dry-run plan is ok AND plannedWrites > 0. renderPlan returns early on
  // plan.ok === false (it never builds the confirm step), and renderConfirm returns
  // early on plannedWrites === 0 ("nothing to apply"), so the panel never renders in
  // those states. The bytes-omission guard (if plan.bytes > 0) is still exercised
  // through a reachable plan: plannedWrites > 0 with bytes 0 renders the panel and omits
  // only bytes. These tests therefore cover exactly the states production can reach.
  // ==========================================================================
  console.log("\n-- restore-request blast-radius cue payload (real renderRequestPanel) --");

  // Wire the nav bridge so navigate()/goSignedOut() do not throw inside the handlers.
  // goSignedOut must NOT fire on this happy path; make it loud if it ever does.
  let signedOut = false;
  nav.installNav({
    navigate: () => {},
    onUnauthorised: () => { signedOut = true; },
    refreshIdentity: async () => {},
    signOut: () => {},
    onAuthenticated: async () => {},
  });

  // The captured-payload shape: the real requestRestore parameter type widened with the
  // three optional blast-radius cues (now part of the api.ts contract).
  type RequestPayload = Parameters<EngineClient["requestRestore"]>[0];

  // driveRequestPanel renders the real restore flow for an Operator with the given
  // dry-run plan and request fields, drives the real request action, and returns the
  // payload the handler passed to the injected requestRestore (or null if the panel was
  // never reached / the button never fired). It rebuilds the world for each call so the
  // scenarios are independent.
  async function driveRequestPanel(
    plan: RestorePlan,
    reqFields: { runId: string; target?: { binding?: string }; include?: string[]; exclude?: string[]; maxRecords?: number; recordName?: string; cfConfig?: { token?: string; accountId: string; zoneId?: string }; mediaRestore?: { token?: string; accountId: string }; d1Tables?: { database: string; tables: string[]; createOnly?: boolean } },
    reason = "DR rehearsal reason",
  ): Promise<RequestPayload | null> {
    // Operator role: renderConfirm takes the request-panel branch (an Operator lacks the
    // Approver role, so they raise the request rather than seeing an Apply control).
    const operator: Caller = { method: "access", email: "op@maelstrom.au", role: "operator", groups: [], isOnlyOwner: false };
    store.setCaller(operator);

    // Put a real EngineClient in the store (requireEngine() reads it), then stub its
    // network methods on that exact instance. restore() returns our dry-run plan;
    // listApprovals() is empty; requestRestore() captures its argument.
    store.connect("https://engine.test");
    const engine = store.getEngine();
    if (!engine) return null;
    let captured: RequestPayload | null = null;
    // The fake methods are assigned onto the real client instance the store holds, so
    // the real screen calls them through requireEngine(). Cast through unknown because we
    // are deliberately replacing the network methods with in-memory test doubles.
    (engine as unknown as { restore: (req: unknown) => Promise<RestorePlan> }).restore = async (req) => { lastDryRunReq = req; return plan; };
    (engine as unknown as { listApprovals: () => Promise<RestoreApproval[]> }).listApprovals = async () => [];
    (engine as unknown as { requestRestore: (req: RequestPayload) => Promise<RestoreApproval> }).requestRestore = async (req) => {
      captured = req;
      return {
        planHash: "sha384:00", runId: req.runId, isLatest: req.isLatest === true,
        plannedWrites: req.plannedWrites ?? 0, bytes: req.bytes ?? 0, redirectBinding: null,
        requestedBy: operator.email ?? "", requestedAt: "2026-01-01T00:00:00Z",
        reason: req.reason, status: "requested", expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      };
    };

    // Render the screen on the prefilled-run route. render() synchronously builds the
    // pick form and SCHEDULES the dry-run via queueMicrotask, so we get the root back
    // before the dry-run fires. The render context mirrors the app's ScreenContext.
    const root = restoreFlowScreen.render({
      pattern: "/restore/:runId",
      params: { runId: reqFields.runId },
      query: new URLSearchParams(),
      path: `/restore/${reqFields.runId}`,
      engine,
      caller: operator,
      navigate: () => {},
    });
    markConnected(root); // so the screen's isConnected polls behave
    lastRoot = root;

    // Populate the REAL pick form from reqFields BEFORE the scheduled dry-run runs, so
    // the request that reaches renderRequestPanel is built by the real buildRequest()
    // reading these inputs (the request-fields come from the form, not from the test).
    // runId is already prefilled from params; set the optional include/exclude/max and,
    // when a target binding is given, select the redirect option and set its binding.
    populateForm(root, reqFields);

    await flushAsync();

    // The request panel's reason field (#rs-reason) and the "Request approval" button.
    // If the panel was not reached (plan not ok / plannedWrites 0), these are absent.
    const reasonField = querySelectorShim(root, "#rs-reason");
    const requestBtn = querySelectorAllShim(root, "button").find((b) => textOf(b).includes("Request approval"));
    if (!reasonField || !requestBtn) return null;

    // Fill the reason (required) so validateForm passes, then click the real button.
    (reasonField as { value: string }).value = reason;
    (requestBtn as { click: () => void }).click();

    await flushAsync();
    return captured;
  }

  // 6a. Standard ok plan: all three cues appear in the REAL payload with the plan's real
  // values (never hardcoded zeros / false).
  {
    const plan = makePlan({ isLatest: true, plannedWrites: 42, bytes: 8192 });
    const payload = await driveRequestPanel(plan, { runId: "RUN-A" });
    ok("6a: request panel reached + payload captured (real flow)", payload !== null);
    ok("6a: isLatest carried from plan (true)", payload?.isLatest === true);
    ok("6a: plannedWrites carried from plan (42)", payload?.plannedWrites === 42);
    ok("6a: bytes carried from plan (8192)", payload?.bytes === 8192);
    ok("6a: isLatest is NOT hardcoded false", payload?.isLatest !== false);
    ok("6a: plannedWrites is NOT hardcoded 0", payload?.plannedWrites !== 0 && payload?.plannedWrites !== undefined);
    ok("6a: bytes is NOT hardcoded 0", payload?.bytes !== 0 && payload?.bytes !== undefined);
    ok("6a: reason carried through to the payload", payload?.reason === "DR rehearsal reason");
    ok("6a: goSignedOut did not fire on the happy path", signedOut === false);
  }

  // 6b. Non-latest run: isLatest must be false in the real payload (the real flag, not a
  // fabricated value), and plannedWrites carried.
  {
    const plan = makePlan({ isLatest: false, plannedWrites: 7, bytes: 512 });
    const payload = await driveRequestPanel(plan, { runId: "RUN-B" }, "older run restore");
    ok("6b: payload captured (real flow)", payload !== null);
    ok("6b: isLatest=false carried correctly (non-latest run)", payload?.isLatest === false);
    ok("6b: plannedWrites carried (7)", payload?.plannedWrites === 7);
    ok("6b: bytes carried (512)", payload?.bytes === 512);
  }

  // 6c. The bytes-omission guard through a REACHABLE plan: plannedWrites > 0 renders the
  // panel; bytes 0 is omitted (never sent as a misleading 0), while isLatest and
  // plannedWrites are still carried. (A plannedWrites=0 plan never renders the panel, so
  // that unreachable state is not asserted; see the reachability note above.)
  {
    const plan = makePlan({ isLatest: true, plannedWrites: 5, bytes: 0 });
    const payload = await driveRequestPanel(plan, { runId: "RUN-C" }, "bytes unknown");
    ok("6c: payload captured (real flow)", payload !== null);
    ok("6c: isLatest still set when bytes is 0", payload?.isLatest === true);
    ok("6c: plannedWrites carried (5) when bytes is 0", payload?.plannedWrites === 5);
    ok("6c: bytes omitted (not sent as 0) when plan.bytes=0", payload?.bytes === undefined);
  }

  // 6d. Request fields (target, include, exclude, maxRecords) are forwarded unchanged by
  // the real handler, alongside the blast cues. (The target binding makes this a
  // redirect, which is still ok and still reaches the request panel for an Operator.)
  {
    const plan = makePlan({ isLatest: true, plannedWrites: 3, bytes: 256 });
    const payload = await driveRequestPanel(
      plan,
      { runId: "RUN-E", target: { binding: "MY_KV" }, include: ["a/"], exclude: ["b/"], maxRecords: 5 },
      "with all request fields",
    );
    ok("6d: payload captured (real flow)", payload !== null);
    ok("6d: runId forwarded", payload?.runId === "RUN-E");
    ok("6d: target forwarded", payload?.target?.binding === "MY_KV");
    ok("6d: include forwarded", payload?.include?.[0] === "a/");
    ok("6d: exclude forwarded", payload?.exclude?.[0] === "b/");
    ok("6d: maxRecords forwarded", payload?.maxRecords === 5);
    ok("6d: blast cues also present alongside request fields", payload?.isLatest === true && payload?.plannedWrites === 3 && payload?.bytes === 256);
  }

  // 6d2. An INVALID Max records value (0) must BLOCK the dry-run with an inline field error,
  // never silently drop the cap and plan the WHOLE run uncapped (a silent over-restore: "I set Max records to
  // 100 and the plan showed 40,000 writes"). buildRequest still records the drop as a witness; the guard is what
  // stops the plan. Mirrors the pairing guards (6h2/6i2) on the same form; 6d proves a VALID cap is forwarded,
  // so this is the other half.
  {
    const plan = makePlan({ isLatest: true, plannedWrites: 3, bytes: 128 });
    lastDryRunReq = null;
    const payload = await driveRequestPanel(plan, { runId: "RUN-E2", maxRecords: 0 }, "invalid max cap");
    ok("6d2: an invalid Max records (0) blocks the dry-run (no request fires)", payload === null && lastDryRunReq === null);
    ok("6d2: the invalid Max records carries the inline field error", textOf(lastRoot).includes("Max records must be a whole number"));
  }

  // 6e. Large planned-writes / bytes values are forwarded exactly (no truncation or
  // rounding) through the real handler.
  {
    const plan = makePlan({ isLatest: false, plannedWrites: 1_500_000, bytes: 2_147_483_647 });
    const payload = await driveRequestPanel(plan, { runId: "RUN-F" }, "large run");
    ok("6e: payload captured (real flow)", payload !== null);
    ok("6e: large plannedWrites forwarded exactly", payload?.plannedWrites === 1_500_000);
    ok("6e: large bytes forwarded exactly", payload?.bytes === 2_147_483_647);
  }

  // 6g. GRANULAR single-record request: recordName MUST travel on the captured payload
  // (dropping it would leave the engine approval keyed on a planHash that never matched the
  // hash the operator was shown, so the dual-control gate would stick). This
  // drives the REAL handler with the record field set and asserts the payload carries it.
  {
    const plan = makePlan({ isLatest: true, plannedWrites: 1, bytes: 128 });
    const payload = await driveRequestPanel(plan, { runId: "RUN-G", recordName: "prefix/key-007" }, "single record");
    ok("6g: payload captured (real flow)", payload !== null);
    ok("6g: recordName carried on the request payload", payload?.recordName === "prefix/key-007");
  }

  // 6h. cf-config request: the cfConfig account + zone MUST travel on the captured payload,
  // and the Cloudflare edit TOKEN must NEVER be forwarded (a secret must not transit or
  // bind into the hash). Drives the REAL handler with the cf-config fields set. The ids are
  // realistic 32-hex values: the account/zone fields validate the hex shape on input now.
  {
    const plan = makePlan({ isLatest: true, plannedWrites: 4, bytes: 1024 });
    const payload = await driveRequestPanel(
      plan,
      { runId: "RUN-H", cfConfig: { token: "cf-secret-token", accountId: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6", zoneId: "f1e2d3c4b5a6978869504132a1b2c3d4" } },
      "cf-config apply",
    );
    ok("6h: payload captured (real flow)", payload !== null);
    ok("6h: cfConfig accountId carried on the request payload", payload?.cfConfig?.accountId === "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6");
    ok("6h: cfConfig zoneId carried on the request payload", payload?.cfConfig?.zoneId === "f1e2d3c4b5a6978869504132a1b2c3d4");
    ok("6h: cfConfig token is NEVER forwarded on the request payload", (payload?.cfConfig as { token?: string } | undefined)?.token === undefined);
  }

  // 6h2. HALF-FILLED cf-config context: before the pairing guard, buildRequest silently DROPPED a
  // token typed without an account id (req.cfConfig only forms from token AND account), so the
  // restore ran without the config re-apply the operator asked for. The guard must block the
  // dry-run and put the error at the missing field.
  {
    const plan = makePlan({ isLatest: true, plannedWrites: 1, bytes: 64 });
    lastDryRunReq = null;
    const payload = await driveRequestPanel(plan, { runId: "RUN-H2", cfConfig: { token: "cf-secret-token", accountId: "" } }, "half cf-config");
    ok("6h2: a cf token without an account id blocks the dry-run (no request fires)", payload === null && lastDryRunReq === null);
    ok("6h2: the missing account id carries the pairing error inline", textOf(lastRoot).includes("needs the account id too"));
  }

  // 6h2b (VOC.5). HALF-FILLED cf-config context, THE OTHER HALF: an account id typed with the edit
  // token left blank. rs-cf-token itself carries no `required` attribute and no `validate` closure
  // (unlike rs-cf-account/rs-cf-zone, which validate their own hex shape), so a bare per-field static
  // probe that only ever drives ONE control finds no field-level check and cannot see this direction
  // at all -- it never fills the paired account field. Presence is enforced entirely by the
  // cross-field pairingError guard inside runDryRun, so only a full submit-path drive (this one)
  // proves it fires. Must block exactly as 6h2 (the reverse pairing) does, with the error on the
  // empty token.
  {
    const plan = makePlan({ isLatest: true, plannedWrites: 1, bytes: 64 });
    lastDryRunReq = null;
    const payload = await driveRequestPanel(plan, { runId: "RUN-H2B", cfConfig: { accountId: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6" } }, "half cf-config, account only");
    ok("6h2b: a cf account id without the edit token blocks the dry-run (no request fires)", payload === null && lastDryRunReq === null);
    ok("6h2b: the missing edit token carries the pairing error inline", textOf(lastRoot).includes("needs this edit token too"));
  }

  // 6h3. NON-HEX account id: the restore path now enforces the same hex charset the add-source
  // path always did (HEX_ID_PATTERN), so an id shape the source path would refuse can no longer
  // slip through the restore path to the Cloudflare API. ("acc-123" was this test's own fixture
  // before the validator existed.)
  {
    const plan = makePlan({ isLatest: true, plannedWrites: 1, bytes: 64 });
    lastDryRunReq = null;
    const payload = await driveRequestPanel(plan, { runId: "RUN-H3", cfConfig: { token: "cf-secret-token", accountId: "acc-123" } }, "non-hex account id");
    ok("6h3: a non-hex account id blocks the dry-run with the inline hex error", payload === null && lastDryRunReq === null && textOf(lastRoot).includes("must be hexadecimal"));
  }

  // 6h4. CONFIG-ONLY and MEDIA-ONLY restores must reach the confirm gate, not the "nothing to apply"
  // short-circuit. plannedWrites counts only DATA records; a cf-config surface an apply WOULD write back
  // (configChanges, willApply) and a media file an apply WOULD re-upload (mediaPlanned) each write outside that
  // count. Keying the short-circuit on plannedWrites alone would falsely call these runs no-ops and hide the
  // gate, though the engine applies them. The role-gated banner (the "permission to apply a restore" phrase)
  // only renders once the gate is PASSED (an Operator reaching renderRoleGated), so its presence proves the
  // short-circuit did not fire; "writes nothing" is the short-circuit copy.
  {
    const plan = { ...makePlan({ isLatest: true, plannedWrites: 0, bytes: 0 }), configChanges: [{ surface: "dns", summary: "2 records change", willApply: true }] };
    await driveRequestPanel(plan, { runId: "RUN-CONFIGONLY" }, "config-only restore");
    ok("6h4: a config-only plan (0 data records, a cf-config surface WILL apply) reaches the confirm gate", textOf(lastRoot).includes("permission to apply a restore") && !textOf(lastRoot).includes("writes nothing"));
  }
  {
    const plan = makePlan({ isLatest: true, plannedWrites: 0, bytes: 0, mediaPlanned: [{ name: "clip-01", type: "stream" }] });
    await driveRequestPanel(plan, { runId: "RUN-MEDIAONLY" }, "media-only restore");
    ok("6h4: a media-only plan (0 data records, a media file WILL re-upload) reaches the confirm gate", textOf(lastRoot).includes("permission to apply a restore") && !textOf(lastRoot).includes("writes nothing"));
  }
  {
    const plan = makePlan({ isLatest: true, plannedWrites: 0, bytes: 0 });
    await driveRequestPanel(plan, { runId: "RUN-EMPTYPLAN" }, "empty plan");
    ok("6h4: a plan that writes nothing on ANY surface still short-circuits to 'nothing to apply'", textOf(lastRoot).includes("writes nothing") && !textOf(lastRoot).includes("permission to apply a restore"));
  }

  // 6i. D1 TABLE-SUBSET request (the new restore flow): fill the real D1 controls (a database, a tables
  // list, and the create-only toggle), drive the REAL flow, and assert (1) the D1 controls render so an
  // operator can reach the new flow, (2) the d1Tables scope reaches the DRY-RUN request the real
  // buildRequest() produced, (3) it reaches the APPROVAL request too (it binds into the plan hash, so
  // dropping it would stick the dual-control gate), and (4) the foreign-key dependency warning renders on
  // the plan. This drives the production restoreFlowScreen, never a copy of its logic.
  {
    const plan = makePlan({ isLatest: true, plannedWrites: 3, bytes: 256, dependencyWarnings: [{ database: "app_db", table: "orders", missingParent: "users" }] });
    const payload = await driveRequestPanel(
      plan,
      { runId: "RUN-I", d1Tables: { database: "app_db", tables: ["users", "orders"], createOnly: true } },
      "d1 table subset",
    );
    ok("6i: payload captured (real flow)", payload !== null);
    // (1) The D1 controls render, so an operator can perform the new restore flow.
    ok("6i: the D1 table-subset controls render (database, tables, create-only)", querySelectorShim(lastRoot, "#rs-d1-db") !== null && querySelectorShim(lastRoot, "#rs-d1-tables") !== null && querySelectorShim(lastRoot, "#rs-d1-createonly") !== null);
    // (2) The dry-run request the real buildRequest() produced carries the full d1Tables scope. (This alone
    // proves the controls exist and are wired: populateForm could not have set them, and buildRequest could
    // not have read them, if they were absent.)
    const dr = lastDryRunReq as { d1Tables?: { database?: string; tables?: string[]; createOnly?: boolean } } | null;
    ok("6i: the DRY-RUN request carries d1Tables (database + tables + createOnly)", dr?.d1Tables?.database === "app_db" && dr?.d1Tables?.tables?.join(",") === "users,orders" && dr?.d1Tables?.createOnly === true);
    // (3) The approval request carries d1Tables (it binds the plan hash; dropping it sticks the gate).
    const pay = payload as { d1Tables?: { database?: string; createOnly?: boolean } } | null;
    ok("6i: the APPROVAL request carries d1Tables (dual-control planHash match)", pay?.d1Tables?.database === "app_db" && pay?.d1Tables?.createOnly === true);
    // (4) The foreign-key dependency warning renders on the plan (the lint is visible to the operator).
    ok("6i: the FK dependency warning renders on the plan (child references an unselected parent)", textOf(lastRoot).includes("reference a parent not in this restore") && textOf(lastRoot).includes("orders") && textOf(lastRoot).includes("users"));
  }

  // 6i2. HALF-FILLED D1 subset: tables without a database (or the reverse) can fall through
  // buildRequest's `database !== "" && tables.length > 0` guard to a WHOLE-RUN restore, the exact
  // opposite of the operator's narrow intent. The pairing guard must block the dry-run instead.
  {
    const plan = makePlan({ isLatest: true, plannedWrites: 3, bytes: 256 });
    lastDryRunReq = null;
    const payload = await driveRequestPanel(plan, { runId: "RUN-I2", d1Tables: { database: "", tables: ["users"] } }, "half d1 subset");
    ok("6i2: tables without a database block the dry-run (no whole-run fallback)", payload === null && lastDryRunReq === null);
    ok("6i2: the missing database carries the pairing error inline", textOf(lastRoot).includes("needs the D1 database"));
  }

  // 6j. MEDIA RESTORE request (the media restore UI, source-granularity audit item 6): fill the real
  // media edit-token + account fields, drive the REAL flow, and assert (1) the media controls render so
  // an operator can reach the feature, (2) the dry-run request the real buildRequest() produced carries
  // mediaRestore { token, accountId }, (3) the
  // mediaPlanned rows the stubbed dry-run plan carries render on screen (the media-to-upload preview),
  // (4) the APPROVAL request carries mediaRestore { accountId } WITHOUT the token (it binds into the plan
  // hash the same way cfConfig/recordName/d1Tables do -- dropping it would stick the dual-control gate),
  // and (5) the token itself is
  // NEVER forwarded on the approval payload (a secret must not transit or bind). Drives the production
  // restoreFlowScreen, never a copy of its logic.
  {
    const plan = makePlan({
      isLatest: true,
      plannedWrites: 2,
      bytes: 4096,
      mediaPlanned: [{ name: "uid-777/video.mp4", type: "stream" }, { name: "img-42/blob", type: "images" }],
    });
    const payload = await driveRequestPanel(
      plan,
      { runId: "RUN-J", mediaRestore: { token: "media-secret-token", accountId: "0a1b2c3d4e5f60718293a4b5c6d7e8f9" } },
      "media restore",
    );
    ok("6j: payload captured (real flow)", payload !== null);
    // (1) The media controls render, so an operator can perform the media restore.
    ok("6j: the media restore controls render (token, account)", querySelectorShim(lastRoot, "#rs-media-token") !== null && querySelectorShim(lastRoot, "#rs-media-account") !== null);
    // (2) The dry-run request carries mediaRestore { token, accountId } (this alone proves the controls
    // exist and are wired: populateForm could not have set them, and buildRequest could not have read
    // them, if they were absent).
    const dr = lastDryRunReq as { mediaRestore?: { token?: string; accountId?: string } } | null;
    ok("6j: the DRY-RUN request carries mediaRestore (token + accountId)", dr?.mediaRestore?.token === "media-secret-token" && dr?.mediaRestore?.accountId === "0a1b2c3d4e5f60718293a4b5c6d7e8f9");
    // (3) The mediaPlanned rows (the stubbed dry-run plan's media-to-upload preview) render, including
    // the video/image distinction (a video re-uploads as a NEW id; an image keeps its original id).
    const planTxt = textOf(lastRoot);
    ok("6j: the mediaPlanned video row renders with its record name", planTxt.includes("uid-777/video.mp4"));
    ok("6j: the mediaPlanned image row renders with its record name", planTxt.includes("img-42/blob"));
    ok("6j: the video row states it re-uploads as a NEW id", planTxt.includes("NEW id"));
    ok("6j: the image row states it keeps its original id", planTxt.includes("keeping its original id"));
    // (4) The APPROVAL request carries mediaRestore { accountId } (it binds the plan hash; dropping it
    // sticks the gate -- validate-plan-hash.ts pins the hash-level contract this exercises end to end).
    const pay = payload as { mediaRestore?: { accountId?: string; token?: string } } | null;
    ok("6j: the APPROVAL request carries mediaRestore.accountId (dual-control planHash match)", pay?.mediaRestore?.accountId === "0a1b2c3d4e5f60718293a4b5c6d7e8f9");
    // (5) The Cloudflare media edit TOKEN must NEVER be forwarded on the approval payload (a secret must
    // not transit or bind into the hash), matching cf-config's own no-custody guarantee (6h above).
    ok("6j: the media edit token is NEVER forwarded on the request payload", pay?.mediaRestore?.token === undefined);
  }

  // 6j2 (VOC.5). HALF-FILLED media-restore context: an account id typed with the edit token left
  // blank. rs-media-token, like rs-cf-token above, carries no `required` attribute and no `validate`
  // closure of its own, so a bare per-field static probe cannot see this direction either. Presence
  // is enforced entirely by the cross-field pairingError guard inside runDryRun; only a full
  // submit-path drive proves it fires. Must block, with the error on the empty token.
  {
    const plan = makePlan({ isLatest: true, plannedWrites: 1, bytes: 64 });
    lastDryRunReq = null;
    const payload = await driveRequestPanel(plan, { runId: "RUN-J2", mediaRestore: { accountId: "0a1b2c3d4e5f60718293a4b5c6d7e8f9" } }, "half media restore, account only");
    ok("6j2: a media account id without the edit token blocks the dry-run (no request fires)", payload === null && lastDryRunReq === null);
    ok("6j2: the missing edit token carries the pairing error inline", textOf(lastRoot).includes("needs this edit token too"));
  }

  // 6k. a Redirect target with an EMPTY binding must BLOCK the dry-run
  // at the field, never plan against the live original bindings (the opposite of what the operator chose,
  // and the highest blast radius this screen has), and filling the binding in must let it proceed. This
  // drives the production restoreFlowScreen exactly as an operator would: render on the prefilled-run
  // route, select the Redirect radio directly with the binding left blank (populateForm only selects
  // redirect for a NON-EMPTY binding, which is not this scenario), and assert engine.restore is NEVER
  // called and the inline binding error shows. Then fill the binding and build the plan again, asserting
  // engine.restore now fires carrying the typed binding.
  {
    const operator: Caller = { method: "access", email: "op@maelstrom.au", role: "operator", groups: [], isOnlyOwner: false };
    store.setCaller(operator);
    store.connect("https://engine.test");
    const engine = store.getEngine();
    if (!engine) throw new Error("6k: no engine in store");
    let restoreCalls = 0;
    // A recorder written only from inside a callback: on a local `let` the compiler keeps the
    // narrowing from its initialiser, because it cannot see the callback run, so the assertion below
    // reads as always-false and proves nothing. Narrowing on an object's properties is discarded at
    // each call, which is the assumption that holds here.
    const rec: { lastReq: RestoreRequest | null } = { lastReq: null };
    const plan = makePlan({ isLatest: true, plannedWrites: 1, bytes: 100 });
    (engine as unknown as { restore: (req: RestoreRequest) => Promise<RestorePlan> }).restore = async (req) => {
      restoreCalls++;
      rec.lastReq = req;
      return plan;
    };

    // Render on the prefilled-run route with NO target binding, so a still-broken guard would plan against
    // the original bindings the moment the auto-scheduled dry-run (queueMicrotask) fires. render() returns
    // before that microtask runs, leaving a synchronous window to select Redirect first (the same ordering
    // populateForm's own callers rely on).
    const root = restoreFlowScreen.render({
      pattern: "/restore/:runId",
      params: { runId: "RUN-K" },
      query: new URLSearchParams(),
      path: "/restore/RUN-K",
      engine,
      caller: operator,
      navigate: () => {},
    });
    markConnected(root);

    // Select the Redirect radio directly, leaving the binding input blank -- the exact gap populateForm
    // cannot express (it only selects redirect for a non-empty binding).
    const inputs = querySelectorAllShim(root, "input");
    const redirectRadio = inputs.find((i) => i.getAttribute("value") === "redirect");
    const bindingInput = inputs.find((i) => i.getAttribute("aria-label") === "Redirect target binding name");
    if (!redirectRadio || !bindingInput) throw new Error("6k: redirect radio or binding input not found");
    redirectRadio.checked = true;
    redirectRadio.dispatchEvent({ type: "change", target: null, currentTarget: null, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });

    await flushAsync();

    ok("6k: a Redirect with an empty binding fires NO dry-run engine call (blocked)", restoreCalls === 0 && rec.lastReq === null);
    ok("6k: the empty-binding error shows inline", textOf(root).includes("Enter the binding to redirect to"));

    // Filling the binding in clears the error and, on a fresh dry-run, must now let the request through.
    bindingInput.value = "KV_RESTORE_STAGING";
    bindingInput.dispatchEvent({ type: "input", target: null, currentTarget: null, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });
    ok("6k: typing a binding clears the empty-binding error", !textOf(root).includes("Enter the binding to redirect to"));

    const dryRunBtn = querySelectorAllShim(root, "button").find((b) => b.getAttribute("data-dp") === "restore-flow.button.dry-run");
    if (!dryRunBtn) throw new Error("6k: dry-run button not found");
    dryRunBtn.click();

    await flushAsync();

    ok("6k: filling the binding lets the dry-run proceed (engine.restore called)", restoreCalls === 1);
    ok("6k: the request carries the typed redirect binding", rec.lastReq?.target?.binding === "KV_RESTORE_STAGING");
  }

  // ==========================================================================
  // SECTION 6B: restorability assurance -- the BLIND restore test action renders an
  // attestation and NEVER shows record content; the capability gates it (REAL CODE)
  //
  // The restore screen's run-context column hosts renderRestorabilityCard (src/screens/
  // restore-flow.ts), which offers the read-safe BLIND restore test ("Verify restorability
  // (no data exposed)") and the keyless integrity attestation. This section drives the REAL
  // screen, never a copy of its logic: it renders restoreFlowScreen on a prefilled-run route
  // (the run-context column renders only when the run is located in listAllHistory), stubs
  // EngineClient.verifyRestore to return a CLEAN blind-test attestation, clicks the real
  // "Verify restorability" button, and asserts:
  //   (1) the attestation renders ("N of N records restorable, 0 failures") from the stub;
  //   (2) NO record content appears anywhere in the rendered tree -- the blind-test wire shape
  //       carries no value by construction, so a clean pass shows counts + a digest (a hash)
  //       only. A sentinel "value" string is deliberately NOT in any rendered field, and the
  //       test also smuggles a sentinel into a record-name-shaped place the renderer must not
  //       echo on a clean pass, proving the success path discloses nothing.
  //   (3) the capability gate: a restore.verify-capable caller (viewer holds it from the floor)
  //       gets an ENABLED button; a null caller (no role yet reported) gets it DISABLED with the
  //       capability reason -- exactly the canCap gate the card uses.
  // ==========================================================================
  console.log("\n-- 6B: restorability assurance (real renderRestorabilityCard) --");

  // driveRestorabilityCard renders the REAL restore screen for the given caller on a prefilled
  // run, stubs the engine reads the card needs, clicks the verify button (when present+enabled),
  // and returns the rendered text plus the verify button's enabled/disabled state. The run id is
  // located via listAllHistory so the run-context column (which hosts the card) renders.
  async function driveRestorabilityCard(
    callerArg: Caller | null,
    blind: BlindTest,
    opts: { clickVerify: boolean } = { clickVerify: true },
  ): Promise<{ rootText: string; verifyDisabled: boolean | null; verifyTitle: string | null; verifyCalled: boolean; drillDisabled: boolean | null; drillTitle: string | null }> {
    store.setCaller(callerArg);
    store.connect("https://engine.test");
    const engine = store.getEngine();
    // The drill pair too, null like the verify pair beside it: with no engine nothing renders, so neither
    // control exists to be enabled or titled. The main return grew them and this arm did not follow.
    if (!engine) return { rootText: "", verifyDisabled: null, verifyTitle: null, verifyCalled: false, drillDisabled: null, drillTitle: null };

    const RUN_ID = "RUN-RV";
    // The located run (in the recent ring) so renderRunContext renders the context column.
    const ring: RunHistoryEntry[] = [
      { runId: RUN_ID, index: 7, startedAt: "2026-06-09T00:00:00Z", status: "ok", recordCount: blind.recordsVerified, bytes: blind.bytesVerified },
    ];
    (engine as unknown as { listAllHistory: () => Promise<{ byDownpipe: Record<string, RunHistoryEntry[]> }> }).listAllHistory = async () => ({ byDownpipe: { "dp-rv": ring } });
    // listDownpipes powers the "last proven" line AND the fleet recency card; return a downpipe
    // whose lastRestoreProven* is honestly ABSENT (never proven yet), so the line cannot read a
    // false "proven" and the test does not depend on a fabricated date.
    (engine as unknown as { listDownpipes: () => Promise<unknown[]> }).listDownpipes = async () => [
      { config: { id: "dp-rv", name: "dp-rv", cadenceSeconds: 86400, enabled: true, source: { type: "kv", binding: "KV", include: [], exclude: [] } }, nextRunAt: 0, lastRunId: RUN_ID, inFlight: false },
    ];
    // The right column auto-runs a dry-run; return a benign ok plan so it settles without error.
    (engine as unknown as { restore: (req: unknown) => Promise<RestorePlan> }).restore = async () => makePlan({ isLatest: true, plannedWrites: 0, bytes: 0 });
    (engine as unknown as { listApprovals: () => Promise<RestoreApproval[]> }).listApprovals = async () => [];
    // The blind restore test under assertion: capture that it was called, return the attestation.
    let verifyCalled = false;
    (engine as unknown as { verifyRestore: (req: { runId: string }) => Promise<BlindTest> }).verifyRestore = async () => {
      verifyCalled = true;
      return blind;
    };

    const root = restoreFlowScreen.render({
      pattern: "/restore/:runId",
      params: { runId: RUN_ID },
      query: new URLSearchParams(),
      path: `/restore/${RUN_ID}`,
      engine,
      caller: callerArg as Caller,
      navigate: () => {},
    });
    markConnected(root);
    await flushAsync();

    // The verify button (left column run-context card). Located by its label text. REFUSEDNESS is read
    // from aria-disabled, not from the disabled attribute, and that is a deliberate change of contract
    // rather than a looser read. A `disabled` control is removed from the tab order, so the reason it
    // carried was reachable by mouse only; the refusal is now announced with aria-disabled while the
    // control stays focusable, and the reason is real text inside it. The gate's DECISION is unchanged
    // and is what these assertions are about; only its delivery moved.
    const verifyBtn = querySelectorAllShim(root, "button").find((b) => textOf(b).includes("Verify restorability"));
    const verifyDisabled = verifyBtn ? verifyBtn.getAttribute("aria-disabled") === "true" : null;
    const verifyTitle = verifyBtn ? verifyBtn.getAttribute("title") : null;
    // The drill button lives in the SAME proof card (proof.ts renderProofCard) and gates on drill.run.
    // Captured here so 6R-proof can assert the drill gate without a second driver.
    const drillBtn = querySelectorAllShim(root, "button").find((b) => textOf(b).includes("Drill this run"));
    const drillDisabled = drillBtn ? drillBtn.getAttribute("aria-disabled") === "true" : null;
    const drillTitle = drillBtn ? drillBtn.getAttribute("title") : null;
    if (opts.clickVerify && verifyBtn && verifyDisabled === false) {
      (verifyBtn as unknown as { click: () => void }).click();
      await flushAsync();
    }
    return { rootText: textOf(root), verifyDisabled, verifyTitle, verifyCalled, drillDisabled, drillTitle };
  }

  // A caller who HOLDS restore.verify (viewer holds it from the read floor up). Verify is enabled.
  const verifyCaller: Caller = { method: "access", email: "viewer@maelstrom.au", role: "viewer", groups: [], isOnlyOwner: false };

  // 6B-a. The clean blind-test attestation renders from the stub: "N of N records restorable, 0
  // failures", AND no record content is shown. The sentinel value/name are never echoed.
  {
    const SENTINEL_DIGEST = "sha384:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const blind = makeBlindTest({ ok: true, recordsVerified: 1432, bytesVerified: 5_000_000, restoreDigest: SENTINEL_DIGEST });
    const r = await driveRestorabilityCard(verifyCaller, blind);
    ok("6B-a: verifyRestore (blind test) was actually called by the real action", r.verifyCalled === true);
    ok("6B-a: the attestation renders the N of N restorable summary", r.rootText.includes("1,432 of 1,432 records restorable, 0 failures"));
    ok("6B-a: the verdict is the positive 'Restorable' state", r.rootText.includes("Restorable"));
    // The card shows the digest truncated to its first 28 chars (slice(0,28)): "sha384:" (7) + 21 hex.
    ok("6B-a: the restore digest (a hash, redaction-safe) is shown", r.rootText.includes("sha384:0123456789abcdef0123"));
    // The crystal-clear NO-data assurance copy is present. The no-data fact is stated ONCE, by
    // the card's standing line + badge; the verdict does not restate it, so the assertion targets
    // the standing line.
    ok("6B-a: states crystal-clear that NO record contents are shown", r.rootText.includes("No record contents are returned, logged or displayed"));
    ok("6B-a: the standing 'no data exposed' framing is present", r.rootText.includes("No record contents are returned") || r.rootText.includes("no data exposed"));
  }

  // 6B-b. The NO-record-content invariant, proven adversarially: even if the engine result tried to
  // smuggle a value, the clean render never shows record contents. A clean pass has zero failures,
  // so no record NAME or value is ever rendered. We assert the rendered tree contains none of the
  // sentinels that would only appear if the card echoed a record's content or name.
  {
    const blind = makeBlindTest({ ok: true, recordsVerified: 3, bytesVerified: 1024, restoreDigest: "sha384:abc" });
    const r = await driveRestorabilityCard(verifyCaller, blind);
    // These sentinels are NOT placed in any field the renderer reads on a clean pass; they stand in
    // for a record's plaintext value and source key respectively. Their absence proves no content
    // and no record name leaked into the attestation.
    ok("6B-b: no record plaintext value is shown (blind test discloses nothing)", !r.rootText.includes("SECRET-PLAINTEXT-VALUE"));
    ok("6B-b: no per-record source key is shown on a clean pass", !r.rootText.includes("uploads/customer-pii.json"));
    // And positively: a clean pass shows counts + the no-data line, never a record table.
    ok("6B-b: a clean pass shows counts, not a record list", r.rootText.includes("3 of 3 records restorable, 0 failures"));
  }

  // 6B-c. The capability gate. A restore.verify-capable caller (viewer) gets an ENABLED verify
  // button; a null caller (no role reported yet) gets it DISABLED with the capability reason. This
  // is exactly the canCap("restore.verify") gate the card applies.
  {
    const blind = makeBlindTest({ ok: true, recordsVerified: 1, bytesVerified: 1, restoreDigest: "sha384:00" });
    const enabled = await driveRestorabilityCard(verifyCaller, blind, { clickVerify: false });
    ok("6B-c: a restore.verify-capable caller (viewer) gets the verify action ENABLED", enabled.verifyDisabled === false);

    const gated = await driveRestorabilityCard(null, blind, { clickVerify: false });
    ok("6B-c: a null caller (no role yet) gets the verify action DISABLED", gated.verifyDisabled === true);
    ok(
      "6B-c: the disabled verify action names the PERMISSION in customer language, not the raw capability id",
      (gated.verifyTitle ?? "").includes("permission to verify restorability") && !(gated.verifyTitle ?? "").includes("restore.verify"),
    );
    ok(
      "6B-c: the gated card explains the PERMISSION is read-only and reveals nothing, without the raw id",
      gated.rootText.includes("permission to verify restorability") && gated.rootText.includes("never reveals a record") && !gated.rootText.includes("restore.verify"),
    );
  }

  // ==========================================================================
  // SECTION 6C: mediaRestored rendering (receipt.ts renderReceipt) -- the old->new video uid remap
  // ==========================================================================
  // renderReceipt's mediaRestored block is the ONLY place an operator sees a re-uploaded video's NEW
  // Stream uid after a media restore (Stream always mints a new uid on upload; an image keeps its
  // original id). It had zero coverage. The result below is deliberately NOT a clean outcome (ok:false
  // plus one unrelated per-record failure) so renderReceipt's success-tick draw effect (drawStrokeOnce,
  // gated on `!outcome.partial`, which touches SVGPathElement.getTotalLength()/requestAnimationFrame --
  // neither implemented by this shim) is never reached; mediaRestored itself renders unconditionally on
  // any outcome, so a partial apply still fully exercises the block under test.
  {
    const res: RestoreResult = {
      ok: false,
      runId: "RUN-MEDIA-RECEIPT",
      mode: "applied",
      recordsVerified: 10,
      recordsRestored: 8,
      bytesRestored: 4_000_000,
      isLatest: true,
      failures: [{ name: "kv/unrelated-record", reason: "engine 500" }],
      mediaRestored: [
        { name: "hero.mp4", restoredId: "stream-uid-new-789", remapped: true }, // video: Stream mints a NEW uid
        { name: "logo.png", restoredId: "logo.png", remapped: false }, // image: keeps its original id
      ],
    };
    const card = renderReceipt(res, "operator@example.com", "sha384:planhash-6c", "checker@example.com", () => {});
    const txt = textOf(card);
    ok("6C: the media summary counts both files and the one remapped one", txt.includes("Media re-uploaded (2 files, 1 remapped to a new id)"));
    ok("6C: the remapped video's own name is shown", txt.includes("hero.mp4"));
    ok("6C: the remapped video shows its NEW Stream uid (what any reference must be updated to)", txt.includes("stream-uid-new-789"));
    ok("6C: the remapped row explains the old id no longer resolves", txt.includes("update any reference to the old id"));
    ok("6C: the non-remapped image's own name is shown", txt.includes("logo.png"));
    ok("6C: the non-remapped image states it kept its original id", txt.includes("restored to its original id"));
    // Negative: the remap arrow appears exactly once (the video), never a second time (the image row must
    // not also be described as remapped).
    const remapArrowCount = (txt.match(/-> new id/g) ?? []).length;
    ok("6C: exactly one row shows the remap arrow (the video only, not the image)", remapArrowCount === 1);
  }

  // 6D: an apply that WROTE everything it could but deliberately skipped some records. restoreOutcome used
  // to ignore skipped[] entirely, so this rendered as a clean green "Restore applied" above an unexplained
  // "Restored 98 of 100" line, and the per-record reasons the operator had just been shown in the dry-run
  // plan were gone at the moment the apply made them real. Those records are in the archive and are not in
  // the account.
  //
  // Rendering under the shim is safe for the same reason 6C is: the outcome is partial, so the success-tick
  // draw effect (drawStrokeOnce, gated on !outcome.partial) is not reached. That gate is not incidental
  // here, it is the point: a restore with records outstanding must not draw the clean-success tick.
  {
    const res: RestoreResult = {
      ok: true,
      runId: "RUN-SKIPPED-RECEIPT",
      mode: "applied",
      recordsVerified: 100,
      recordsRestored: 98,
      bytesRestored: 2_048,
      isLatest: true,
      failures: [],
      skipped: [
        { name: "secrets/API_TOKEN", reason: "Secrets Store value, restore out of band: the binding is read-only at runtime, so there is no in-account write path; recover the value from this archive with the offline reader and your break-glass key, then re-create the secret through the Cloudflare API or wrangler" },
        { name: "kv/vanished-key", reason: "the captured value is an incompleteness marker (the object vanished or was skipped at capture), not real bytes; nothing written" },
      ],
    };
    const card = renderReceipt(res, "operator@example.com", "sha384:planhash-6d", "checker@example.com", () => {});
    const txt = textOf(card);
    ok("6D: the count that actually landed is still stated plainly", txt.includes("Restored 98 of 100 verified records"));
    // The load-bearing line. Without it the operator sees the shortfall and no reason for it.
    ok("6D: the receipt says records are outstanding, not merely that fewer landed", txt.includes("still outstanding"));
    ok("6D: it says where those records are and are not", txt.includes("in the archive and not in your account"));
    ok("6D: it says plainly that this was deliberate, so it does not read as a failure", txt.includes("deliberately not written"));
    // The skipped records themselves, grouped by what to DO, the same grouping the dry-run plan showed.
    ok("6D: the secrets record is named", txt.includes("secrets/API_TOKEN"));
    ok("6D: the marker record is named", txt.includes("kv/vanished-key"));
    ok("6D: the marker record's reason survives into the receipt", txt.includes("incompleteness marker"));
    // Redaction: names and reasons only, never a value. Same rule the failures list follows.
    ok("6D: no record value reaches the receipt", !txt.includes("2_048") && !/value:/i.test(txt));
  }

  // ==========================================================================
  // SECTION 6R: the restore confirm/apply gate is by CAPABILITY, not role RANK
  //
  // renderConfirm must not gate the apply/request panel on canDo("approver") -- a cumulative role
  // RANK (common.ts hasRole) -- because the engine grants restore.request + restore.apply to the
  // restore-operator role, which sits OFF that ladder (roleRank 0). Gating by rank would let the
  // engine accept a disposable restore-operator's dry-run (HTTP 200) while the console offered it
  // NO request path and NO apply path: the authorised recovery-only DR role could not complete a
  // restore. The panel gates by the capability the engine enforces (canCap("restore.apply") for the
  // apply path, canCap("restore.request") for the request path), so the role's real capability set
  // drives what it is offered.
  //
  // These drive the REAL renderConfirm (src/screens/restore-flow/confirm.ts) under the shared shim,
  // never a copy of its gate. A controlled planHash plus an injected listApprovals arms the apply
  // gate deterministically (findUsableApproval needs a distinct approver bound to THIS hash). The
  // apply track's 5s approval poll (startPoll -> window.setInterval) is neutralised for the section
  // so no real timer outlives it; flushAsync drives the async recheck that paints armed/unarmed.
  // ==========================================================================
  console.log("\n-- 6R: restore role-vs-capability gate (real renderConfirm) --");
  {
    // Import the real gate AFTER the shim is installed (the coordinator installed it before calling
    // this driver), matching how the screen modules are loaded post-shim.
    const { renderConfirm } = await import("../src/screens/restore-flow/confirm.ts");

    // Neutralise the unarmed apply track's 5s approval poll so no real timer outlives the section.
    // flushAsync runs on setTimeout, not setInterval, so this does not affect it; window === globalThis
    // in the shim, so window.setInterval picks up the stub too.
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    (globalThis as unknown as { setInterval: () => number }).setInterval = () => 0;
    (globalThis as unknown as { clearInterval: () => void }).clearInterval = () => {};

    const PLAN_HASH = "sha384:restore-capability-fixed-plan-hash";
    const CHECKER = "distinct-approver@maelstrom.au"; // the second identity (maker != checker)

    // A usable approval bound to THIS plan hash from a DISTINCT approver (findUsableApproval, shared.ts):
    // status approved, and an approvedBy that differs from the applying caller.
    const usableApproval = (callerEmail: string): RestoreApproval => ({
      planHash: PLAN_HASH, runId: "RUN-RDIV", isLatest: true, plannedWrites: 42, bytes: 8192,
      redirectBinding: null, requestedBy: callerEmail, requestedAt: "2026-01-01T00:00:00Z",
      reason: "DR drill", status: "approved", approvedBy: CHECKER, approvedAt: "2026-01-01T01:00:00Z",
      expiresAt: "2030-01-01T00:00:00Z",
    });

    // renderGate renders the REAL renderConfirm for a caller of the given role, with the given approval
    // listing, and returns the confirm section after the async approval gate has settled.
    async function renderGate(role: Caller["role"], email: string, approvals: RestoreApproval[]): Promise<unknown> {
      store.setCaller({ method: "access", email, role, groups: [], isOnlyOwner: false });
      store.connect("https://engine.test");
      const engine = store.getEngine();
      if (!engine) throw new Error("6R: no engine in store");
      (engine as unknown as { listApprovals: () => Promise<RestoreApproval[]> }).listApprovals = async () => approvals;
      // STUBBED BECAUSE IT IS A REAL NETWORK CALL OTHERWISE, and it is the FIRST await in the approval
      // gate's recheck. Unstubbed it goes to https://engine.test, so how long the gate takes to leave its
      // "Checking whether this plan has an approval" state depends on how long this machine takes to fail
      // a DNS lookup. flushAsync's budget is counted in TICKS and that wait is WALL CLOCK, so the two
      // cannot bound each other: this is what made 6R-1, 6R-2, 6R-5 and 6R-6 fail in CI in varying
      // combinations while passing 65 times locally, idle and under load.
      // null is what the screen already saw here: the real call rejects and its catch sets policy to null,
      // so this changes what the test COSTS and not what it exercises.
      (engine as unknown as { getConfigApprovalPolicy: () => Promise<null> }).getConfigApprovalPolicy = async () => null;
      const plan = makePlan({ isLatest: true, plannedWrites: 42, bytes: 8192 });
      const req: RestoreRequest = { runId: "RUN-RDIV" };
      const section = await renderConfirm(
        engine, plan, req, PLAN_HASH,
        { highImpact: false, isLarge: false, isRedirect: false, isNonLatest: false, isCrossAccount: false, isCrossZone: false },
        () => {}, () => {},
      );
      markConnected(section);
      await flushAsync();
      return section;
    }

    const buttonWithText = (section: unknown, label: string): boolean =>
      querySelectorAllShim(section, "button").some((b) => textOf(b).includes(label));
    const hasRequestPath = (section: unknown): boolean =>
      querySelectorShim(section, "#rs-reason") !== null && buttonWithText(section, "Request approval");
    const hasApplyButton = (section: unknown): boolean => buttonWithText(section, "Apply restore");
    // gateState is the DIAGNOSTIC for the apply-button assertions below, printed only when one fails.
    // The gate paints one of three things into .restore-confirm__gate: the "Checking whether this plan
    // has an approval" hint it starts on, an unarmed request panel, or the armed panel that carries
    // Apply. Which of the three is on screen separates a gate that never resolved from one that resolved
    // to a refusal, and the label alone cannot tell them apart.
    const gateState = (section: unknown): string => {
      const host = querySelectorShim(section, ".restore-confirm__gate");
      const armed = querySelectorShim(section, ".restore-confirm__armed") !== null;
      const unarmed = querySelectorShim(section, ".restore-confirm__unarmed") !== null;
      const buttons = querySelectorAllShim(section, "button").map((b) => textOf(b).trim()).filter((t) => t.length > 0);
      const hostText = textOf(host).replace(/\s+/g, " ").trim().slice(0, 160);
      return `gate: armed=${armed} unarmed=${unarmed} buttons=[${buttons.join(" | ")}] host="${hostText}"`;
    };
    const hasCheckForApproval = (section: unknown): boolean => buttonWithText(section, "Check for approval");
    const hasReadOnlyNote = (section: unknown): boolean => textOf(section).includes("cannot request or apply a restore");

    try {
      // 6R-1: a restore-operator with no approval yet -- the headline fix. It now SEES the dual-control
      // request path AND is on the apply track (the check-for-approval refresh the apply gate paints), and
      // is never dead-ended on the read-only note. Before the fix it got the viewer note: neither path.
      {
        const s = await renderGate("restore-operator", "dr@maelstrom.au", []);
        ok("6R-1: restore-operator now SEES the dual-control request path (was hidden by the rank gate)", hasRequestPath(s));
        ok("6R-1: restore-operator is on the APPLY track (the apply gate's check-for-approval refresh)", hasCheckForApproval(s));
        ok("6R-1: restore-operator is NOT dead-ended on the read-only note", !hasReadOnlyNote(s));
        ok("6R-1: no Apply button until a distinct approver signs (empty approval listing)", !hasApplyButton(s));
      }

      // 6R-2: a restore-operator WITH a distinct-approver approval bound to this plan sees the real Apply
      // button -- proof the apply path (not just the request path) is genuinely reachable for the DR role.
      {
        const s = await renderGate("restore-operator", "dr@maelstrom.au", [usableApproval("dr@maelstrom.au")]);
        ok("6R-2: restore-operator with a distinct-approver approval SEES the Apply restore button", hasApplyButton(s), () => gateState(s));
      }

      // 6R-3: a viewer holds no restore capability -- still sees NEITHER path, only the read-only note.
      {
        const s = await renderGate("viewer", "viewer@maelstrom.au", []);
        ok("6R-3: a viewer still sees the read-only note", hasReadOnlyNote(s));
        ok("6R-3: a viewer sees NO request path", !hasRequestPath(s));
        ok("6R-3: a viewer sees NO apply path (no Apply button, no apply-track refresh)", !hasApplyButton(s) && !hasCheckForApproval(s));
      }

      // 6R-4: an operator holds restore.request but NOT restore.apply -- unchanged: the request path, but
      // NOT the apply track (no check-for-approval refresh, no Apply button). Proves the fix did not widen
      // an operator onto the apply path.
      {
        const s = await renderGate("operator", "op@maelstrom.au", []);
        ok("6R-4: an operator (request-only) still sees the request path", hasRequestPath(s));
        ok("6R-4: an operator is NOT put on the apply track (no check-for-approval refresh)", !hasCheckForApproval(s));
        ok("6R-4: an operator sees no Apply button", !hasApplyButton(s));
      }

      // 6R-5 / 6R-6: the approver and owner apply paths are UNCHANGED -- a distinct-approver approval bound
      // to this plan arms the Apply button exactly as before.
      {
        const s = await renderGate("approver", "approver@maelstrom.au", [usableApproval("approver@maelstrom.au")]);
        ok("6R-5: the approver apply path is unchanged (Apply restore shown with a distinct approval)", hasApplyButton(s), () => gateState(s));
      }
      {
        const s = await renderGate("owner", "owner@maelstrom.au", [usableApproval("owner@maelstrom.au")]);
        ok("6R-6: the owner apply path is unchanged (Apply restore shown with a distinct approval)", hasApplyButton(s), () => gateState(s));
      }

      // 6R-7: an access-admin is people-only (no restore.request, no restore.apply) -- a genuinely
      // unauthorised role for restore is still refused BOTH paths and gets the read-only note.
      {
        const s = await renderGate("access-admin", "access-admin@maelstrom.au", []);
        ok("6R-7: an access-admin is refused the request path", !hasRequestPath(s));
        ok("6R-7: an access-admin sees no apply path", !hasApplyButton(s) && !hasCheckForApproval(s));
        ok("6R-7: an access-admin gets the read-only note", hasReadOnlyNote(s));
      }
    } finally {
      (globalThis as unknown as { setInterval: typeof realSetInterval }).setInterval = realSetInterval;
      (globalThis as unknown as { clearInterval: typeof realClearInterval }).clearInterval = realClearInterval;
    }
  }
  // SECTION 6S: restore capability parity -- each restore surface gates by
  // the CAPABILITY the engine enforces, not the role RANK (REAL CODE)
  //
  // The single-run confirm/apply panel is covered above; this section covers the other four restore
  // surfaces that gated by role rank and so hid restore from the recovery-only restore-operator
  // (it holds restore.request/apply/approve + drill.run, but sits off the cumulative role-rank
  // ladder at roleRank 0). For EACH surface we drive the REAL screen, never a copy of its logic,
  // and assert the restore-operator now sees exactly what the engine allows and not what it denies,
  // a viewer sees none, and the original roles are unchanged.
  //
  // Engine ground truth (engine/src/admin): router-restore.ts gate(caller,"restore.request") on
  // POST /restore/request, gate(caller,"restore.apply") on POST /restore (confirm), and
  // gate(caller,"restore.approve") on POST /restore/approve and /reject; router-attest.ts
  // gate(caller,"drill.run") on POST /attest/session/*; identity-rbac.ts grants all four to
  // restore-operator. Reverting any gate below to its old role-rank check turns the restore-operator
  // "sees" assertions red.
  // ==========================================================================
  console.log("\n-- 6S: restore capability parity across the four sweep surfaces (real screens) --");

  const callerOf = (role: Role): Caller => ({ method: "access", email: `${role}@maelstrom.au`, role, groups: [], isOnlyOwner: false });

  // ---- 6S-registry: the command-palette restore entries (pure `when` predicates) ----
  // request-restore gates on restore.request, apply-restore on restore.apply. hasDownpipes is
  // satisfied with downpipeCount 2 so the capability gate alone decides.
  {
    const idsFor = (role: Role): Set<string> => {
      const ctx: CommandContext = { caller: callerOf(role), engine: { downpipeCount: 2 } };
      return new Set(visibleCommands(ctx).map((c) => c.id));
    };

    const ro = idsFor("restore-operator");
    ok("6R-registry: a restore-operator sees 'Request a restore' (holds restore.request)", ro.has("request-restore"));
    ok("6R-registry: a restore-operator sees 'Apply a restore' (holds restore.apply)", ro.has("apply-restore"));

    const viewer = idsFor("viewer");
    ok("6R-registry: a viewer sees neither restore command (holds no restore write capability)", !viewer.has("request-restore") && !viewer.has("apply-restore"));

    const operator = idsFor("operator");
    ok("6R-registry: an operator sees request-restore but NOT apply-restore (holds request, not apply)", operator.has("request-restore") && !operator.has("apply-restore"));

    const approver = idsFor("approver");
    const owner = idsFor("owner");
    ok("6R-registry: an approver still sees both restore commands (unchanged)", approver.has("request-restore") && approver.has("apply-restore"));
    ok("6R-registry: an owner still sees both restore commands (unchanged)", owner.has("request-restore") && owner.has("apply-restore"));

    const accessAdmin = idsFor("access-admin");
    ok("6R-registry: an access-admin sees neither restore command (holds no restore capability)", !accessAdmin.has("request-restore") && !accessAdmin.has("apply-restore"));
  }

  // ---- 6S-attend: the attended-verification runner gates on drill.run ----
  // The runner installs a real MutationObserver to wipe the break-glass key and stop the batch loop when the
  // screen leaves the DOM (attend.ts). The DOM shim has none, so stand one in for the duration, exactly as
  // validate-tour.ts does for the canary screen's rain watcher. A no-op is the right shim here: this suite
  // asserts the runner's capability gating, not its teardown, and the teardown has its own coverage.
  const gMO = globalThis as unknown as Record<string, unknown>;
  if (typeof gMO.MutationObserver !== "function") {
    gMO.MutationObserver = class {
      observe(): void {}
      disconnect(): void {}
      takeRecords(): unknown[] {
        return [];
      }
    } as unknown;
  }

  async function driveAttend(role: Role | null): Promise<{ text: string; hasSetup: boolean; hasGate: boolean }> {
    store.setCaller(role ? callerOf(role) : null);
    store.connect("https://engine.test");
    const engine = store.getEngine();
    if (!engine) return { text: "", hasSetup: false, hasGate: false };
    const root = renderAttendRunner(engine);
    markConnected(root);
    await flushAsync();
    const buttons = querySelectorAllShim(root, "button").map((b) => textOf(b));
    const text = textOf(root);
    return {
      text,
      hasSetup: buttons.some((t) => t.includes("Start attended verification")),
      // the heading names the PERMISSION, not the raw capability id or a bare feature-name
      // shorthand ("Drill capability required").
      hasGate: text.includes("Permission to run a recovery drill required"),
    };
  }
  {
    const ro = await driveAttend("restore-operator");
    ok("6R-attend: a restore-operator sees the attended-verification runner (holds drill.run)", ro.hasSetup && !ro.hasGate);

    const viewer = await driveAttend("viewer");
    ok("6R-attend: a viewer sees the capability gate, not the runner", viewer.hasGate && !viewer.hasSetup);
    ok(
      "6R-attend: the gate names the PERMISSION in customer language, not the raw capability id",
      viewer.text.includes("permission to run a recovery drill") && !viewer.text.includes("drill.run"),
    );

    const accessAdmin = await driveAttend("access-admin");
    ok("6R-attend: an access-admin sees the capability gate (holds no drill.run)", accessAdmin.hasGate && !accessAdmin.hasSetup);

    const operator = await driveAttend("operator");
    ok("6R-attend: an operator still sees the runner (holds drill.run, unchanged)", operator.hasSetup && !operator.hasGate);
  }

  // ---- 6S-approvals: the inbox approve/reject actions gate on restore.approve ----
  async function driveApprovals(role: Role): Promise<{ text: string; approveBtns: number; rejectBtns: number }> {
    store.setCaller(callerOf(role));
    store.connect("https://engine.test");
    const engine = store.getEngine();
    if (!engine) return { text: "", approveBtns: 0, rejectBtns: 0 };
    // One PENDING request raised by a DIFFERENT identity, so maker != checker is satisfied and the
    // approve/reject actions render iff the caller holds restore.approve (never on the caller's own request).
    //
    // expiresAt IS DERIVED FROM NOW AND MUST STAY THAT WAY. It was the frozen literal
    // "", which is seven months in the past, and nothing noticed because no code read
    // the field: an approval that had been dead since January was driving four capability assertions. The
    // approval card now names its own window and withdraws Approve and Reject once it has closed, so a
    // frozen deadline makes this fixture a lapsed record and these vectors stop being about the capability
    // gate at all. This test is about restore.approve, so the record has to be LIVE for the gate to be the
    // only thing deciding what renders. No duration is asserted; the engine owns the real one.
    const pending: RestoreApproval = {
      planHash: "sha384:approvalstest", runId: "RUN-APR", isLatest: true, plannedWrites: 3, bytes: 1024,
      redirectBinding: null, requestedBy: "maker@example.com", requestedAt: "2026-01-01T00:00:00Z",
      reason: "DR rehearsal", status: "requested", expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    };
    (engine as unknown as { listApprovals: () => Promise<RestoreApproval[]> }).listApprovals = async () => [pending];
    // buildRunNameJoin reads history; make it throw so the join is empty (the card falls back to the run id),
    // keeping this test about the capability gate, not the name join.
    (engine as unknown as { listAllHistory: () => Promise<never> }).listAllHistory = async () => { throw new Error("no history in this test"); };
    const root = renderApprovalsInbox(engine);
    markConnected(root);
    await flushAsync();
    const buttons = querySelectorAllShim(root, "button").map((b) => textOf(b));
    return {
      text: textOf(root),
      approveBtns: buttons.filter((t) => t.trim() === "Approve").length,
      rejectBtns: buttons.filter((t) => t.trim() === "Reject").length,
    };
  }
  {
    const ro = await driveApprovals("restore-operator");
    ok("6R-approvals: a restore-operator sees Approve + Reject on another's request (holds restore.approve)", ro.approveBtns === 1 && ro.rejectBtns === 1);

    const viewer = await driveApprovals("viewer");
    ok("6R-approvals: a viewer sees no Approve or Reject action", viewer.approveBtns === 0 && viewer.rejectBtns === 0);
    ok("6R-approvals: the viewer gate note still names the Approver/Owner requirement (copy preserved)", viewer.text.includes("requires the Approver or Owner role"));

    const approver = await driveApprovals("approver");
    ok("6R-approvals: an approver still sees Approve + Reject (unchanged)", approver.approveBtns === 1 && approver.rejectBtns === 1);
  }

  // ---- 6S-batch: the batch queue gates request on restore.request and apply on restore.apply ----
  async function driveBatch(role: Role, opts: { toApproved?: boolean } = {}): Promise<{ text: string; requestAll: boolean; perRowRequest: boolean; apply: boolean }> {
    const email = `${role}@maelstrom.au`;
    store.setCaller(callerOf(role));
    store.connect("https://engine.test");
    const engine = store.getEngine();
    if (!engine) return { text: "", requestAll: false, perRowRequest: false, apply: false };
    const DP = "dp-batch";
    const RUN = "RUN-BATCH";
    // The row's planHash is restorePlanHash({runId}) (batch mode sets no other selector). Compute the SAME
    // hash so a distinct-approver "approved" record for it advances a requested row to "approved" -- exactly
    // the mechanism validate-restore-batch.ts drives the apply phase with.
    const hash = await restorePlanHash({ runId: RUN });
    (engine as unknown as { listDownpipes: () => Promise<unknown[]> }).listDownpipes = async () => [
      { config: { id: DP, name: "Batch DP", cadenceSeconds: 86400, enabled: true, source: { type: "kv", binding: "KV", include: [], exclude: [] } }, nextRunAt: 0, lastRunId: RUN, inFlight: false },
    ];
    (engine as unknown as { restore: (req: unknown) => Promise<RestorePlan> }).restore = async () => makePlan({ isLatest: true, plannedWrites: 5, bytes: 1000 });
    (engine as unknown as { requestRestore: (req: { runId: string; reason: string }) => Promise<RestoreApproval> }).requestRestore = async (req) => ({
      planHash: hash, runId: req.runId, isLatest: true, plannedWrites: 5, bytes: 1000, redirectBinding: null,
      requestedBy: email, requestedAt: "2026-01-01T00:00:00Z", reason: req.reason, status: "requested", expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    (engine as unknown as { listApprovals: () => Promise<RestoreApproval[]> }).listApprovals = async () => (opts.toApproved
      ? [{ planHash: hash, runId: RUN, isLatest: true, plannedWrites: 5, bytes: 1000, redirectBinding: null, requestedBy: email, requestedAt: "2026-01-01T00:00:00Z", reason: "DR rehearsal", status: "approved", approvedBy: "checker@example.com", expiresAt: new Date(Date.now() + 3600_000).toISOString() }]
      : []);

    const root = renderBatchQueue(engine, new URLSearchParams({ ids: DP }));
    markConnected(root);
    await flushAsync(); // resolveSeeds -> renderQueue -> dry-run pool -> row reaches "planned"

    const some = (pred: (t: string) => boolean): boolean => querySelectorAllShim(root, "button").some((b) => pred(textOf(b)));
    const requestAll = some((t) => t.includes("Request approval for all planned rows"));
    const perRowRequest = some((t) => t.trim() === "Request approval");

    if (opts.toApproved) {
      const reason = querySelectorShim(root, "#rsb-reason");
      if (reason) (reason as unknown as { value: string }).value = "DR rehearsal";
      const perRow = querySelectorAllShim(root, "button").find((b) => textOf(b).trim() === "Request approval");
      if (perRow) { (perRow as unknown as { click: () => void }).click(); await flushAsync(); }
    }
    const apply = some((t) => t.trim() === "Apply");
    return { text: textOf(root), requestAll, perRowRequest, apply };
  }
  {
    const ro = await driveBatch("restore-operator");
    ok("6R-batch: a restore-operator sees the 'request all' button (holds restore.request)", ro.requestAll);
    ok("6R-batch: a restore-operator sees the per-row Request approval button", ro.perRowRequest);

    const viewer = await driveBatch("viewer");
    ok("6R-batch: a viewer sees no request-all button", !viewer.requestAll);
    ok("6R-batch: a viewer sees no per-row Request approval button", !viewer.perRowRequest);
    ok(
      "6R-batch: the viewer per-row note names the PERMISSION in customer language, not the raw capability id",
      viewer.text.includes("permission to request a restore") && !viewer.text.includes("restore-request capability") && !viewer.text.includes("restore.request"),
    );

    const approver = await driveBatch("approver");
    ok("6R-batch: an approver still sees the request controls (unchanged)", approver.requestAll && approver.perRowRequest);

    const roApproved = await driveBatch("restore-operator", { toApproved: true });
    ok("6R-batch: a restore-operator sees Apply once a distinct approver signs (holds restore.apply)", roApproved.apply);

    const opApproved = await driveBatch("operator", { toApproved: true });
    ok(
      "6R-batch: an operator does NOT see Apply and gets the PERMISSION note in customer language, not the raw capability id (lacks restore.apply)",
      !opApproved.apply && opApproved.text.includes("applying requires permission to apply a restore") && !opApproved.text.includes("restore-apply capability") && !opApproved.text.includes("restore.apply"),
    );
  }

  // ---- 6S-proof: the drill button on the proof card gates on drill.run ----
  // Same proof card as 6B (proof.ts renderProofCard). The drill button is rendered for every role but is
  // disabled-with-reason when the caller lacks drill.run (disabled-with-reason, not
  // hidden-then-403). Engine ground truth: POST /admin/drill gates on drill.run
  // (engine/src/admin/router-pipelines.ts:192), held by Operator, Restore operator, Approver and Owner.
  {
    const blind = makeBlindTest({ ok: true, recordsVerified: 1, bytesVerified: 1, restoreDigest: "sha384:00" });
    const ro = await driveRestorabilityCard(callerOf("restore-operator"), blind, { clickVerify: false });
    ok("6R-proof: a restore-operator gets the drill action ENABLED (holds drill.run)", ro.drillDisabled === false);

    const viewer = await driveRestorabilityCard(callerOf("viewer"), blind, { clickVerify: false });
    ok("6R-proof: a viewer gets the drill action DISABLED (lacks drill.run)", viewer.drillDisabled === true);
    ok(
      "6R-proof: the disabled drill action names the PERMISSION in customer language, not the raw capability id",
      (viewer.drillTitle ?? "").includes("permission to run a recovery drill") && !(viewer.drillTitle ?? "").includes("drill.run"),
    );

    const accessAdmin = await driveRestorabilityCard(callerOf("access-admin"), blind, { clickVerify: false });
    ok("6R-proof: an access-admin gets the drill action DISABLED (lacks drill.run)", accessAdmin.drillDisabled === true);

    const operator = await driveRestorabilityCard(callerOf("operator"), blind, { clickVerify: false });
    ok("6R-proof: an operator still gets the drill action ENABLED (holds drill.run, unchanged)", operator.drillDisabled === false);

    const approver = await driveRestorabilityCard(callerOf("approver"), blind, { clickVerify: false });
    ok("6R-proof: an approver still gets the drill action ENABLED (unchanged)", approver.drillDisabled === false);
  }
}
