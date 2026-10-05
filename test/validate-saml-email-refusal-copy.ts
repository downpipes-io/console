// The SAML connection form's email-attribute and email-trust copy. A SAML session mints only for a
// principal with a usable email. A blank Email attribute, or require-flag with no Email verified attribute,
// gives no email, so every SAML sign-in is refused. This pins the copy that states the refusals plainly,
// rather than promising a subject-only sign-in the engine no longer grants.
//
// Run with: node test/validate-saml-email-refusal-copy.ts

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

function fakeEngine(): EngineClient {
  return {
    samlAcsUrl: (connId: string) => `https://console.test/admin/saml/acs/${connId}`,
    getConfigApprovalPolicy: async () => ({ requireConfigApproval: false, requireChangeNumber: false }),
  } as unknown as EngineClient;
}

async function main(): Promise<void> {
  console.log("-- saml-form: the Email attribute hint states a blank value refuses the sign-in --");
  {
    const wrap = samlForm(fakeEngine(), () => {}) as unknown as ShimNode;
    markConnected(wrap);
    const text = textOf(wrap);
    ok("states a blank Email attribute refuses every SAML sign-in", text.includes("Blank: no email is read, and every SAML sign-in is refused."));
    ok("does not promise a subject-only sign-in", !text.includes("subject-only"));
  }

  console.log("\n-- saml-form: the Email trust hint says what each policy trusts --");
  {
    const wrap = samlForm(fakeEngine(), () => {}) as unknown as ShimNode;
    markConnected(wrap);
    const text = textOf(wrap);
    ok(
      "states that trust-idp uses the email the signed assertion carries",
      text.includes("trust-idp uses the email the signed assertion carries."),
    );
    ok(
      "states that require-flag uses it only when the IdP marks it verified",
      text.includes("require-flag uses it only when the IdP marks it verified."),
    );
  }

  console.log("\n-- saml-form: the require-flag option does not call itself recommended --");
  {
    const wrap = samlForm(fakeEngine(), () => {}) as unknown as ShimNode;
    markConnected(wrap);
    const policySelect = qs(wrap, "#saml-email-policy") as unknown as ShimNode | null;
    ok("the Email trust select renders", policySelect !== null);
    const optionLabels = policySelect === null ? [] : qsa(policySelect, "option").map((o) => textOf(o));
    ok("require-flag admits nobody without its attribute, so its option is not called recommended", optionLabels.some((t) => t.startsWith("require-flag")) && !optionLabels.some((t) => t.startsWith("require-flag") && t.includes("recommended")));
  }

  console.log("\n-- saml-form: the require-flag note states a missing attribute refuses the sign-in --");
  {
    const wrap = samlForm(fakeEngine(), () => {}) as unknown as ShimNode;
    markConnected(wrap);
    const policySelect = qs(wrap, "#saml-email-policy") as unknown as ShimNode & { value: string } | null;
    ok("the Email trust select renders", policySelect !== null);
    if (policySelect) {
      policySelect.value = "require-flag";
      policySelect.dispatchEvent(makeEvent({ type: "change", bubbles: true, cancelable: true }));
    }
    const text = textOf(wrap);
    ok(
      "a missing verified attribute is described as refusing every sign-in, never a subject-only sign-in",
      text.includes("Without it every sign-in is refused.") && !text.includes("subject-only"),
    );
  }

  console.log(failures === 0 ? "\nSAML-EMAIL-REFUSAL-COPY PASS" : `\n${failures} FAILURE(S)`);
  verdictReached(failures);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("\nVALIDATE-SAML-EMAIL-REFUSAL-COPY THREW:", err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
