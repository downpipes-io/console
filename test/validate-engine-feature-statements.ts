// Checks what the recovery sheet, the SAML email-trust hint, the restore keep-existing hint and the
// offline recovery panel say about the recovery bundle, the audit record and keepExisting.
//
// Run: node test/validate-engine-feature-statements.ts

import { installDomShim, qs, textOf } from "./dom-shim.ts";
installDomShim();
const { makeEvent } = await import("./dom-shim-core.ts");

import type { EngineClient, RestorePlan, RestoreRequest } from "../src/api.ts";
import type { CeremonyResult, KeyMaterial } from "../src/keygen.ts";
import { installNav } from "../src/lib/nav.ts";
import { recoverySheet, recoverySheetHTML, type SheetParams } from "../src/recovery-sheet.ts";
import { samlForm } from "../src/screens/idp-connections/saml-form.ts";
import { SAML_GUIDE } from "../src/screens/idp-guides.ts";
import { renderOfflineRecovery } from "../src/screens/keys/offline-recovery.ts";
import { renderRestoreFlow } from "../src/screens/restore-flow/flow.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

installNav({ navigate: () => {}, onUnauthorised: () => {}, refreshIdentity: async () => {}, onAuthenticated: async () => {}, signOut: () => {} });

let failures = 0;
let checks = 0;
function ok(label: string, cond: boolean): void {
  checks++;
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

console.log("\nENGINE FEATURE STATEMENTS\n");

console.log("1. the recovery sheet: the bundle carries the copy, absent only when no run has written it");
{
  const sheetParams: SheetParams = { downpipeAccount: "acct-test", createdAt: "2026-08-04", posture: "break-glass-only" };
  const material = (fingerprint: string): KeyMaterial => ({ identityB64: "aaaa", recipientPublicB64: "bbbb", fingerprint });
  const ceremony: CeremonyResult = {
    breakGlass: material("bg-fp-0001"),
    operational: null,
    signer: { privateB64: "cccc", publicB64: "dddd", fingerprint: "sg-fp-0001" },
    configRecipient: material("cfg-fp-0001"),
    configWrapKeyB64: "eeee",
  };
  const sheetText = recoverySheet(ceremony, sheetParams);
  const sheetHtml = recoverySheetHTML(ceremony, sheetParams);
  const sheetTextUnwrapped = sheetText.replace(/\n/g, " ");
  ok("the text sheet says the bundle carries the copy", sheetTextUnwrapped.includes("The recovery bundle in the bucket carries a copy of the current signer's"));
  ok("the text sheet says a bucket with no run yet has no copy", sheetTextUnwrapped.includes("no run has written to the bucket yet"));
  ok("the HTML sheet says the bundle carries the copy", sheetHtml.includes("The recovery bundle in the bucket carries a copy of the current signer's"));
  ok("the HTML sheet says a bucket with no run yet has no copy", sheetHtml.includes("no run has written to the bucket yet"));
}

console.log("\n2. the SAML setup guide and the live email-trust warning say the choice is audited");
{
  ok(
    "the setup guide's gotchas say the choice is recorded in the audit log",
    (SAML_GUIDE.gotchas ?? []).some((g) => g.includes("This choice is recorded in the audit log.")),
  );

  const engine = {
    samlAcsUrl: (connId: string) => `https://console.test/admin/saml/acs/${connId}`,
    getConfigApprovalPolicy: async () => ({ requireConfigApproval: false, requireChangeNumber: false }),
    createIdpConnection: async () => ({ status: "result", value: { ok: true, conn: {} } }),
  } as unknown as EngineClient;
  const wrap = samlForm(engine, () => {});
  const policySelect = qs(wrap, "#saml-email-policy") as unknown as { value: string; dispatchEvent: (e: ReturnType<typeof makeEvent>) => void } | null;
  ok("the SAML form renders the email-trust picker", policySelect !== null);
  if (policySelect !== null) {
    policySelect.value = "trust-idp";
    policySelect.dispatchEvent(makeEvent({ type: "change" }));
  }
  ok("choosing trust-idp shows the warning saying the choice is audited", textOf(wrap).includes("This choice is recorded in the audit log."));
}

console.log("\n3. the restore flow's keep-existing hint");
{
  const engine = {
    restore: async (_req: RestoreRequest) =>
      ({ ok: true, runId: "01J8Z3K9QW7B2RTESTRUNAAAA", mode: "dry-run", recordsVerified: 0, isLatest: true, plannedWrites: 0, bytes: 0, sample: [], skipped: [] }) as unknown as RestorePlan,
    listApprovals: async () => [],
    getConfigApprovalPolicy: async () => ({ requireRestoreApproval: false, requireChangeNumber: false }),
    getRunHistory: async () => [],
    listAllHistory: async () => ({ byDownpipe: {} }),
    listDownpipes: async () => [],
  } as unknown as EngineClient;
  const flow = renderRestoreFlow(engine, "01J8Z3K9QW7B2RTESTRUNAAAA", undefined, () => {});
  const hint = qs(flow, "label[for='rs-keep-existing'] .field__hint");
  ok("the flow renders the keep-existing hint", hint !== null);
  ok(
    "the hint states only the present behaviour",
    hint !== null && textOf(hint) === "An apply leaves a KV key or R2 object that exists in the target as it is. Otherwise it replaces it with the archived value.",
  );
}

console.log("\n4. the offline recovery panel: the fingerprint route and the no-copy case");
{
  const panelText = textOf(renderOfflineRecovery());
  ok("the panel names the fingerprint route by the reader release", panelText.includes("(from reader 0.3.4)"));
  ok("the panel says a bucket with no run yet has no copy", panelText.includes("A bucket with no run written to it yet has no copy"));
}

console.log(failures === 0 ? "\nENGINE FEATURE STATEMENTS PASS" : `\nENGINE FEATURE STATEMENTS: ${failures} FAILED`);
verdictReached(failures, checks);
process.exit(failures === 0 ? 0 : 1);
