// The GUARDED local-file delivery primitives.
//
// Every recovery artefact the console produces (identity.key, the recipient and signer files, the recovery
// sheet, a custody share, the passkey recovery codes) is delivered the same way: a Blob is built in memory, an
// object URL is minted, a transient anchor is clicked, and the browser writes the file. Nothing is uploaded,
// which is the whole no-custody point. The failure mode that matters is that this can REFUSE: a Blob
// constructor that throws under memory pressure, a URL.createObjectURL that throws, an anchor click a hardened
// browser declines. Before this module those throws propagated out of a click handler (or, worse, out of the
// middle of the ceremony's six-file burst, where they aborted the remaining files and were reported to the
// operator as "could not generate keys" when the keys had in fact been generated).
//
// The primitives here are TOTAL: they never throw. They return TRUE when the browser accepted the delivery and
// FALSE when it refused, so the caller can tell the customer that the file did not arrive.
//
// EVERY ONE TAKES A `surface`, AND THAT IS THE POINT OF THIS BUILD. A refused blob download is not one fault,
// it is five, and they are five different tickets: identity.key never landing in the first key ceremony (the
// customer has no way to decrypt any backup, ever) is not the same as a refused download during a break-glass
// ROTATION (the old key still works), and neither is the same as the one-time recovery codes (a later lost
// passkey is then a permanent lock-out). The route the operator is standing on cannot tell those apart, because
// several of them share a route. So the surface is passed in, as a compile-time literal, at each call site.
//
// A FILE NAME NEVER TRAVELS. The name is used to word the on-screen message and for nothing else; the closed
// record has no field it could occupy.
//
// WHAT THIS CANNOT DO, STATED PLAINLY. A download the browser blocks SILENTLY (a policy that declines the
// write without raising anything, or an OS-level quarantine after the click was accepted) is NOT OBSERVABLE:
// the platform exposes no completion signal for an <a download> click, so no browser API can tell us the file
// never landed, and the click below returns exactly as it does on success. We do not pretend to catch it. The
// console's answer to that case is the ceremony's own confirmation step (the operator states that they have
// saved identity.key) and the per-file re-download controls, which is a real answer and not a fault record we
// cannot honestly make. The same is true of a POPUP BLOCKER swallowing openHtmlTab: the click is accepted and
// the tab simply never appears, which is why the callers also offer the sheet as a plain download.

import { reportCapabilityRefused, reportCapabilityUnavailable } from "./client-diag/capability-faults.ts";
import type { ClientDiagSurface } from "./client-diag/vocab.ts";

// The delay before an object URL opened in a NEW TAB is revoked. A synchronous revoke races the tab open in
// some browsers, so the URL is held briefly and then released.
const BLOB_URL_REVOKE_DELAY_MS = 10_000;

// deliverFile writes one in-memory file to the operator's disk via the browser's own download path. Returns
// false when the browser refused, having recorded a capability-fault row that names the capability
// (blob-download) and the ceremony that asked for it. Never throws.
export function deliverFile(name: string, content: string, type: string, surface: ClientDiagSurface): boolean {
  let url: string | null = null;
  try {
    url = URL.createObjectURL(new Blob([content], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    return true;
  } catch {
    // The browser refused. The caught value is deliberately not passed on: the reporter takes no error
    // argument, so a DOMException's message has no path to the ring, and neither does `name`.
    //
    // This is `refused`, not `unavailable`: every browser that can run this console has Blob, URL and an
    // anchor, so a throw here is the browser DECLINING the delivery, not a host that cannot do it.
    reportCapabilityRefused("blob-download", surface);
    return false;
  } finally {
    // The object URL is released whether or not the click was accepted, so a refused delivery cannot leak the
    // blob for the life of the document.
    if (url !== null) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // A host without revokeObjectURL is not a fault worth recording: the file either arrived or the catch
        // above already recorded the refusal.
      }
    }
  }
}

// copyToClipboard writes text to the operator's clipboard through the async Clipboard API. It is the OTHER way
// a recovery artefact leaves the console for the operator's own keeping (the recovery-codes panel offers Copy
// beside Download; an integration endpoint offers Copy alone).
//
// TOTAL: it never throws and never rejects. It resolves TRUE when the browser accepted the write and FALSE
// when it did not, so the caller can tell the operator that the copy did not happen rather than painting
// "Copied" over a clipboard that never changed.
//
// THE TWO OUTCOMES ARE NOT THE SAME FAULT, and the previous build's conflation of them is one of the things
// this one fixes. A clipboard that is PRESENT and REFUSES the write (a permissions policy, a document without
// focus, a lost user gesture) is a refusal. A clipboard that is ABSENT is a plain-http self-host, which is a
// legitimate configuration, and reporting it as a console defect meant every Copy press on such a host
// inflated the counter that is defined to mean "a console defect nobody caught". It is recorded, because the
// operator still did not get their copy, and it is recorded as `unavailable`.
//
// THE COPIED TEXT IS NEVER TOUCHED beyond handing it to the platform: it is a recovery code or an endpoint, so
// it is passed straight through and is never read, classified or held.
export async function copyToClipboard(text: string, surface: ClientDiagSurface): Promise<boolean> {
  try {
    const clip = navigator.clipboard;
    if (clip === undefined || typeof clip.writeText !== "function") {
      reportCapabilityUnavailable("clipboard", surface);
      return false;
    }
    await clip.writeText(text);
    return true;
  } catch {
    reportCapabilityRefused("clipboard", surface);
    return false;
  }
}

// openHtmlTab opens self-contained HTML (the printable recovery sheet) in a new tab through a blob URL, so the
// sheet document has its own opaque origin and needs no relaxation of the console's Content-Security-Policy.
// Returns false when the browser refused, having recorded a capability-fault row. Never throws. A popup blocker
// is a different matter and is not observable here: see the note at the top of the file.
export function openHtmlTab(html: string, surface: ClientDiagSurface): boolean {
  try {
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoked on a delay rather than in a finally: the new tab is still fetching the URL when this returns.
    setTimeout(() => {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // Nothing to do: the document is going away or the host has no revoke.
      }
    }, BLOB_URL_REVOKE_DELAY_MS);
    return true;
  } catch {
    reportCapabilityRefused("tab-open", surface);
    return false;
  }
}
