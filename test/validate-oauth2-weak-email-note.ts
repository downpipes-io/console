// The generic OAuth2 connection form's weak-email note. The engine trusts whatever address the provider
// returns when a connection names an Email field but no Email-verified field, and refuses to bind an
// emailed invite with a people, access, approval or Owner-reserved capability through it (Viewer and
// Operator still bind). The form shows a plain note for that case, tracks both fields live, and names the
// two remedies.
//
// Run with: node test/validate-oauth2-weak-email-note.ts

import type { EngineClient, IdpPreset } from "../src/api.ts";
import { presetForm } from "../src/screens/idp-connections/forms.ts";
import { installDomShim, markConnected, qs } from "./dom-shim.ts";
import { makeEvent } from "./dom-shim-core.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

installDomShim();

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

const engine = {
  getConfigApprovalPolicy: async () => ({ requireConfigApproval: false, requireChangeNumber: false }),
  idpRedirectUri: (connId: string) => `https://console.test/admin/oauth2/callback/${connId}`,
} as unknown as EngineClient;

const GENERIC_OAUTH2: IdpPreset = {
  id: "generic-oauth2",
  label: "Generic OAuth2",
  vendor: "Any OAuth2 provider",
  buttonLabel: "Sign in",
  kind: "oauth2",
  requiredVars: [
    { key: "authorizeUrl", label: "Authorization URL", example: "https://provider.example/oauth/authorize" },
    { key: "tokenUrl", label: "Token URL", example: "https://provider.example/oauth/token" },
    { key: "apiBase", label: "API base URL", example: "https://api.provider.example" },
    { key: "profileUrl", label: "User-info URL", example: "https://api.provider.example/user" },
    { key: "subjectPath", label: "Immutable user-id field", example: "id", default: "id" },
    { key: "emailPath", label: "Email field (optional)", example: "email", default: "" },
    { key: "emailVerifiedPath", label: "Email-verified field (optional)", example: "verified", default: "" },
  ],
  notes: [],
};

function setValue(root: unknown, sel: string, v: string): void {
  const n = qs(root, sel) as unknown as { value: string } | null;
  if (n === null) throw new Error(`setValue: no node for ${sel}`);
  n.value = v;
  (n as unknown as { dispatchEvent: (e: unknown) => void }).dispatchEvent(makeEvent({ type: "input", bubbles: true, cancelable: true }));
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

const NOTE_TEXT = "An invite on this connection binds only a Viewer or Operator role, or a custom role with no people, access or approval permission. Set the Email-verified field, or invite with one of those roles.";

function render(): ReturnType<typeof presetForm> {
  const wrap = presetForm(engine, GENERIC_OAUTH2, () => {});
  markConnected(wrap as unknown as Parameters<typeof markConnected>[0]);
  return wrap;
}

async function main(): Promise<void> {
  console.log("-- oauth2 form: no note while the Email field is blank --");
  {
    const wrap = render();
    const note = qs(wrap, "#idp-oauth2-weak-email-note");
    ok("the note is not shown with Email and Email-verified both blank", !shown(note));
  }

  console.log("\n-- oauth2 form: the note appears once Email is set and Email-verified stays blank --");
  {
    const wrap = render();
    setValue(wrap, "#idp-var-emailPath", "email");
    const note = qs(wrap, "#idp-oauth2-weak-email-note");
    ok("the note is shown", shown(note));
    ok("the note names the refusal and both remedies", note !== null && (note as unknown as { textContent: string }).textContent === NOTE_TEXT);
  }

  console.log("\n-- oauth2 form: filling Email-verified hides the note again --");
  {
    const wrap = render();
    setValue(wrap, "#idp-var-emailPath", "email");
    setValue(wrap, "#idp-var-emailVerifiedPath", "verified");
    const note = qs(wrap, "#idp-oauth2-weak-email-note");
    ok("the note is hidden once Email-verified is set", !shown(note));
  }

  console.log("\n-- oauth2 form: clearing Email-verified after filling it shows the note again --");
  {
    const wrap = render();
    setValue(wrap, "#idp-var-emailPath", "email");
    setValue(wrap, "#idp-var-emailVerifiedPath", "verified");
    setValue(wrap, "#idp-var-emailVerifiedPath", "");
    const note = qs(wrap, "#idp-oauth2-weak-email-note");
    ok("the note returns", shown(note));
  }

  console.log("\n-- oauth2 form: no Email field at all (an older preset) never adds the note --");
  {
    const preset: IdpPreset = { ...GENERIC_OAUTH2, requiredVars: GENERIC_OAUTH2.requiredVars.filter((v) => v.key !== "emailVerifiedPath") };
    const wrap = presetForm(engine, preset, () => {});
    markConnected(wrap as unknown as Parameters<typeof markConnected>[0]);
    ok("no note node exists when the preset carries no Email-verified field", qs(wrap, "#idp-oauth2-weak-email-note") === null);
  }

  console.log(failures === 0 ? "\nOAUTH2-WEAK-EMAIL-NOTE PASS" : `\n${failures} FAILURE(S)`);
  verdictReached(failures);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("\nVALIDATE-OAUTH2-WEAK-EMAIL-NOTE THREW:", err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
