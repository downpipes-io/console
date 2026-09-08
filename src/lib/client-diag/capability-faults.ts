// The CAPABILITY-FAULT reporter: the one way a browser-capability failure at a known call site reaches the
// console-diagnostics ring.
//
// THE FAULT IT EXISTS FOR. A key or recovery download the browser refuses. The customer presses the button,
// no file arrives, and nothing anywhere records it. That is the worst class of silent loss in the product,
// because the file that did not arrive is the one that recovers their backups: if they later lose their
// passkey, or their identity.key never landed, they are locked out permanently and no one knows why.
//
// WHY THIS DOES NOT GO THROUGH THE WINDOW SEAM (the mistake this build exists to correct). The first two
// attempts reported the refusal by throwing a synthetic Error at window.reportError, so the existing
// unhandled-fault listener recorded it. The plumbing worked and the evidence was worthless: the ring's mapper
// answers "other" for a throw with no HTTP status, so a REFUSED identity.key download produced
// {kind:"unhandled", screen:"keys", faultClass:"other"} -- byte for byte the same row as an unrelated null
// dereference on the same screen. Worse, the tuple those rows coalesce on holds none of the discriminating
// fields, so on the access screen a refused recovery-codes download, a dead clipboard copy and a console bug
// collapsed into ONE row with a count of three. A support engineer holding only the pack could not say a
// download was refused, could not say which ceremony, and could not separate any of it from a defect.
//
// So a capability fault is now its OWN kind, with its own closed discriminators, written straight to the ring:
// the capability the browser would not give, the ceremony surface that asked for it (which is what says what
// the customer has LOST), and whether the capability was absent or present-and-refused.
//
// NOTHING OF THE ORIGINAL ERROR TRAVELS, AND IT CANNOT. The reporter takes NO error argument. The caught
// DOMException (or whatever the browser refused with) is never read, never passed and never held, and neither
// is the file name: there is no field on the record that could hold either. The classes are compile-time
// literals chosen by the call site, which already knows exactly which capability it asked for.

import { recordCapabilityFault } from "./ring.ts";
import type { ClientDiagCapability, ClientDiagCapabilityOutcome, ClientDiagSurface } from "./vocab.ts";

// reportCapabilityRefused records a capability that IS present in this host and that the browser DECLINED to
// use: a download policy that blocked the write, a permissions policy on the clipboard, a keygen that threw.
// A fault to investigate.
export function reportCapabilityRefused(capability: ClientDiagCapability, surface: ClientDiagSurface): void {
  recordCapabilityFault(capability, surface, "refused");
}

// reportCapabilityUnavailable records a capability that is NOT PRESENT in this host: no navigator.clipboard on
// a plain-http self-host, no WebCrypto outside a secure context. That is a legitimate configuration, not a
// console defect, and it is recorded as its own outcome rather than as a refusal (and certainly not as an
// `unhandled` console fault, which is what the previous build did: every Copy press on a plain-http host
// inflated the counter that is defined to mean "a console DEFECT that reached no catch site").
export function reportCapabilityUnavailable(capability: ClientDiagCapability, surface: ClientDiagSurface): void {
  recordCapabilityFault(capability, surface, "unavailable");
}

// webcryptoOutcome separates the two ways an in-browser key ceremony can fail to produce keys, by asking the
// PLATFORM (never the error): WebCrypto absent means this host cannot do it at all, which on a self-hosted
// console almost always means it is being served over plain http, and the operator's remedy is to serve it
// over HTTPS. WebCrypto present and the ceremony threw anyway means the browser refused a specific operation.
// It reads no error, no message and no stack: it returns a frozen enum member and nothing else.
export function webcryptoOutcome(): ClientDiagCapabilityOutcome {
  const subtle = (globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle;
  return subtle !== undefined && subtle !== null ? "refused" : "unavailable";
}

// reportKeygenFault records a key ceremony that produced NO KEYS. It takes the surface (the first ceremony, or
// a break-glass rotation) and takes NO error, so nothing of the throw can travel. This is the site both earlier
// builds left entirely uncovered: keys/posture.ts and keys/rotation.ts caught the ceremony's failure, rendered
// err.message into a field__error the customer alone ever saw, and reported nothing anywhere. A locked-down
// browser that cannot generate a key pair produced ZERO pack evidence.
export function reportKeygenFault(surface: ClientDiagSurface): void {
  recordCapabilityFault("webcrypto-keygen", surface, webcryptoOutcome());
}
