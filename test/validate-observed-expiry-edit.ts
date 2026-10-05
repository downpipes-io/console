// The edit form of an auto-observed expiry item offers only what the engine lets the operator change.
//
//   node test/validate-observed-expiry-edit.ts
//
// The engine owns the kind, the expiry and the lifecycle class of an item it observed (an attach token,
// an IdP client secret, a SAML certificate, the licence), and each observation writes them again. From
// engine 0.3.7 it refuses an edit that asks to change one of them. The form showed the date read-only,
// but the No-expiry box and the lifecycle select stayed open, and the sync that runs when the form opens
// cleared the date's read-only reason too. So an operator could tick No expiry, see "Updated", and have
// the change dropped. This drives the REAL form under the DOM shim and grades what the operator can
// change and what the form sends.

import { installDomShim, qs, qsa, textOf, flushAsync, type ShimNode } from "./dom-shim.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

installDomShim();

const { openItemForm } = await import("../src/screens/credentials/forms.ts");

let failures = 0;
let checks = 0;
function ok(label: string, cond: boolean): void {
  checks++;
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

const doc = (globalThis as unknown as { document: { body: ShimNode } }).document;
const posted: Array<Record<string, unknown>> = [];
const engineStub = {
  upsertExpiryItem: async (input: Record<string, unknown>) => {
    posted.push(input);
    return { status: "ok" };
  },
} as never;

const refused = (root: ShimNode, id: string): boolean => qs(root, `#${id}`)?.getAttribute("aria-disabled") === "true";

async function save(root: ShimNode): Promise<void> {
  qsa(root, "button").find((b) => textOf(b).trim() === "Save changes")!.click();
  await flushAsync();
  await flushAsync();
}
async function close(root: ShimNode): Promise<void> {
  const cancel = qsa(root, "button").find((b) => textOf(b).trim() === "Cancel");
  if (cancel) cancel.click();
  await flushAsync();
}

// ---- 1. An observed, dated attach token -------------------------------------------------------
{
  posted.length = 0;
  openItemForm(engineStub, { id: "attach-token-abc", label: "Cloudflare attach token", kind: "token", expiresAt: "2026-10-15T08:12:00Z", daysRemaining: 20, state: "ok", source: "observed", lifecycleClass: "ephemeral", cleanupState: "pending" } as never, () => {});
  const root = doc.body;
  // THE ASSERTIONS THAT FAIL BEFORE THE FIX.
  ok("(1a) the date stays read-only after the form opens", refused(root, "expiry-date"));
  ok("(1b) the No-expiry box is read-only on an observed item", refused(root, "expiry-noexpiry"));
  ok("(1c) the box gives the auto-observed reason", textOf(root).includes("Auto-observed from the credential, the engine tracks the expiry."));
  ok("(1d) the lifecycle select is read-only on an observed item", refused(root, "expiry-lifecycle") && textOf(root).includes("Auto-observed, the engine sets the lifecycle."));
  // The fields the operator owns stay open.
  ok("(1e) the purpose stays editable", !refused(root, "expiry-purpose"));
  ok("(1f) the note stays editable", !refused(root, "expiry-note"));
  // What the form sends is the engine's own values back, which the engine accepts as unchanged.
  await save(root);
  const body = posted[0];
  ok("(1g) the save sends the stored expiry day, not No expiry", posted.length === 1 && body?.noExpiry === undefined && String(body?.expiresAt).startsWith("2026-10-15"));
  ok("(1h) the save sends the stored kind and lifecycle class", body?.kind === "token" && body?.lifecycleClass === "ephemeral");
  await close(root);
}

// ---- 2. An observed item with no expiry (an IdP client secret that does not expire) -----------
{
  posted.length = 0;
  openItemForm(engineStub, { id: "idp-secret-okta", label: "IdP client secret, Okta", kind: "credential", state: "no-expiry", source: "observed", lifecycleClass: "functional" } as never, () => {});
  const root = doc.body;
  ok("(2a) the No-expiry box keeps the stored tick and is read-only", qs(root, "#expiry-noexpiry")!.checked === true && refused(root, "expiry-noexpiry"));
  await save(root);
  ok("(2b) the save sends No expiry back", posted.length === 1 && posted[0]?.noExpiry === true && posted[0]?.expiresAt === undefined);
  await close(root);
}

// ---- 3. The control: a manual item keeps every field open --------------------------------------
{
  openItemForm(engineStub, { id: "manual-key", label: "API key", kind: "credential", expiresAt: "2026-12-01T23:59:59Z", daysRemaining: 60, state: "ok", source: "manual", lifecycleClass: "functional" } as never, () => {});
  const root = doc.body;
  ok("(3a) a manual item's date, No-expiry box and lifecycle stay editable", !refused(root, "expiry-date") && !refused(root, "expiry-noexpiry") && !refused(root, "expiry-lifecycle"));
  await close(root);
}

verdictReached(failures, checks); // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
console.log(failures === 0 ? "\nobserved expiry edit: PASS" : `\nobserved expiry edit: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
