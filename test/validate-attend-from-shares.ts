// Attended verification must work from an M-of-N split, and must refuse a key that has gone stale.
//
// WHY THIS EXISTS. The design note for the operational-key reduction listed three surfaces that take the
// break-glass private and asked which accepted a split. `/restore/attend` was recorded as a gap: it read
// identity.key through a bare file picker, so a customer who had split their key had no way to run
// attended verification at all. That gap has since been closed in the screen, which mounts the same
// reassembly card the break-glass restore and recover-key screens use, in no-download mode.
//
// Nothing proved it. There was no assertion anywhere that the attend screen accepts shares, which on a
// break-glass-only estate with split custody is the whole path: attended verification is the thing the
// operational key was removed in favour of, and a split holder is the customer most likely to be on that
// posture. Wiring that works and is untested is one refactor away from wiring that does not.
//
// TWO BEHAVIOURS, and the second is the one that matters.
//
//   1. A quorum of shares reconstructs the key in the browser and ENABLES the session. Without this the
//      split customer is stuck at a file picker holding files that are not identity.key.
//
//   2. Changing the loaded set AFTER a successful reconstruct must invalidate the derived key and put the
//      session back out of reach. A key derived from a share set the operator has since edited is stale,
//      and starting a verification session with it would attest against material nobody selected. The
//      screen has an onInvalidated path for exactly this; this is what holds it there.
//
// The archive and engine are never touched. The screen is rendered under the shared DOM shim and driven
// through the card's real controls, so the assertions exercise production code rather than a
// re-implementation of it.
//
// House style: Australian English, no em dashes, no rule-of-three, no AI attribution.

import { installDomShim, qs, qsa, textOf, flushAsync, type ShimNode } from "./dom-shim.ts";

installDomShim();

const store = await import("../src/lib/store.ts");
const { renderAttendRunner } = await import("../src/screens/restore-flow/attend.ts");
const { split, wrappingKeyChecksum } = await import("../src/lib/shamir.ts");
const { serialiseShareFile, serialiseEnvelopeFile, identityPlaintext } = await import("../src/lib/custody-files.ts");
const { encrypt } = await import("../src/lib/envelope.ts");
const keygen = await import("../src/keygen.ts");

type Caller = import("../src/lib/api/types.ts").Caller;

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

// A real ceremony, so the reassembled bytes are a genuine identity.key rather than a shape that only
// looks like one. The card parses what it reconstructs, and a synthetic blob would pass the split and
// fail the parse, which would test the wrong half.
const result = await keygen.runKeyCeremony({ operational: false });
const identityBytes = identityPlaintext(result);

// Encrypt under a random wrapping key, split that key 3-of-5, and serialise the artefacts exactly as the
// custody step emits them. Anything less faithful would be testing this file's idea of a share file.
const env = await encrypt(identityBytes);
const shares = split(env.wrappingKey, 5, 3);
const checksum = wrappingKeyChecksum(env.wrappingKey);
const ciphertextFile = serialiseEnvelopeFile({ iv: env.iv, ciphertext: env.ciphertext });
const shareFiles = shares.map((s, i) =>
  serialiseShareFile({ index: i + 1, n: 5, threshold: 3, checksum, share: s }),
);

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

function setValue(root: ShimNode, id: string, value: string): void {
  const el = qs(root, `#${id}`);
  if (el === null) throw new Error(`no control #${id} on the attend screen`);
  el.value = value;
  fire(el, "input");
}

function button(root: ShimNode, dp: string): ShimNode {
  const b = qs(root, `[data-dp="${dp}"]`);
  if (b === null) throw new Error(`no button ${dp} on the attend screen`);
  return b;
}

function startButton(root: ShimNode): ShimNode {
  const b = qsa(root, "button").find((x) => textOf(x).includes("Start attended verification"));
  if (b === undefined) throw new Error("the attended-verification start button is not on the screen");
  return b;
}

function supplyFile(root: ShimNode, id: string, text: string): void {
  const el = qs(root, `#${id}`);
  if (el === null) throw new Error(`no control #${id} on the attend screen`);
  (el as unknown as { files: unknown }).files = [new ShimFile([text], "identity.key.enc")];
  fire(el, "change");
}

async function addShare(root: ShimNode, text: string): Promise<void> {
  setValue(root, "recover-shares-paste", text);
  button(root, "restore-flow.button.add-share").click();
  await flushAsync();
}

// The ciphertext arrives through a FILE INPUT and a FileReader, not a text field, so both are stubbed
// the same way validate-break-glass-restore.ts does. Setting .value on a file input does nothing, so a
// stub that only sets .value would leave the reconstruct control disabled and read as the card refusing
// a good quorum rather than as the test never delivering the envelope.
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

// The screen observes its own subtree to know when the shell has mounted it. The shim has no observer,
// so a minimal one stands in: it records the callback and never fires, which is the honest default here
// because this test mounts the screen directly rather than through the shell.
const g = globalThis as unknown as Record<string, unknown>;
g.FileReader = ShimFileReader;
g.File = ShimFile;
if (g.MutationObserver === undefined) {
  g.MutationObserver = class {
    observe(): void {}
    disconnect(): void {}
  };
}

console.log("\n-- attended verification from an M-of-N split --\n");

store.setCaller({ method: "passkey", email: "owner@example.com", role: "owner", groups: [], isOnlyOwner: false } as Caller);
store.connect("https://engine.test");
const engine = store.getEngine();
if (engine === null) throw new Error("no engine client, so the runner cannot render");

const root = renderAttendRunner(engine) as unknown as ShimNode;
await flushAsync();

ok("the attend screen offers the share route, not only a file picker", qs(root, "#recover-shares-paste") !== null);
ok("the session cannot start before a key is loaded", startButton(root).disabled === true);

// Three of five, which is the quorum. Below it the card must not reconstruct at all.
await addShare(root, shareFiles[0]!);
await addShare(root, shareFiles[1]!);
supplyFile(root, "recover-ciphertext", ciphertextFile);
await flushAsync();
ok("below the quorum the reconstruct control stays disabled", button(root, "restore-flow.button.reconstruct").disabled === true);
ok("and the session is still out of reach on two of three shares", startButton(root).disabled === true);

await addShare(root, shareFiles[2]!);
await flushAsync();
button(root, "restore-flow.button.reconstruct").click();
await flushAsync();

ok("a quorum reconstructs the key in the browser", textOf(root).includes("Split key reassembled in this browser"));
ok("and that ENABLES the attended session, which is the whole point for a split holder", startButton(root).disabled === false);

// The staleness rule. Editing the set after a good reconstruct must retract the derived key: attesting
// against material the operator has since changed is the failure this path exists to prevent.
const removeButtons = qsa(root, '[data-dp="restore-flow.button.remove-share"]');
ok("the loaded shares can be edited after a reconstruct", removeButtons.length > 0);
removeButtons[0]!.click();
await flushAsync();

ok(
  "removing a share after reconstructing puts the session BACK out of reach (no attesting on a stale key)",
  startButton(root).disabled === true,
);

// ---- the RESUME banner, which is the same screen's second entry point --------------------------------
//
// The setup card above was the surface the design note named. The resume banner is the other one, and it
// was file-only while its own copy told a split holder that "resuming needs a quorum of shares again, the
// same as when you started it". The sentence made a promise the control under it could not keep: a split
// holder whose tab was reopened mid-session could either abandon the session or nothing, and on a large
// estate abandoning means re-convening the quorum AND redoing everything the session had already covered.
//
// The banner appears only when a session id is persisted, so the storage is seeded and the screen
// re-rendered, which is exactly what a reopened tab does.
console.log("\n-- resuming a session, from an M-of-N split --\n");

const RESUME_KEY = "downpipes.attend.session";
(globalThis as unknown as { localStorage: { setItem: (k: string, v: string) => void } }).localStorage.setItem(
  RESUME_KEY,
  JSON.stringify({ sessionId: "att-resume-fixture", sampleRate: 25 }),
);

const resumed = renderAttendRunner(engine) as unknown as ShimNode;
await flushAsync();

const banner = qsa(resumed, "section").find((s) => textOf(s).includes("Resume your last attended verification"));
ok("a persisted session offers the resume banner", banner !== undefined);
ok(
  "the banner keeps the identity.key route",
  banner !== undefined && qs(banner, '[data-dp="restore-flow.file.resume-banner"]') !== null,
);
// The assertion this section exists for. Without it the banner's own sentence about needing a quorum is a
// promise with no control behind it.
ok(
  "and it offers the QUORUM route, which its own copy already promises",
  banner !== undefined && qs(banner, '[data-dp="restore-flow.button.reconstruct"]') !== null,
);
ok(
  "the banner still says what a split holder has to bring",
  banner !== undefined && textOf(banner).includes("resuming needs a quorum of shares again"),
);

console.log(`\n${failures === 0 ? "ATTEND-FROM-SHARES PASS" : `ATTEND-FROM-SHARES: ${failures} FAILED`}\n`);
if (failures > 0) process.exitCode = 1; // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
process.exit(failures === 0 ? 0 : 1);
