// A break-glass ROTATION cannot offer to apply the new public key until the new private key has actually
// reached the customer's disk.
//
// WHY THIS IS A LOCKOUT AND NOT A COPY DEFECT. rotation.ts called downloadText twice and discarded both
// return values, and downloadText is a total function whose whole purpose is to answer whether the browser
// accepted the delivery. So a browser that REFUSED to write identity.key raised its warn toast, the toast
// ended "then use the download control again", and the screen it was raised on had no download control at
// all. The very next thing that screen offered was "Apply to your engine". Take it, and the engine wraps
// every archive sealed from then on to a public key whose private half never left the tab: the old
// identity.key opens only what was sealed BEFORE the rotation, so the archives written after it have no
// holder at all. That is precisely the state a break-glass mechanism exists to prevent.
//
// WHAT IS ASSERTED HERE. Both directions, through the REAL production path: the real renderRotationWiring,
// the real downloadText in keys/shared.ts, and the real deliverFile in lib/file-delivery.ts. The browser's
// answer is controlled at the only place the console can observe it, URL.createObjectURL, which is exactly
// what deliverFile's try block turns into its boolean. Nothing here re-implements the thing under test.
//
import { readFileSync } from "node:fs";

let failures = 0;
function ok(what: string, cond: boolean): void {
  if (cond) {
    console.log(`  ok   ${what}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${what}`);
}

const { installDomShim, textOf, qsa } = await import("./dom-shim.ts");
installDomShim();

const { renderRotationWiring } = await import("../src/screens/keys/rotation.ts");

// A ceremony result shaped exactly like runKeyCeremony's, with placeholder material. No real key is
// generated and none is needed: this file tests the GATE, and the values only have to be strings.
const fresh = {
  breakGlass: { identityB64: "AAAA", recipientPublicB64: "BBBB", fingerprint: "dpr1:new-break-glass" },
  operational: null,
  signer: { privateB64: "CCCC", publicB64: "DDDD", fingerprint: "edmldsa1:signer" },
};
const engine = {} as never;

// acceptDownloads decides what the BROWSER does, at the one seam deliverFile actually reads. Setting it
// true gives a working object URL and the anchor click succeeds; false makes createObjectURL throw, which
// is the refusal deliverFile catches and reports as false.
function acceptDownloads(accept: boolean): void {
  (globalThis as { URL: { createObjectURL?: unknown; revokeObjectURL?: unknown } }).URL.createObjectURL = accept
    ? () => "blob:rotation-test"
    : () => { throw new Error("the browser declined the download"); };
  (globalThis as { URL: { revokeObjectURL?: unknown } }).URL.revokeObjectURL = () => {};
}

// The apply surface, named by the things a customer could actually press. The token field and the apply
// button are the console's own apply; the wrangler command is the second one, and a customer who ran it
// by hand would be just as locked out, so it must be absent too.
function applyControlsPresent(root: unknown): boolean {
  const text = textOf(root as never);
  const hasTokenField = qsa(root as never, '[data-dp="keys.password.token"]').length > 0;
  const hasApplyButton = qsa(root as never, '[data-dp="keys.button.apply"]').length > 0;
  const hasWrangler = /wrangler secret put BREAK_GLASS_PUBLIC/.test(text);
  return hasTokenField || hasApplyButton || hasWrangler;
}

console.log("-- a refused download blocks the apply, and says what to do --");
{
  acceptDownloads(false);
  const wiring = renderRotationWiring(engine, fresh, false);
  const text = textOf(wiring as never);

  ok("no apply control of any kind is rendered", !applyControlsPresent(wiring));
  ok("the block is named as a hold rather than left as an absence", /held until the new identity\.key is saved/i.test(text));
  ok("it states the consequence, not just the refusal", /locked to a private key you do not hold/i.test(text));
  ok("it names the remedy the customer can act on", /download settings/i.test(text) && /download control above/i.test(text));
  ok("it says nothing has been applied, so the customer is not left guessing at the engine's state", /Nothing has been applied/i.test(text));
  ok("and it says the existing break-glass key still works, which is the difference from a first ceremony", /existing break-glass key still works/i.test(text));

  // THE CONTROL THE REFUSAL COPY REFERS TO. downloadText's toast ends "then use the download control
  // again"; before this fix there was none on this screen.
  ok("a real download control for the private half exists", qsa(wiring as never, '[data-dp="keys.button.download-identity"]').length === 1);
  ok("and one for the public half beside it", qsa(wiring as never, '[data-dp="keys.button.download-recipient"]').length === 1);
}

console.log("\n-- and the same control lifts the block once the browser accepts --");
{
  acceptDownloads(false);
  const wiring = renderRotationWiring(engine, fresh, false);
  ok("precondition: blocked", !applyControlsPresent(wiring));

  // A SECOND REFUSAL DOES NOT UNBLOCK. This is the assertion that separates honouring the boolean from
  // merely counting clicks: pressing the control again while the browser still refuses must change nothing.
  const dlBtn = qsa(wiring as never, '[data-dp="keys.button.download-identity"]')[0] as { click: () => void };
  dlBtn.click();
  ok("a second refused download still leaves no apply control", !applyControlsPresent(wiring));
  ok("and the status line says the apply is still held", /still held/i.test(textOf(wiring as never)));

  acceptDownloads(true);
  dlBtn.click();
  ok("a download the browser accepts mounts the token field", qsa(wiring as never, '[data-dp="keys.password.token"]').length === 1);
  ok("and the apply button", qsa(wiring as never, '[data-dp="keys.button.apply"]').length === 1);
  ok("and the wrangler alternative, which is an apply too", /wrangler secret put BREAK_GLASS_PUBLIC/.test(textOf(wiring as never)));
  ok("the hold copy is gone once it is lifted", !/held until the new identity\.key is saved/i.test(textOf(wiring as never)));
  ok("and the customer is told to move the file offline and keep the old key", /offline storage/i.test(textOf(wiring as never)) && /old identity\.key/i.test(textOf(wiring as never)));
}

console.log("\n-- NEGATIVE CONTROL: a download that succeeded at generation is not made to click twice --");
{
  acceptDownloads(true);
  const wiring = renderRotationWiring(engine, fresh, true);
  ok("the apply is mounted immediately", qsa(wiring as never, '[data-dp="keys.button.apply"]').length === 1);
  ok("no hold is shown", !/held until the new identity\.key is saved/i.test(textOf(wiring as never)));
  ok("the new fingerprint is still shown, so the gate removed nothing an operator needs", /dpr1:new-break-glass/.test(textOf(wiring as never)));

  // A LATER REFUSED RE-DOWNLOAD MUST NOT UN-SAVE A FILE THAT ALREADY REACHED THE DISK. One successful
  // delivery is the condition, and re-blocking here would strand a customer who simply pressed the control
  // again out of caution.
  acceptDownloads(false);
  (qsa(wiring as never, '[data-dp="keys.button.download-identity"]')[0] as { click: () => void }).click();
  ok("negative control: a refused RE-download does not tear the apply back down", qsa(wiring as never, '[data-dp="keys.button.apply"]').length === 1);
}

console.log("\n-- the generation path forwards the verdict rather than discarding it --");
{
  const src = readFileSync(new URL("../src/screens/keys/rotation.ts", import.meta.url), "utf8");
  // The original defect, asserted directly: the call was a bare statement and the boolean fell on the floor.
  ok("the identity.key delivery result is bound", /const identityDelivered = downloadText\("identity\.key"/.test(src));
  ok("and handed to the wiring rather than a literal", /renderRotationWiring\(engine, fresh, identityDelivered\)/.test(src));
  ok("no call site passes a hardcoded true", !/renderRotationWiring\([^)]*,\s*true\)/.test(src));
  // The success toast used to fire even when the save had just been refused, on top of the warn toast that
  // said so.
  ok("the save-it-offline toast is conditional on the save having happened", /if \(identityDelivered\) \{/.test(src));

  // THE RELOAD QUESTION, ANSWERED STRUCTURALLY. A per-session flag that outlives its key would be a trap of
  // its own: reload, the flag says delivered, the key is gone, and the apply is open over nothing. It cannot
  // happen here because the flag is a parameter of the same closure that holds the only copy of the key, and
  // nothing in this file persists either. These two assertions are what keep that true.
  ok("rotation.ts never writes the ceremony store, so no delivered state can outlive the key", !/setCeremony|localStorage|sessionStorage/.test(src));
  ok("the output region is rebuilt empty on every render, so a navigation drops the wiring with the key", /const rotateOut = h\("div"\);/.test(src));
}

if (failures > 0) process.exitCode = 1;
if (failures > 0) {
  console.error(`\nvalidate-rotation-download-gate: ${failures} FAILED`);
  process.exit(1);
}
console.log("\nROTATION DOWNLOAD GATE PASSES");
