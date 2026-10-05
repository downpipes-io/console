// Small bridges so a test reads the shimmed tree the real render returns, plus the key-event and
// async-flush helpers. Split out of dom-shim.ts; re-exported there so importers are unchanged.

import { env } from "./dom-shim-env.ts";
import { makeEvent, type ShimNode } from "./dom-shim-core.ts";
import type { ShimEvent } from "./dom-shim-types.ts";

// markConnected flags a rendered root as document-connected (some components guard polls on
// isConnected). Appending to document.body already connects via SHIM_BODY; this is for trees
// a test holds without mounting. Actively imported by several validate-*.ts suites (no longer
// knip-ignored: the tag was stale now that real callers exist).
export function markConnected(root: unknown): void {
  (root as ShimNode).connectedRoot_ = true;
}

export function qs(root: unknown, sel: string): ShimNode | null {
  return (root as ShimNode).querySelector(sel);
}
export function qsa(root: unknown, sel: string): ShimNode[] {
  return (root as ShimNode).querySelectorAll(sel);
}
export function textOf(node: unknown): string {
  return (node as ShimNode).textContent;
}
export function classesOf(node: unknown): string[] {
  return [...(node as ShimNode).classList.set];
}

// keydown builds a document-level key event for dialog.ts's Esc/Tab handler.
export function keydown(opts: { key: string; shiftKey?: boolean }): ShimEvent {
  const ev = makeEvent({ type: "keydown", bubbles: true, cancelable: true });
  ev.key = opts.key;
  ev.shiftKey = !!opts.shiftKey;
  return ev;
}

// dispatchDocKey fires an event at the document-level listeners (Esc/Tab trapping live there). Despite
// the name it is not keydown-specific: docListeners is keyed by event type, so the identical loop also
// drives a delegated click handler (app-external-link.ts's interstitial installs one on document) --
// see docClick below.
export function dispatchDocKey(ev: ShimEvent): void {
  env.SHIM_DOC?.dispatchKey(ev);
}

// docClick builds a document-level click event for a delegated handler: target is the element the
// click "landed" on (an anchor, or a descendant the handler is expected to closest() past), and every
// mouse-modifier field defaults to a plain, unmodified left-click. target is `unknown` (like qs/attr/
// click above) so a caller can pass the real HTMLElement-typed node the production `h()` or
// `document.createElement` returns, with no cast at the call site.
export function docClick(opts: {
  target: unknown;
  button?: number;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}): ShimEvent {
  const ev = makeEvent({ type: "click", bubbles: true, cancelable: true });
  ev.target = opts.target as ShimNode;
  ev.button = opts.button ?? 0;
  ev.metaKey = opts.metaKey ?? false;
  ev.ctrlKey = opts.ctrlKey ?? false;
  ev.shiftKey = opts.shiftKey ?? false;
  ev.altKey = opts.altKey ?? false;
  return ev;
}

// dispatchWindowEvent fires at the window-level (globalThis) listeners installed via
// window.addEventListener (dom-shim-document.ts's winListeners) -- R-102's shared beforeunload
// listener lives there, so a test drives it exactly the way a real browser reload would. Returns
// the same "not cancelled" boolean the real DOM's dispatchEvent returns.
export function dispatchWindowEvent(ev: ShimEvent): boolean {
  const g = globalThis as unknown as { dispatchEvent?: (e: ShimEvent) => boolean };
  return g.dispatchEvent ? g.dispatchEvent(ev) : true;
}

// activeElement reads the shim's focus pointer (so a test can assert focus moved to Cancel, etc).
export function activeElement(): ShimNode | null {
  return env.SHIM_DOC?.activeElement ?? null;
}

// WEB CRYPTO IS THE ONE SOURCE OF WORK HERE THAT A TICK COUNT CANNOT BOUND. Everything else a shimmed
// screen awaits is a microtask or a setTimeout(0): the engine is a recording stub, the FileReader shims
// call back on a zero timer, and @noble's ML-KEM runs synchronously. crypto.subtle is different. Node
// runs digest, HKDF, AES-GCM and importKey on its thread pool, so each one resolves after however long the
// machine takes, and a loaded machine takes longer than ten zero-timer turns. That is how a panel that
// opens a master capsule (src/lib/keydecap.ts) or an envelope (src/lib/envelope.ts) came back with its
// assertion read before the key was recovered: validate-break-glass-prune failed that way under a busy
// validate and passed on its own. So every Web Crypto call is counted while it is in flight, and a flush
// does not end while one is. The work queued behind a finished call is ticks again, which the rounds
// below already bound on any machine, so a flush ends only after a full pass of rounds in which no call
// was in flight, started or settled.
let subtleInFlight = 0;
let subtleActivity = 0;
function trackSubtle(): void {
  const subtle = (globalThis as unknown as { crypto?: { subtle?: Record<string, unknown> } }).crypto?.subtle;
  if (subtle === undefined || (subtle as { __dpTracked?: boolean }).__dpTracked === true) return;
  for (const name of ["encrypt", "decrypt", "sign", "verify", "digest", "generateKey", "deriveKey", "deriveBits", "importKey", "exportKey", "wrapKey", "unwrapKey"]) {
    const original = subtle[name];
    if (typeof original !== "function") continue;
    Object.defineProperty(subtle, name, {
      configurable: true,
      writable: true,
      value(this: unknown, ...args: unknown[]): unknown {
        const result = (original as (...a: unknown[]) => unknown).apply(subtle, args);
        if (result instanceof Promise) {
          subtleInFlight++;
          subtleActivity++;
          // then(done, done), not finally(): a rejected call must stay the caller's to handle, and a
          // finally() chain would re-raise the rejection as an unhandled one of its own.
          const done = (): void => {
            subtleInFlight--;
            subtleActivity++;
          };
          result.then(done, done);
        }
        return result;
      },
    });
  }
  Object.defineProperty(subtle, "__dpTracked", { value: true });
}
trackSubtle();

// The ceiling on a single flush while Web Crypto work is in flight. It is a hang guard, not a pace: a
// flush ends as soon as nothing is in flight and the rounds have drained, so this is only ever reached by
// a call that never settles, and the assertion after the flush then reports that.
const FLUSH_CEILING_MS = 120_000;

// flushAsync drains microtasks + a few macrotask ticks so queued focus (queueMicrotask in
// openOverlay) and any setTimeout-based UI settle before the test reads state, and it keeps draining
// while any Web Crypto call is still in flight (see trackSubtle above).
export async function flushAsync(rounds = 10): Promise<void> {
  const started = Date.now();
  for (;;) {
    const activityBefore = subtleActivity;
    for (let i = 0; i < rounds; i++) {
      await Promise.resolve();
      await new Promise<void>((r) => setTimeout(r, 0));
    }
    const quiet = subtleInFlight === 0 && subtleActivity === activityBefore;
    if (quiet || Date.now() - started > FLUSH_CEILING_MS) return;
    if (subtleInFlight > 0) await new Promise<void>((r) => setTimeout(r, 1));
  }
}
