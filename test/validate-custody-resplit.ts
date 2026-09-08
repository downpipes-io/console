// A customer who has already split their key can load a quorum and re-split, and is told plainly that
// re-splitting is not revocation.
//
// WHY THIS EXISTS. The design note for the operational-key reduction recorded the custody tab as a gap:
// splitting an existing key offered only a local file picker, so a customer who had ALREADY split had no
// way back in. Every share they hold is useless to a control that wants identity.key, and the one thing
// they might reasonably want, re-splitting when a custodian changes, was unreachable. The tab now mounts
// the shared reassembly card beside the file picker. Nothing tested that.
//
// THE COPY IS THE OTHER HALF, and it carries more weight than the wiring. Re-splitting mints a fresh
// wrapping key and a fresh identity.key.enc, but the OLD shares still open the OLD ciphertext and recover
// the same key. A customer who believes re-splitting removes a departed custodian's access has drawn
// exactly the wrong conclusion at exactly the wrong moment, and the remedy they actually need is rotating
// the break-glass key. The tab says so. If that sentence were ever dropped in a refactor the screen would
// still work, every other test would still pass, and the customer would be misled, so it is asserted
// here rather than trusted to survive.
//
// No archive, no engine, no network. The tab is rendered under the shared DOM shim and driven through the
// card's real controls.
//
// House style: Australian English, no em dashes, no rule-of-three, no AI attribution.

import { installDomShim, qs, qsa, textOf, flushAsync, type ShimNode } from "./dom-shim.ts";

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
if (g.MutationObserver === undefined) {
  g.MutationObserver = class {
    observe(): void {}
    disconnect(): void {}
  };
}

const { renderCustodyTab } = await import("../src/screens/keys/custody.ts");
const { split, wrappingKeyChecksum } = await import("../src/lib/shamir.ts");
const { serialiseShareFile, serialiseEnvelopeFile, identityPlaintext } = await import("../src/lib/custody-files.ts");
const { encrypt } = await import("../src/lib/envelope.ts");
const keygen = await import("../src/keygen.ts");

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

// A real ceremony split 3-of-5, serialised exactly as the custody step emits it.
const result = await keygen.runKeyCeremony({ operational: false });
const env = await encrypt(identityPlaintext(result));
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

function button(root: ShimNode, dp: string): ShimNode {
  const b = qs(root, `[data-dp="${dp}"]`);
  if (b === null) throw new Error(`no button ${dp} on the custody tab`);
  return b;
}

async function addShare(root: ShimNode, text: string): Promise<void> {
  const paste = qs(root, "#recover-shares-paste");
  if (paste === null) throw new Error("the custody tab offers no share-paste control");
  paste.value = text;
  fire(paste, "input");
  button(root, "restore-flow.button.add-share").click();
  await flushAsync();
}

console.log("\n-- re-splitting an already-split key --\n");

const root = renderCustodyTab() as unknown as ShimNode;
await flushAsync();

ok("the custody tab offers the quorum route beside the file picker", qs(root, "#recover-shares-paste") !== null);
ok("it still offers the plain file route for an unsplit key", qsa(root, "input[type=\"file\"]").length > 0);

// The sentence that stops a customer drawing the wrong conclusion. Asserted in pieces rather than as one
// long string so a reworded but still honest version keeps passing, while losing the meaning does not.
const copy = textOf(root);
ok("the tab says re-splitting keeps the SAME key", copy.includes("new shares for the same key"));
ok("it says an old share plus the old encrypted file still rebuilds it", copy.includes("old identity.key.enc can still rebuild"));
ok("and it names ROTATION as the remedy for a departing custodian", copy.includes("rotate the key itself"));

// The quorum path itself.
await addShare(root, shareFiles[0]!);
await addShare(root, shareFiles[1]!);
const cipher = qs(root, "#recover-ciphertext");
if (cipher === null) throw new Error("the custody tab offers no ciphertext control");
(cipher as unknown as { files: unknown }).files = [new ShimFile([ciphertextFile], "identity.key.enc")];
fire(cipher, "change");
await flushAsync();

ok("two of three shares does not reach the quorum", button(root, "restore-flow.button.reconstruct").disabled === true);

await addShare(root, shareFiles[2]!);
await flushAsync();
ok("a quorum enables the reconstruct", button(root, "restore-flow.button.reconstruct").disabled === false);

button(root, "restore-flow.button.reconstruct").click();
await flushAsync();

// The whole point of closing this gap: the custody step appears, so the key can be split again.
ok(
  "reconstructing from shares mounts the custody step, so an already-split key CAN be re-split",
  textOf(root).includes("In-browser only") || qsa(root, "input[type=\"radio\"]").length > 0,
);

console.log(`\n${failures === 0 ? "CUSTODY-RESPLIT PASS" : `CUSTODY-RESPLIT: ${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
