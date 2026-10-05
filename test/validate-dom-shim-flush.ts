// flushAsync (test/dom-shim-bridges.ts) must not return while a Web Crypto call is still in flight.
//
// WHY THIS EXISTS. The shared flush used to drain a fixed ten event-loop turns. Every other piece of work
// a shimmed screen awaits is a microtask or a zero timer, so ten turns bound it on any machine. Web Crypto
// is the exception: Node runs digest, HKDF, AES-GCM and importKey on its thread pool, and a loaded machine
// finishes them after more turns than that. validate-break-glass-prune.ts failed that way under a busy
// validate (the recovered-master assertion read before the capsule was opened) and passed on its own.
//
// HOW THIS GRADES IT WITHOUT DEPENDING ON THE MACHINE. Web Crypto is made slow on purpose, by a fixed
// delay far longer than ten turns take, before the shim is loaded, so the shim's tracking wraps the slow
// calls exactly as it wraps real ones. The assertion is about ORDER, not time: when flushAsync returns,
// the slow call has settled. Nothing here asserts that anything was fast.
//
// Run: node test/validate-dom-shim-flush.ts

import { verdictReached } from "./lib/verdict-guard.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

const SLOW_MS = 1500;
const subtle = globalThis.crypto.subtle as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
for (const name of ["digest", "importKey", "decrypt"]) {
  const original = subtle[name]!;
  Object.defineProperty(subtle, name, {
    configurable: true,
    writable: true,
    value: (...a: unknown[]) => original.apply(globalThis.crypto.subtle, a).then((v) => new Promise((r) => setTimeout(() => r(v), SLOW_MS))),
  });
}

async function main(): Promise<void> {
  // Loaded AFTER the slow wrapper, so the shim tracks the slow calls.
  const { flushAsync } = await import("./dom-shim-bridges.ts");

  console.log("-- a flush waits for a Web Crypto call in flight --");
  {
    let settled = false;
    void globalThis.crypto.subtle.digest("SHA-384", new Uint8Array([1, 2, 3])).then(() => {
      settled = true;
    });
    await flushAsync();
    ok("the digest had settled by the time flushAsync returned", settled);
  }

  console.log("\n-- work queued behind the call is drained too --");
  {
    let rendered = false;
    void globalThis.crypto.subtle
      .digest("SHA-384", new Uint8Array([4, 5, 6]))
      .then(() => new Promise<void>((r) => setTimeout(r, 0)))
      .then(() => {
        rendered = true;
      });
    await flushAsync();
    ok("a zero-timer step after the call had run by the time flushAsync returned", rendered);
  }

  console.log("\n-- a chain of calls is waited for, one after another --");
  {
    let opened = false;
    void (async () => {
      const key = await globalThis.crypto.subtle.importKey("raw", new Uint8Array(32), "AES-GCM", false, ["decrypt"]);
      await globalThis.crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(12) }, key, new Uint8Array(16)).catch(() => undefined);
      opened = true;
    })();
    await flushAsync();
    ok("importKey then decrypt had both settled by the time flushAsync returned", opened);
  }

  console.log("\n-- a rejected call stays the caller's to handle --");
  {
    let unhandled = 0;
    const onUnhandled = (): void => {
      unhandled++;
    };
    process.on("unhandledRejection", onUnhandled);
    let caught = false;
    void globalThis.crypto.subtle
      .decrypt({ name: "AES-GCM", iv: new Uint8Array(12) }, await globalThis.crypto.subtle.importKey("raw", new Uint8Array(32), "AES-GCM", false, ["decrypt"]), new Uint8Array(16))
      .catch(() => {
        caught = true;
      });
    await flushAsync();
    process.off("unhandledRejection", onUnhandled);
    ok("the caller's catch ran", caught);
    ok("the tracking raised no unhandled rejection of its own", unhandled === 0);
  }

  verdictReached(failures);
  if (failures > 0) {
    console.error(`\n${failures} FAILURE(S)`);
    process.exit(1);
  }
  console.log("\nFLUSH WAITS FOR WEB CRYPTO");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
