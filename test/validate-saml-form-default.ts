// The SAML form's email-trust default and the require-flag attribute field.
//
// The engine binds an emailed invite on a trust-idp connection only for Viewer, Operator, or a custom role
// with no people, access or approval permission; Owner, Access admin, Approver and Restore operator bind
// only through a require-flag connection whose verified-email attribute reads "true" or "1". The engine
// also refuses to save a require-flag connection with no emailVerifiedAttr. So the form defaults to
// trust-idp, offers the attribute field when require-flag is chosen, blocks submit without it, and says
// which roles an emailed invite can receive under each policy. The connection list shows trust-idp with a
// neutral badge and warns on a require-flag connection with no attribute, because that connection admits
// nobody.
//
// Run with: node test/validate-saml-form-default.ts

import type { EngineClient } from "../src/api.ts";
import { samlForm } from "../src/screens/idp-connections/saml-form.ts";
import { installDomShim, markConnected, qs, qsa, type ShimNode, textOf } from "./dom-shim.ts";
import { makeEvent } from "./dom-shim-core.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

installDomShim();

const { renderConnections } = await import("../src/screens/idp-connections/list.ts");

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

interface Captured { emailVerifiedPolicy?: string; emailVerifiedAttr?: string }
function engineCapturing(sink: { proposal: Captured | null }): EngineClient {
  return {
    samlAcsUrl: (connId: string) => `https://console.test/admin/saml/acs/${connId}`,
    getConfigApprovalPolicy: async () => ({ requireConfigApproval: false, requireChangeNumber: false }),
    createIdpConnection: async (payload: Captured) => {
      sink.proposal = payload;
      return { status: "result", value: { ok: true, conn: {} } };
    },
  } as unknown as EngineClient;
}
function setValue(root: unknown, sel: string, v: string): void {
  const n = qs(root, sel) as unknown as { value: string } | null;
  if (n) n.value = v;
}
function choosePolicy(root: unknown, v: "trust-idp" | "require-flag"): void {
  const sel = qs(root, "#saml-email-policy") as unknown as (ShimNode & { value: string }) | null;
  if (!sel) return;
  sel.value = v;
  sel.dispatchEvent(makeEvent({ type: "change", bubbles: true, cancelable: true }));
}
function fillRequired(root: unknown): void {
  setValue(root, "#saml-label", "Test SAML");
  setValue(root, "#saml-idp-entity", "https://idp.example.com/metadata");
  setValue(root, "#saml-idp-sso", "https://idp.example.com/sso");
  setValue(root, "#saml-sp-entity", "https://console.test/saml");
  setValue(root, "#saml-certs", "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----");
}
function clickAdd(root: unknown): void {
  const b = qsa(root, "button").find((n) => textOf(n).trim() === "Add SAML provider") as unknown as { click?: () => void } | undefined;
  b?.click?.();
}
// shown: the node exists and neither it nor any ancestor is hidden.
function shown(node: unknown): boolean {
  let n = node as { hidden?: boolean; parentNode?: unknown } | null;
  if (n === null) return false;
  while (n) {
    if (n.hidden === true) return false;
    n = (n.parentNode ?? null) as { hidden?: boolean; parentNode?: unknown } | null;
  }
  return true;
}

const TRUST_NOTE = "An invite on this connection binds only a Viewer or Operator role, or a custom role with no people, access or approval permission.";
const TRUST_NOTE_PRIV = "Access admin, Approver and Restore operator need a group mapping, a connection that verifies the email, a passkey or Cloudflare Access. Owner needs one of the last three, because a group cannot confer Owner.";
const FLAG_NOTE = 'An emailed invite binds any role, Owner included, when the attribute below reads "true" or "1".';
const AUDITED = "This choice is recorded in the audit log.";

async function main(): Promise<void> {
  console.log("-- saml-form: trust-idp is the default --");
  {
    const sink = { proposal: null as Captured | null };
    const wrap = samlForm(engineCapturing(sink), () => {}) as unknown as ShimNode;
    markConnected(wrap);
    const sel = qs(wrap, "#saml-email-policy") as unknown as { value: string } | null;
    ok("the Email trust picker renders with trust-idp selected", sel !== null && sel.value === "trust-idp");
    const labels = sel === null ? [] : qsa(sel, "option").map((o) => textOf(o));
    ok("the trust-idp option is the one marked recommended", labels.some((t) => t.startsWith("trust-idp") && t.includes("recommended")) && !labels.some((t) => t.startsWith("require-flag") && t.includes("recommended")));
    const text = textOf(wrap);
    ok("the default note says which roles an emailed invite can receive", text.includes(TRUST_NOTE));
    ok("the default note names the privileged roles and the routes they need", text.includes(TRUST_NOTE_PRIV));
    const note = qs(wrap, "#saml-email-policy-note");
    ok("the default note says the choice is audited", note !== null && shown(note) && textOf(note).includes(AUDITED));
    ok("the require-flag attribute field is not shown under trust-idp", !shown(qs(wrap, "#saml-email-verified-attr")));
    fillRequired(wrap);
    clickAdd(wrap);
    await tick();
    ok("the built proposal carries emailVerifiedPolicy trust-idp", sink.proposal?.emailVerifiedPolicy === "trust-idp");
    ok("a trust-idp proposal carries no emailVerifiedAttr", sink.proposal !== null && sink.proposal.emailVerifiedAttr === undefined);
  }

  console.log("\n-- saml-form: require-flag shows and needs the Email verified attribute --");
  {
    const sink = { proposal: null as Captured | null };
    const wrap = samlForm(engineCapturing(sink), () => {}) as unknown as ShimNode;
    markConnected(wrap);
    choosePolicy(wrap, "require-flag");
    ok("choosing require-flag shows the Email verified attribute field", shown(qs(wrap, "#saml-email-verified-attr")));
    const text = textOf(wrap);
    ok("the require-flag note says which roles an emailed invite can receive", text.includes(FLAG_NOTE));
    const note = qs(wrap, "#saml-email-policy-note");
    ok("the require-flag note says the choice is audited", note !== null && shown(note) && textOf(note).includes(AUDITED));
    ok("the trust-idp role note is gone under require-flag", !text.includes(TRUST_NOTE));
    fillRequired(wrap);
    clickAdd(wrap);
    await tick();
    ok("an empty Email verified attribute blocks submit (no proposal is sent)", sink.proposal === null);
    ok("the field shows why it blocked submit", textOf(wrap).includes("require-flag needs the attribute your IdP uses to mark the email verified."));
    setValue(wrap, "#saml-email-verified-attr", "email_verified");
    clickAdd(wrap);
    await tick();
    ok("a filled field sends emailVerifiedPolicy require-flag", sink.proposal?.emailVerifiedPolicy === "require-flag");
    ok("a filled field sends emailVerifiedAttr", sink.proposal?.emailVerifiedAttr === "email_verified");
  }

  console.log("\n-- saml-form: switching back to trust-idp hides the field again --");
  {
    const wrap = samlForm(engineCapturing({ proposal: null }), () => {}) as unknown as ShimNode;
    markConnected(wrap);
    choosePolicy(wrap, "require-flag");
    choosePolicy(wrap, "trust-idp");
    ok("the Email verified attribute field is hidden again", !shown(qs(wrap, "#saml-email-verified-attr")));
    ok("the trust-idp role note is back", textOf(wrap).includes(TRUST_NOTE));
  }

  console.log("\n-- list: the Email trust badge --");
  {
    const stub = {
      getConfigApprovalPolicy: () => Promise.resolve({ requireConfigApproval: false, requireChangeNumber: false }),
      samlMetadataUrl: (id: string) => `https://console.example/admin/idp/saml/${id}/metadata`,
      samlAcsUrl: (id: string) => `https://console.example/admin/idp/saml/${id}/acs`,
    } as never;
    const conn = (id: string, policy: string, attr?: string) => ({
      id, kind: "saml", label: id, enabled: false, presetId: "generic-saml", createdBy: "owner@example.com", createdAt: "2026-01-01T00:00:00.000Z",
      idpEntityId: "https://idp.example", idpSsoUrl: "https://idp.example/sso", idpSigningCerts: ["-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----"],
      spEntityId: "https://console.example/sp", nameIdFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress", wantAssertionsSigned: true,
      allowIdpInitiated: false, clockSkewSec: 120, emailVerifiedPolicy: policy, ...(attr !== undefined ? { emailVerifiedAttr: attr } : {}),
    });
    const badgeFor = (c: unknown): { cls: string; text: string } | null => {
      const root = renderConnections(stub, [c] as never, true, () => {});
      const b = qsa(root, "span").find((n) => String((n as unknown as { className?: string }).className ?? "").startsWith("badge") && /trust-idp|require-flag/.test(textOf(n)));
      return b ? { cls: String((b as unknown as { className: string }).className), text: textOf(b) } : null;
    };
    const t = badgeFor(conn("t", "trust-idp"));
    ok("trust-idp reads with a neutral badge, not a warning", t?.cls.includes("badge--neutral") === true && !t.cls.includes("warn"));
    const f = badgeFor(conn("f", "require-flag", "email_verified"));
    ok("require-flag with an attribute reads ok", f?.cls.includes("badge--ok") === true);
    const n = badgeFor(conn("n", "require-flag"));
    ok("require-flag with no attribute warns", n?.cls.includes("badge--warn") === true);
    ok("and the warning says it admits nobody", n?.text.includes("admits nobody") === true);
  }

  console.log(failures === 0 ? "\nSAML-FORM-DEFAULT PASS" : `\n${failures} FAILURE(S)`);
  verdictReached(failures);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("\nVALIDATE-SAML-FORM-DEFAULT THREW:", err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
