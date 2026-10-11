// The SAML connection form stays SP-initiated: it offers no IdP-initiated switch, and the proposal it builds
// always carries allowIdpInitiated false.
//
// The engine accepts an allowIdpInitiated flag, but its assertion consumer refuses any POST that has no
// server-minted RelayState, so only a service-provider-initiated request can sign anyone in. A switch for the
// flag would do nothing, so the form does not offer one and sends the flag off every time.
//
// (i) walks every node the form renders and fails on any control (input, select, textarea, button, label, or a
// checkbox/switch role) whose id, name, data-dp key, aria-label or text names the flag or IdP-initiated sign-in.
// (ii) submits the form under both email-trust policies and reads the proposal the client receives.
//
// Run with: node test/validate-saml-form-no-idp-initiated.ts

import type { EngineClient } from "../src/api.ts";
import { samlForm } from "../src/screens/idp-connections/saml-form.ts";
import { installDomShim, markConnected, qs, qsa, type ShimNode, textOf } from "./dom-shim.ts";
import { makeEvent } from "./dom-shim-core.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

installDomShim();

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const NAMES_THE_FLAG = /idp[-_ ]?initiated|allow[-_ ]?idp/i;
const CONTROL_TAGS = new Set(["INPUT", "SELECT", "TEXTAREA", "BUTTON", "LABEL", "OPTION"]);

function walk(node: ShimNode, visit: (n: ShimNode) => void): void {
  visit(node);
  for (const c of node.childNodes) walk(c, visit);
}

// offendingControls lists every control in the tree that names the flag, as "<TAG> <why>" strings.
function offendingControls(root: ShimNode): string[] {
  const out: string[] = [];
  walk(root, (n) => {
    if (n.nodeType !== 1) return;
    const role = n.getAttribute("role") ?? "";
    const isControl = CONTROL_TAGS.has(n.tagName) || role === "switch" || role === "checkbox" || role === "radio";
    if (!isControl) return;
    const haystack = [n.getAttribute("id"), n.getAttribute("name"), n.getAttribute("data-dp"), n.getAttribute("aria-label"), n.getAttribute("value"), textOf(n)]
      .filter((s): s is string => typeof s === "string")
      .join(" | ");
    if (NAMES_THE_FLAG.test(haystack)) out.push(`${n.tagName} ${haystack.slice(0, 80)}`);
  });
  return out;
}

interface Captured { allowIdpInitiated?: unknown; emailVerifiedPolicy?: string }
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
function fillRequired(root: unknown): void {
  setValue(root, "#saml-label", "Test SAML");
  setValue(root, "#saml-idp-entity", "https://idp.example.com/metadata");
  setValue(root, "#saml-idp-sso", "https://idp.example.com/sso");
  setValue(root, "#saml-sp-entity", "https://console.test/saml");
  setValue(root, "#saml-certs", "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----");
}
function choosePolicy(root: unknown, v: "trust-idp" | "require-flag"): void {
  const sel = qs(root, "#saml-email-policy") as unknown as (ShimNode & { value: string }) | null;
  if (!sel) return;
  sel.value = v;
  sel.dispatchEvent(makeEvent({ type: "change", bubbles: true, cancelable: true }));
}
function clickAdd(root: unknown): void {
  const b = qsa(root, "button").find((n) => textOf(n).trim() === "Add SAML provider") as unknown as { click?: () => void } | undefined;
  b?.click?.();
}

async function main(): Promise<void> {
  console.log("-- saml-form: no IdP-initiated control --");
  {
    const wrap = samlForm(engineCapturing({ proposal: null }), () => {}) as unknown as ShimNode;
    markConnected(wrap);
    const controls = qsa(wrap, "input, select, textarea, button");
    ok("the walk sees the form's real controls (the check can find something)", controls.length >= 8);
    ok("no input, select, textarea, button, label or switch names allowIdpInitiated or IdP-initiated sign-in", offendingControls(wrap).length === 0);
    for (const bad of offendingControls(wrap)) console.log(`    offending: ${bad}`);
    ok("the walk does flag a control that names the flag (negative control)", (() => {
      const probe = samlForm(engineCapturing({ proposal: null }), () => {}) as unknown as ShimNode;
      const box = (globalThis as unknown as { document: { createElement: (t: string) => ShimNode } }).document.createElement("input");
      box.setAttribute("type", "checkbox");
      box.setAttribute("id", "saml-allow-idp-initiated");
      probe.appendChild(box);
      return offendingControls(probe).length >= 1;
    })());
  }

  console.log("\n-- saml-form: the proposal always sends allowIdpInitiated false --");
  for (const policy of ["trust-idp", "require-flag"] as const) {
    const sink = { proposal: null as Captured | null };
    const wrap = samlForm(engineCapturing(sink), () => {}) as unknown as ShimNode;
    markConnected(wrap);
    choosePolicy(wrap, policy);
    fillRequired(wrap);
    if (policy === "require-flag") setValue(wrap, "#saml-email-verified-attr", "email_verified");
    clickAdd(wrap);
    await tick();
    ok(`a ${policy} proposal is sent`, sink.proposal !== null && sink.proposal.emailVerifiedPolicy === policy);
    ok(`a ${policy} proposal carries allowIdpInitiated === false`, sink.proposal !== null && sink.proposal.allowIdpInitiated === false);
  }

  console.log(failures === 0 ? "\nSAML-FORM-NO-IDP-INITIATED PASS" : `\n${failures} FAILURE(S)`);
  verdictReached(failures);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("\nVALIDATE-SAML-FORM-NO-IDP-INITIATED THREW:", err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
