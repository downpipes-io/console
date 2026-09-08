// An R2 destination must be pointable at an account OTHER than the engine's,
// without giving up the convenience of discovery naming the engine account. Run with:
//   node test/validate-dest-r2-other-account.ts
//
// WHY THIS EXISTS. buildR2Block renders the Account ID field only when discovery could NOT name the engine
// account, and buildDestinationInput derives the endpoint as `r2Endpoint(fctx.engineAccountId ?? accountId)`.
// The engine account wins whenever it is known, so once a cf-config discovery token is stored (which is
// precisely when discovery succeeds) the destination could only ever be written into the engine's own
// account. There was no field for another account's id, and the credential for that account had nowhere to
// go: the operator pasted an access key for account B and the console posted the endpoint for account A.
//
// The 3-2-1 posture the product sells is the reason this matters: a second copy in the SAME Cloudflare
// account is not a second blast radius, and this form made the second account unreachable from the console.
//
// This file captures the DestinationInput the real submit path posts rather than reading the screen, because
// the screen looked right: it stated "Writes go to <engine-account>.r2.cloudflarestorage.com" the whole time,
// which is true and is not what the operator asked for.
//
// The fix keeps the deliberate simplification. The default is unchanged (no account field, the endpoint
// derived from and stated for the engine account); an explicit "in a different Cloudflare account" tick
// reveals the Account ID and turns the engine-account bucket SELECT back into free text, because the engine
// account's bucket list does not describe another account. Case 1 below fails if the override is removed;
// case 4 fails if the field is simply restored for everyone, which would undo the simplification.
//
// House style: Australian English, no em dashes, no rule-of-three, no AI attribution.

import { activeElement, flushAsync, installDomShim, markConnected, qs, textOf } from "./dom-shim.ts";
import { makeEvent } from "./dom-shim-core.ts";

installDomShim();

import type { Caller, DestinationInput, EngineClient } from "../src/api.ts";
import { installNav } from "../src/lib/nav.ts";
import { connect, setCaller } from "../src/lib/store.ts";
import { destinationForm } from "../src/screens/destination-form.ts";
import type { FormContext } from "../src/screens/destination-form-fields.ts";

installNav({ navigate: () => {}, onUnauthorised: () => {}, refreshIdentity: async () => {}, onAuthenticated: async () => {}, signOut: () => {} });

let failures = 0;
// `measured` is printed only on a failure, and only when the caller supplies it. A cell that says which
// assertion failed but not what it read sends the next reader back to reproduce it by hand.
function ok(label: string, cond: boolean, measured?: string): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}${!cond && measured ? `\n         measured: ${measured}` : ""}`);
  if (!cond) failures++;
}

const ENGINE_ACCOUNT = "0f2ac7c1b6e0470a8f3d1c2b4a5e6f70";
const OTHER_ACCOUNT = "9a8b7c6d5e4f30291827364554637281";

// The owner gate: the save button is disabled-with-reason for anyone else, so the submit path is
// unreachable and every capture below would be empty for a reason unrelated to what this file tests.
setCaller({ method: "access", email: "owner@test", role: "owner", groups: [], isOnlyOwner: true } as unknown as Caller);
connect("https://engine.test");

interface Driven {
  posted: DestinationInput | null;
  accountFieldPresent: boolean;
  bucketIsSelect: boolean;
  endpointNote: string;
}

/**
 * Render the REAL destination form with discovery having named the engine account (the state a stored
 * cf-config discovery token puts every estate in), optionally tick the other-account override, fill the
 * form, and click the real "Verify and save". Returns the DestinationInput the submit path posted.
 */
async function drive(opts: { override: boolean; bucket: string; accountId?: string }): Promise<Driven> {
  let posted: DestinationInput | null = null;
  const engine = {
    addDestination: async (input: DestinationInput) => {
      posted = JSON.parse(JSON.stringify(input)) as DestinationInput;
      return { ok: true } as never;
    },
    getChangePolicy: async () => ({ required: false }),
  } as unknown as EngineClient;

  const fctx: FormContext = {
    engineAccountId: ENGINE_ACCOUNT,
    engineR2Buckets: ["engine-archive"],
    sourceR2Buckets: new Set<string>(),
    discoveryRead: true,
    downpipesRead: true,
  };

  const form = destinationForm(engine, fctx, { confirmReplace: false, onSaved: () => {} });
  document.body.replaceChildren(form);
  markConnected(form);

  if (opts.override) {
    const tick = qs(form as unknown as never, "#dest-r2-other-account") as unknown as { checked: boolean; dispatchEvent: (e: unknown) => boolean } | null;
    if (tick) {
      tick.checked = true;
      tick.dispatchEvent(makeEvent({ type: "change", bubbles: true }));
    }
  }

  // Set AND fire input, the way a keystroke does. The endpoint note and the circular-archive warn both
  // repaint off the input event, so a bare value assignment would read the DOM of a form nobody had typed
  // into and would grade the note against a state the operator never sees.
  const setVal = (sel: string, v: string) => {
    const el = qs(form as unknown as never, sel) as unknown as { value: string; dispatchEvent: (e: unknown) => boolean } | null;
    if (!el) return;
    el.value = v;
    el.dispatchEvent(makeEvent({ type: "input", bubbles: true }));
  };
  setVal("#dest-r2-bucket", opts.bucket);
  if (opts.accountId !== undefined) setVal("#dest-account-id", opts.accountId);
  setVal("#dest-access-key", "AKIAEXAMPLE");
  setVal("#dest-secret", "s3cr3t-example");

  const btn = (qs(form as unknown as never, '[data-dp="destination-form.button.save#1"]') ??
    qs(form as unknown as never, '[data-dp="destination-form.button.save#2"]')) as unknown as { click: () => void } | null;
  if (!btn) throw new Error("the save button did not render");
  btn.click();
  await flushAsync(20);

  const acct = qs(form as unknown as never, "#dest-account-id");
  const bucketEl = qs(form as unknown as never, "#dest-r2-bucket") as unknown as { tagName?: string } | null;
  const noteEl = qs(form as unknown as never, ".dest-r2-endpoint-note");
  const out: Driven = {
    posted,
    accountFieldPresent: acct !== null,
    bucketIsSelect: String(bucketEl?.tagName ?? "").toLowerCase() === "select",
    endpointNote: noteEl ? textOf(noteEl as unknown as never) : "",
  };
  document.body.replaceChildren();
  return out;
}

interface Typed {
  focusedAtStart: boolean;
  stillFocused: boolean;
  activeId: string;
  value: string;
  endpointNote: string;
}

/**
 * Render the real form with the override ticked, put the caret in the Account ID, and type `text` one
 * character at a time the way a keyboard does.
 *
 * A keystroke only reaches the control that HOLDS THE CARET, so typeChars stops as soon as the caret has
 * left. Without that rule the loop would keep writing into a detached node and report a full value the
 * document never held, which is exactly the reading that let this defect through the first time.
 */
async function driveTyping(text: string): Promise<Typed> {
  const engine = {
    addDestination: async () => ({ ok: true }) as never,
    getChangePolicy: async () => ({ required: false }),
  } as unknown as EngineClient;
  const fctx: FormContext = {
    engineAccountId: ENGINE_ACCOUNT,
    engineR2Buckets: ["engine-archive"],
    sourceR2Buckets: new Set<string>(),
    discoveryRead: true,
    downpipesRead: true,
  };
  const form = destinationForm(engine, fctx, { confirmReplace: false, onSaved: () => {} });
  document.body.replaceChildren(form);
  markConnected(form);

  const tick = qs(form as unknown as never, "#dest-r2-other-account") as unknown as { checked: boolean; dispatchEvent: (e: unknown) => boolean } | null;
  if (!tick) throw new Error("the other-account override did not render");
  tick.checked = true;
  tick.dispatchEvent(makeEvent({ type: "change", bubbles: true }));

  const acct = qs(form as unknown as never, "#dest-account-id") as unknown as
    | { value: string; focus: () => void; dispatchEvent: (e: unknown) => boolean }
    | null;
  if (!acct) throw new Error("the override did not reveal the Account ID");
  acct.focus();
  const focusedAtStart = (activeElement() as unknown) === (acct as unknown);

  for (const ch of text) {
    if ((activeElement() as unknown) !== (acct as unknown)) break;
    acct.value = acct.value + ch;
    acct.dispatchEvent(makeEvent({ type: "input", bubbles: true }));
  }

  const live = activeElement() as unknown as { id?: string } | null;
  const noteEl = qs(form as unknown as never, ".dest-r2-endpoint-note");
  const out: Typed = {
    focusedAtStart,
    stillFocused: (live as unknown) === (acct as unknown),
    activeId: String(live?.id ?? "(none)"),
    value: acct.value,
    endpointNote: noteEl ? textOf(noteEl as unknown as never) : "",
  };
  document.body.replaceChildren();
  return out;
}

async function main(): Promise<void> {
  console.log("-- an R2 destination can be pointed at another Cloudflare account (real destinationForm, captured POST) --");

  // Case 1: the defect. Discovery names the engine account; the operator wants account B.
  const other = await drive({ override: true, bucket: "offsite-archive", accountId: OTHER_ACCOUNT });
  ok("the other-account override reveals the Account ID field", other.accountFieldPresent);
  ok("the override turns the engine-account bucket list back into free text", !other.bucketIsSelect);
  ok("a destination was posted with the override on", other.posted !== null);
  ok(
    "the POSTED endpoint is the OTHER account's R2 host, not the engine account's",
    other.posted?.endpoint === `https://${OTHER_ACCOUNT}.r2.cloudflarestorage.com`,
  );
  ok("the POSTED bucket is the one typed for the other account", other.posted?.bucket === "offsite-archive");
  ok(
    "the endpoint note states the account the writes actually go to",
    other.endpointNote.includes(OTHER_ACCOUNT) && !other.endpointNote.includes(ENGINE_ACCOUNT),
  );

  // Case 2: the default is unchanged. Discovery named the account, the operator did not ask for another one.
  const dflt = await drive({ override: false, bucket: "engine-archive" });
  ok("with no override the Account ID field stays absent (the deliberate simplification)", !dflt.accountFieldPresent);
  ok("with no override the bucket stays the discovery-listed select", dflt.bucketIsSelect);
  ok(
    "with no override the POSTED endpoint is still the engine account's, derived not typed",
    dflt.posted?.endpoint === `https://${ENGINE_ACCOUNT}.r2.cloudflarestorage.com`,
  );
  ok("with no override the endpoint note still names the engine account", dflt.endpointNote.includes(ENGINE_ACCOUNT));

  // Case 3: the override is REQUIRED to be filled. A ticked override with an empty account id must refuse at
  // the form rather than fall back to the engine account, which would repoint the archive behind the
  // operator's back at the one account they had just said they did not want.
  const empty = await drive({ override: true, bucket: "offsite-archive", accountId: "" });
  ok("a ticked override with an empty Account ID posts nothing (it never falls back to the engine account)", empty.posted === null);

  // Case 4: the guard against over-fixing. Untick the override and the form must return to the calm default,
  // so a fix that simply restores the field for everyone fails here.
  ok("the default form has no Account ID field to fill, so the override is a choice and not a new chore", !dflt.accountFieldPresent);

  // Case 5: the field the override reveals must be FILLABLE, one keystroke after another.
  //
  // The first four cases all set a value and fired one input event, which is what a script does and not
  // what an operator does. That hid a worse defect than the one this file was written for: the endpoint
  // note repaints off every input event, the repaint remounted the slot holding the focused Account ID,
  // and detaching a focused control drops the caret to the body. Without the fix, a
  // 32-character id typed into the field can leave it holding "9" with document.activeElement on BODY. Every
  // keystroke after the first was thrown away, and neither the screen nor a captured request body says so.
  //
  // typeChars below refuses to keep typing into a control the caret has left, which is the browser's own
  // rule, so the shortfall shows up as a SHORT VALUE rather than as a value the DOM never really held.
  const typed = await driveTyping(OTHER_ACCOUNT);
  ok("the Account ID starts focused, so the run below measures typing and not a missing caret", typed.focusedAtStart);
  ok(
    "every character typed into the revealed Account ID lands in it",
    typed.value === OTHER_ACCOUNT,
    `held ${typed.value.length} of ${OTHER_ACCOUNT.length}: ${JSON.stringify(typed.value)}`,
  );
  ok("the caret is still in the Account ID after the whole id is typed", typed.stillFocused, `activeElement id: ${typed.activeId}`);
  ok(
    "the endpoint note, which repaints on every keystroke, names the fully typed account",
    typed.endpointNote.includes(OTHER_ACCOUNT),
    typed.endpointNote,
  );

  console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILURE(S)`);
  if (failures > 0) process.exitCode = 1;
  process.exit(failures === 0 ? 0 : 1);
}

await main();
