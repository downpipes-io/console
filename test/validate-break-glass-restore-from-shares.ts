// Validates the in-console break-glass restore panel's M-of-N quorum recovery path: reassembling the
// private from shares, the source-aware staleness rule (an edit to the share list drops a reassembled
// private but must not drop one loaded from a file), and that teardown leaves the secret unrebuildable.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installDomShim, qs, flushAsync, type ShimNode } from "./dom-shim.ts";

installDomShim();

class ShimFile {
  _text: string;
  name: string;
  type = "text/plain";
  constructor(parts: string[], name: string) {
    this._text = parts.join("");
    this.name = name;
  }
}
class ShimFileReader {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  result: string | null = null;
  readAsText(file: ShimFile): void {
    this.result = file._text;
    setTimeout(() => this.onload?.(), 0);
  }
}
const g = globalThis as unknown as Record<string, unknown>;
g.FileReader = ShimFileReader;
g.File = ShimFile;
g.location = g.location ?? { origin: "https://console.test" };
if (g.MutationObserver === undefined) {
  g.MutationObserver = class {
    observe(): void {}
    disconnect(): void {}
  };
}

const { connect, setCaller } = await import("../src/lib/store.ts");
const { installNav } = await import("../src/lib/nav.ts");
const { renderBreakGlassRestore } = await import("../src/screens/restore-flow/break-glass.ts");
const { split, wrappingKeyChecksum } = await import("../src/lib/shamir.ts");
const { serialiseShareFile, serialiseEnvelopeFile } = await import("../src/lib/custody-files.ts");
const { encrypt } = await import("../src/lib/envelope.ts");

const HERE = dirname(fileURLToPath(import.meta.url));
const V = JSON.parse(readFileSync(join(HERE, "vectors/keydecap-vector.json"), "utf8")) as {
  identityFile: string;
  wraps: Array<{ fingerprint: string; kemCiphertext: string; sealed: string }>;
  keyCommitment: string;
};
const RUN_ID = "01JBGRESTORESHARES0000000";

type Caller = import("../src/api.ts").Caller;

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

// The custody artefacts, built the way the custody step emits them: the identity.key TEXT encrypted under a
// fresh wrapping key, and that key split 3-of-5. The card decodes what it decrypts with a TextDecoder and
// hands it to parseIdentityFile, so encoding the pinned vector's own identity.key here means BOTH supply
// routes in this test carry the same key, which is what lets the last assertion isolate the SOURCE rather
// than accidentally testing that two different keys behave differently.
const env = await encrypt(new TextEncoder().encode(V.identityFile));
const shares = split(env.wrappingKey, 5, 3);
const checksum = wrappingKeyChecksum(env.wrappingKey);
const ciphertextFile = serialiseEnvelopeFile({ iv: env.iv, ciphertext: env.ciphertext });
const shareFiles = shares.map((s, i) => serialiseShareFile({ index: i + 1, n: 5, threshold: 3, checksum, share: s }));

function fire(node: ShimNode, type: string): void {
  node.dispatchEvent({
    type,
    target: node,
    currentTarget: node,
    defaultPrevented: false,
    bubbles: true,
    preventDefault() {},
    stopPropagation() {},
  });
}

function control(root: ShimNode, sel: string): ShimNode {
  const el = qs(root, sel);
  if (el === null) throw new Error(`the break-glass panel has no ${sel}`);
  return el;
}

async function addShare(root: ShimNode, text: string): Promise<void> {
  const paste = control(root, "#recover-shares-paste");
  paste.value = text;
  fire(paste, "input");
  control(root, '[data-dp="restore-flow.button.add-share"]').click();
  await flushAsync();
}

function supplyFile(root: ShimNode, sel: string, text: string, name: string): void {
  const el = control(root, sel);
  (el as unknown as { files: unknown }).files = [new ShimFile([text], name)];
  fire(el, "change");
}

console.log("\n-- the in-console break-glass restore, from a quorum --\n");

// The panel gates its whole body on restore.verify, mirroring the capability the engine enforces on the
// capsule route, and returns an outcome card instead when the caller lacks it. A test that skipped this
// would drive an empty panel and every assertion about the share controls would report "not there" while
// the screen was working. So the caller is set exactly as validate-break-glass-restore.ts sets it.
installNav({ navigate: () => {}, onUnauthorised: () => {}, refreshIdentity: async () => {}, onAuthenticated: async () => {}, signOut: () => {} });
setCaller({ method: "access", email: "op@test", role: "operator", groups: [], isOnlyOwner: false } as Caller);
const engine = connect("https://engine.test");
engine.restoreCapsule = async (runId: string) => ({ ok: true, runId, masterCapsule: V.wraps, keyCommitment: V.keyCommitment, recordCount: 3 });
// This file is about which SUPPLY ROUTES load a key and when a loaded key goes stale, so it never previews.
// The restore route therefore throws rather than returning a plausible plan: a stub that answers politely
// would let a future edit start previewing here and never say so, and the preview path already has its own
// coverage in validate-break-glass-restore.ts.
engine.restore = async (): Promise<never> => {
  throw new Error("validate-break-glass-restore-from-shares does not preview, so /restore must not be reached");
};

const panel = renderBreakGlassRestore(engine, RUN_ID);
const root = panel.el as unknown as ShimNode;
await flushAsync();

ok("the panel starts holding no private", panel.peekSensitiveForTest().hasPrivate === false);
ok("it offers the quorum route as well as the file input", qs(root, "#recover-shares-paste") !== null && qs(root, "#bg-identity") !== null);

// Below the quorum nothing may be recovered. Asserting only that the panel holds no private would be
// worthless here, because a card that never worked at all would satisfy it too. So the control's own
// disabled state is asserted first, and then the click is made anyway: a refusal has to hold when the
// operator presses the button, not only when the styling says not to.
await addShare(root, shareFiles[0]!);
await addShare(root, shareFiles[1]!);
supplyFile(root, "#recover-ciphertext", ciphertextFile, "identity.key.enc");
await flushAsync();
ok("below the quorum the reconstruct control is disabled", control(root, '[data-dp="restore-flow.button.reconstruct"]').disabled === true);
control(root, '[data-dp="restore-flow.button.reconstruct"]').click();
await flushAsync();
ok("and pressing it anyway on two of three shares recovers nothing", panel.peekSensitiveForTest().hasPrivate === false);

await addShare(root, shareFiles[2]!);
await flushAsync();
control(root, '[data-dp="restore-flow.button.reconstruct"]').click();
await flushAsync();

ok("a quorum reconstructs the break-glass private into the panel", panel.peekSensitiveForTest().hasPrivate === true);
ok("reconstructing alone does not decapsulate a master", panel.peekSensitiveForTest().master === null);

// The staleness rule, first half: a private that CAME from reassembly must not survive an edit to the set
// it was derived from. Restoring on a key derived from shares the operator has since changed would act on
// material nobody selected.
const removeBtn = qs(root, '[data-dp="restore-flow.button.remove-share"]');
ok("the loaded shares can be edited after reconstructing", removeBtn !== null);
removeBtn?.click();
await flushAsync();
ok("editing the shares AFTER reconstructing drops the private (it is now stale)", panel.peekSensitiveForTest().hasPrivate === false);

// The panel must also stop SAYING it holds a key once it does not: an operator mid-incident reads the
// status sentence as custody state, so this is checked on the rendered text as well as the internal state.
const claimsReassembled = (): boolean => String((root as unknown as { textContent?: string }).textContent ?? "").includes("Split key reassembled in this browser");
ok("and the key status stops claiming a reassembled key is held", claimsReassembled() === false);

// The second half, which pulls the other way: a private loaded from a FILE has nothing to do with the share
// list, so an edit there must leave it alone. A rule that simply cleared on any reassembly change would
// pass the assertion above and fail this one.
supplyFile(root, "#bg-identity", V.identityFile, "identity.key");
await flushAsync();
ok("supplying identity.key populates the private", panel.peekSensitiveForTest().hasPrivate === true);

await addShare(root, shareFiles[0]!);
await flushAsync();
ok(
  "editing the shares does NOT drop a private that came from a FILE (the staleness rule is source-aware)",
  panel.peekSensitiveForTest().hasPrivate === true,
);

// Teardown must leave the secret unrebuildable, not merely unheld: the reconstruct control must also be
// disabled, and pressing it again with no further input must not hand the key back.
await addShare(root, shareFiles[1]!);
await addShare(root, shareFiles[2]!);
await flushAsync();
control(root, '[data-dp="restore-flow.button.reconstruct"]').click();
await flushAsync();
ok("a fresh quorum reconstructs again, so the teardown below is tearing down something real", panel.peekSensitiveForTest().hasPrivate === true);

panel.teardown();
await flushAsync();
ok("after teardown the panel holds no private", panel.peekSensitiveForTest().hasPrivate === false);
ok("and no master", panel.peekSensitiveForTest().master === null);
ok("teardown also clears the key status, so a torn-down panel does not still read as holding a key", claimsReassembled() === false);
ok("teardown also disables the reconstruct control, so a torn-down card does not read as still loaded", control(root, '[data-dp="restore-flow.button.reconstruct"]').disabled === true);
control(root, '[data-dp="restore-flow.button.reconstruct"]').click();
await flushAsync();
ok(
  "and pressing reconstruct after teardown, with no further input, does NOT rebuild the break-glass private",
  panel.peekSensitiveForTest().hasPrivate === false,
);

console.log(`\n${failures === 0 ? "BREAK-GLASS-RESTORE-FROM-SHARES PASS" : `BREAK-GLASS-RESTORE-FROM-SHARES: ${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
