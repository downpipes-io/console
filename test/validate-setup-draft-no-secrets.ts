// Validate that the stored setup draft (sessionStorage DRAFT_PREFIX family, and its localStorage
// first-backup copy) never holds a token or key material.
//
// SetupDraft (lib/setup-flow/types.ts) is declared non-secret only: a deploy token is taken as an
// action argument and never assigned into the draft, and a generated key's identity/private/recipient
// material lives in the in-memory ceremony (lib/store.ts setCeremony), never in the draft the model
// persists. This drives the real setup flow over the demo engine with a real token and a real
// in-browser key ceremony, then inspects exactly what model.ts wrote to storage.
//
// Run with `node test/validate-setup-draft-no-secrets.ts`.

import { installDomShim } from "./dom-shim.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

installDomShim();

const harness = await import("./setup-surface-harness.ts");
const sf = await import("../src/lib/setup-flow/index.ts");
const { setCeremony } = await import("../src/lib/store.ts");
const { installNav } = await import("../src/lib/nav.ts");

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

function quietNav(): void {
  installNav({
    navigate: () => {},
    onUnauthorised: () => {},
    refreshIdentity: async () => {},
    onAuthenticated: async () => {},
    signOut: () => {},
  });
}

const PAYMENTS = "kv:demo-acct-northwind:demo-kv-payments";

async function main(): Promise<void> {
  console.log("\n-- the stored draft never carries the deploy token or the generated key material --");

  harness.resetSetupWorld(harness.OWNER);
  quietNav();
  setCeremony(null);
  const m = sf.setupModel();
  m.reset();
  await m.refresh();

  const TOKEN = "deploy-token-demo-secret-value";
  await sf.verifyToken("cf-read-only-demo");
  m.update({ provider: "r2", bucket: "setup-archive" });
  await sf.saveDestination({ accessKeyId: "AKID", secretAccessKey: "s3cret" });
  m.update({ picks: [PAYMENTS], custody: "password-manager" });
  await sf.acknowledgePosture("break-glass-only");
  const generated = await sf.generateKeys();
  ok("the key ceremony ran", generated.ok);
  sf.confirmKeysSaved();

  // Captured BEFORE apply: a successful apply drops the ceremony from the tab (install.ts), which is the
  // behaviour validate-custody-card-disconnect-wipe.ts pins separately. This test needs the secret VALUES to search for, not the
  // post-apply state.
  const ceremony = sf.currentCeremony();
  ok("a ceremony is held in this tab (so there IS secret material to leak)", ceremony !== null);
  const secretNeedles: string[] = ceremony
    ? [ceremony.breakGlass.identityB64, ceremony.signer.privateB64, ceremony.configRecipient.identityB64, ceremony.configWrapKeyB64]
    : [];

  await sf.applyWithDeployToken(TOKEN);

  const session = (globalThis as unknown as { sessionStorage: Storage }).sessionStorage;
  const draftRaw = session.getItem("dp-draft:setup-v1") ?? "";
  ok("the session draft was written", draftRaw.length > 0);
  ok("the session draft does not contain the deploy token", !draftRaw.includes(TOKEN));
  for (const needle of secretNeedles) {
    ok(`the session draft does not contain a ceremony secret (${needle.slice(0, 8)}...)`, !draftRaw.includes(needle));
  }
  const parsed = JSON.parse(draftRaw) as Record<string, unknown>;
  const KNOWN_SECRET_LOOKING_KEYS = ["token", "key", "secret", "private", "identity"];
  const suspectKeys = Object.keys(parsed).filter((k) => KNOWN_SECRET_LOOKING_KEYS.some((bad) => k.toLowerCase().includes(bad)));
  ok(
    "no draft field holding a token/key-shaped name carries a string value (only booleans, counts or a null scope are expected)",
    suspectKeys.every((k) => typeof parsed[k] === "boolean" || typeof parsed[k] === "number" || parsed[k] === null),
  );

  const store = (globalThis as unknown as { localStorage: Storage }).localStorage;
  const backupRaw = store.getItem("downpipes.setup.first-backup") ?? "";
  if (backupRaw.length > 0) {
    ok("the localStorage first-backup copy does not contain the deploy token", !backupRaw.includes(TOKEN));
    for (const needle of secretNeedles) {
      ok(`the first-backup copy does not contain a ceremony secret (${needle.slice(0, 8)}...)`, !backupRaw.includes(needle));
    }
  }

  verdictReached(failures);
  if (failures > 0) {
    console.log(`\n${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nAll checks passed.");
}

void main();
