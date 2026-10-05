// A KEY SELECTED ON /keys/custody MUST SURVIVE THE IDENTITY RE-RENDER.
//
// The first paint after a reload runs before whoami. When the caller lands, app.ts re-renders the screen on
// screen in place (reRenderCurrentScreenForResolvedIdentity, a quiet swap). The Custody tab was rebuilt from
// scratch by that re-render, so an operator who had already selected their identity.key lost the mounted
// custody step without a word and had to select the file again. The tab now carries the card that is on
// screen across the re-render.
//
// WHAT THIS PINS, each able to fail on its own:
//   1. THE CONTROL. Selecting a valid identity.key mounts the custody step (a pass here is what makes the
//      later presence mean something).
//   2. THE RE-RENDER KEEPS IT. A second render taken while the first is still on screen, swapped in the way
//      the quiet re-render swaps it, still shows the custody step for the selected key.
//   3. A REAL DEPARTURE DOES NOT. Once the card has left the document, the next render starts clean, so the
//      carry-across never keeps a key reachable after the tab has gone.
//
// Run: node test/validate-custody-survives-identity-rerender.ts

import { installDomShim, qsa, textOf, flushAsync, type ShimNode } from "./dom-shim.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

installDomShim();

class ShimFile {
  _text: string;
  name: string;
  size: number;
  type = "text/plain";
  constructor(parts: string[], name: string) {
    this._text = parts.join("");
    this.name = name;
    this.size = this._text.length;
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
// A MutationObserver the test runs by hand, so "the card left the document" is a step this file takes
// rather than a timing it hopes for.
const observers: Array<() => void> = [];
class ShimMutationObserver {
  private readonly cb: () => void;
  constructor(cb: () => void) {
    this.cb = cb;
  }
  observe(): void {
    observers.push(this.cb);
  }
  disconnect(): void {
    const i = observers.indexOf(this.cb);
    if (i >= 0) observers.splice(i, 1);
  }
}
function runObservers(): void {
  for (const cb of [...observers]) cb();
}
const g = globalThis as unknown as Record<string, unknown>;
g.FileReader = ShimFileReader;
g.File = ShimFile;
g.MutationObserver = ShimMutationObserver;

const { renderCustodyTab } = await import("../src/screens/keys/custody.ts");
const { b64urlEncode } = await import("../src/bytes.ts");

let failures = 0;
let checks = 0;
function ok(label: string, cond: boolean): void {
  checks++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

const IDENTITY = `downpipe-identity-v1 ${b64urlEncode(new Uint8Array(96).fill(7))}\n`;
const body = document.body as unknown as ShimNode;

// stepMounted reads whether the custody step (the M-of-N split for a loaded key) is on screen.
function stepMounted(root: ShimNode): boolean {
  return qsa(root, 'input[type="radio"]').length > 0 || textOf(root).includes("In-browser only");
}

function selectIdentity(root: ShimNode): void {
  const input = qsa(root, 'input[type="file"]').find((n) => n.getAttribute("data-dp") === "keys.file.file-input-block");
  if (input === undefined) throw new Error("the custody tab offers no identity.key picker");
  (input as unknown as { files: unknown }).files = [new ShimFile([IDENTITY], "identity.key")];
  input.dispatchEvent({ type: "change", target: input, currentTarget: input, defaultPrevented: false, bubbles: true, preventDefault() {}, stopPropagation() {} });
}

// swapIn replaces what is on screen with `next`, the same bare swap the quiet re-render makes.
function swapIn(next: ShimNode): void {
  body.replaceChildren(next);
}

async function main(): Promise<void> {
  console.log("\n-- 1. the control: selecting a key mounts the custody step --");
  const first = renderCustodyTab() as unknown as ShimNode;
  swapIn(first);
  runObservers();
  ok("before a key is selected, no custody step is mounted", !stepMounted(first));
  selectIdentity(first);
  await flushAsync();
  ok("selecting a valid identity.key mounts the custody step", stepMounted(first));

  console.log("\n-- 2. the identity re-render keeps the selected key mounted --");
  const second = renderCustodyTab() as unknown as ShimNode;
  swapIn(second);
  runObservers();
  await flushAsync();
  ok("after the re-render, the custody step is still mounted", stepMounted(second));
  ok("and it is on screen", stepMounted(body));
  ok("the tab still offers exactly one identity.key picker", qsa(body, 'input[type="file"]').filter((n) => n.getAttribute("data-dp") === "keys.file.file-input-block").length === 1);

  console.log("\n-- 3. after the tab has left the document, the next render starts clean --");
  body.replaceChildren();
  runObservers();
  const third = renderCustodyTab() as unknown as ShimNode;
  swapIn(third);
  runObservers();
  ok("a render after the tab left starts with no key mounted", !stepMounted(third));

  console.log(failures === 0 ? "\nPASS validate-custody-survives-identity-rerender" : `\nFAIL validate-custody-survives-identity-rerender (${failures})`);
  verdictReached(failures, checks);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
