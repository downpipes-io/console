// Validate that the identity.key handle a custody card holds is dropped when the card leaves the page.
//
// src/components/break-glass-key-panel.ts parses an uploaded identity.key entirely in this browser and
// holds the result in its own closure (never serialised). Both mount sites that collect a break-glass
// identity this way (src/components/recovery-banner.ts:380 and src/components/estate-import-modal.ts:138)
// wire src/screens/restore-flow/reassembly.ts's wipeOnDisconnect over the panel so a navigation away --
// which the router's closeAllOverlays tears down WITHOUT running any onClose/onDismiss wipe -- still zeroes
// the held key. The line this pins is reassembly.ts's wipeOnDisconnect, specifically the `if (everConnected)`
// branch that actually calls `wipe()` on a disconnect: this drives that exact pairing (wipeOnDisconnect +
// the panel's real file-upload path) and proves the handle is gone once the card's element leaves the
// document, not only on an explicit Cancel.
//
// Run with `node test/validate-custody-card-disconnect-wipe.ts`.

import { installDomShim, qs } from "./dom-shim.ts";
import { makeEvent } from "./dom-shim-core.ts";

installDomShim();

// A minimal, faithful FileReader/File pair (the shared shim does not provide them), the same one
// test/validate-break-glass-restore.ts and test/validate-estate-import-modal.ts install.
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

// A MutationObserver that actually captures its callback, instead of the no-op stub other validators use
// (they never exercise the disconnect path; this one must). `.fire()` stands in for the browser running a
// queued mutation record, which this hand-rolled DOM shim never does on its own.
class CapturingObserver {
  static last: CapturingObserver | null = null;
  private cb: () => void;
  constructor(cb: () => void) {
    this.cb = cb;
    CapturingObserver.last = this;
  }
  observe(): void {}
  disconnect(): void {}
  fire(): void {
    this.cb();
  }
}

const g = globalThis as unknown as { FileReader: unknown; File: unknown; MutationObserver: unknown };
g.FileReader = ShimFileReader;
g.File = ShimFile;
g.MutationObserver = CapturingObserver;

const { renderBreakGlassKeyPanel } = await import("../src/components/break-glass-key-panel.ts");
const { wipeOnDisconnect } = await import("../src/screens/restore-flow/reassembly.ts");
const { runKeyCeremony, identityFile } = await import("../src/keygen.ts");
const { verdictReached } = await import("./lib/verdict-guard.ts"); // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}
const nextTask = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function main(): Promise<void> {
  const ceremony = await runKeyCeremony({ operational: false });
  const IDENTITY_TEXT = identityFile(ceremony.breakGlass);

  console.log("\n-- a card holding a parsed identity.key drops it once it leaves the document --");
  {
    const panel = renderBreakGlassKeyPanel({ intro: "test" });
    panel.setVisible(true);
    document.body.appendChild(panel.el);
    // The same pairing recovery-banner.ts (line 380) and estate-import-modal.ts (line 138) wire.
    wipeOnDisconnect(panel.el, panel.wipeAll);

    const input = qs(panel.el, "#cp-import-sealed-identity");
    if (!input) throw new Error("no identity file input in the panel");
    (input as unknown as { files: unknown }).files = [new ShimFile([IDENTITY_TEXT], "identity.key")];
    input.dispatchEvent(makeEvent({ type: "change", bubbles: true }));
    await nextTask();
    await nextTask();
    ok("the identity was read and parsed into the panel", panel.identity() !== null);

    // A mutation while the card is still connected must not wipe it.
    CapturingObserver.last?.fire();
    ok("still connected: the handle survives an ordinary mutation", panel.identity() !== null);

    // The card leaves the page the way a real navigation does: closeAllOverlays/teardown call .remove()
    // directly, never the panel's own onDismiss/onClose wipe.
    panel.el.remove();
    CapturingObserver.last?.fire();
    ok("once disconnected, the identity.key handle is dropped", panel.identity() === null);
  }

  console.log("\n-- CONTROL: without wipeOnDisconnect wired, the handle would survive a disconnect --");
  {
    const panel = renderBreakGlassKeyPanel({ intro: "test" });
    panel.setVisible(true);
    document.body.appendChild(panel.el);
    // Deliberately NOT calling wipeOnDisconnect here.
    const input = qs(panel.el, "#cp-import-sealed-identity");
    if (!input) throw new Error("no identity file input in the panel");
    (input as unknown as { files: unknown }).files = [new ShimFile([IDENTITY_TEXT], "identity.key")];
    input.dispatchEvent(makeEvent({ type: "change", bubbles: true }));
    await nextTask();
    await nextTask();
    ok("the identity was read", panel.identity() !== null);
    panel.el.remove();
    ok("CONTROL: with no wipeOnDisconnect wiring, leaving the page alone does not wipe it", panel.identity() !== null);
    panel.wipeAll();
    ok("CONTROL: the panel's own wipeAll still works directly", panel.identity() === null);
  }

  verdictReached(failures);
  if (failures > 0) {
    console.log(`\n${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nAll checks passed.");
}

void main();
