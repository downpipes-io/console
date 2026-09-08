// Three screens offered a combination the ENGINE refuses, or a value the screen's own rule had already
// marked bad, so the operator's work was lost at submit rather than prevented at entry. This validator
// drives each of the three through the real component under the shared DOM shim and asserts the
// CUSTOMER-VISIBLE outcome: what the operator sees, and whether a request was built at all.
//
//   node test/validate-refused-combinations.ts
//
// The assertions are deliberately on TEXT and on whether the send/post happened, not on structure, because
// a check that asserts a control exists while ignoring what it says can pass on a broken tree too. Each
// block below therefore states the value driven in, and reads back the sentence the operator gets and the
// count of requests built.
//
//   1. The custodian-name Send button. The field carries atMostChars(120) and the Send handler read the
//      raw value and posted it anyway, so a 121-character name showed a red inline error AND was sent.
//      The engine does NOT refuse it: cleanLabel (engine/src/admin/router-custody.ts:39) truncates to 120
//      in silence, so the custodian received a cut name while both sides reported success.
//   2. The credentials screen's No-expiry checkbox. The engine refuses a certificate or a licence with no
//      expiresAt (engine/src/admin/expiry.ts:394-395). The box was offered ungated for all five kinds.
//      The rule covers LICENCE as well as certificate, which the report of this defect did not, so both
//      are driven here.
//   3. The public-client tick on an OAuth2 provider tile. There is no value the console could post
//      instead: the preset create path always attaches a secretRef and validateOauth2 derives pkce_public
//      only when secretRef is absent, so an OAuth2 public client is unreachable and the tick can only
//      produce a 400. The OIDC tiles are the positive control: the tick must stay offered there.
//
// House style: Australian English, no em dashes, no rule-of-three, no AI attribution.

import { installDomShim, qs, qsa, textOf, flushAsync, type ShimNode } from "./dom-shim.ts";

installDomShim();

const { renderCustodyStep } = await import("../src/components/custody-step.ts");
const keygen = await import("../src/keygen.ts");
const { openItemForm } = await import("../src/screens/credentials/forms.ts");
const { presetForm } = await import("../src/screens/idp-connections/forms.ts");

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

function fire(el: ShimNode, type: string): void {
  el.dispatchEvent({ type, target: el, currentTarget: el, defaultPrevented: false, bubbles: true, preventDefault() {}, stopPropagation() {} });
}
function setValue(root: ShimNode, id: string, value: string): ShimNode {
  const el = qs(root, `#${id}`)!;
  el.value = value;
  fire(el, "input");
  return el;
}

// ---- 1. A custodian name the field has already marked too long is NOT sent ---------------------

{
  const result = await keygen.runKeyCeremony({ operational: false });
  const rec: { posted: { toEmail: string; custodianLabel?: string } | null } = { posted: null };
  const root = renderCustodyStep({
    result,
    onChange: () => {},
    downloadText: () => true,
    sendShare: async (input) => { rec.posted = input; return { sent: true }; },
  }) as unknown as ShimNode;

  const splitRadio = qs(root, "#custody-scheme-mofn-split")!;
  splitRadio.checked = true;
  fire(splitRadio, "change");
  setValue(root, "custody-split-n", "3");
  setValue(root, "custody-split-threshold", "2");
  qsa(root, "button").find((b) => textOf(b).includes("Encrypt and split in this browser"))!.click();
  await flushAsync();

  qsa(root, "button").filter((b) => textOf(b).trim() === "Email")[0]!.click();
  setValue(root, "custody-share-email-1", "alex@corp.example");
  const labelEl = setValue(root, "custody-share-emaillabel-1", "A".repeat(121));
  fire(labelEl, "blur");

  ok("a 121-character custodian name is marked invalid at the field", labelEl.getAttribute("aria-invalid") === "true");

  const sendBtn = qsa(root, "button").find((b) => textOf(b).trim() === "Send this share")!;
  sendBtn.click();
  await flushAsync();

  // Without the fix, the send would go ahead with all 121 characters.
  ok("Send does NOT post a name the field has already refused", rec.posted === null);
  const panel = textOf(qs(root, ".custody-share-email")!);
  ok("the operator is told nothing was sent, rather than being told it was emailed", panel.includes("nothing was sent") && !panel.includes("Emailed to alex@corp.example"));

  // The positive control: a name WITHIN the bound still sends, so the gate is not simply off.
  setValue(root, "custody-share-emaillabel-1", "Alex Chen, Security");
  sendBtn.click();
  await flushAsync();
  ok("a name within the bound still sends", rec.posted !== null && rec.posted.custodianLabel === "Alex Chen, Security");
}

// ---- 2. No expiry is refused at entry for a certificate and for a licence ----------------------

{
  // The engine's own answer, transcribed from engine/src/admin/expiry.ts:394-395, so the stub refuses
  // exactly what the engine refuses rather than accepting whatever the console sends.
  const posted: Array<Record<string, unknown>> = [];
  const engineStub = {
    upsertExpiryItem: async (input: Record<string, unknown>) => {
      posted.push(input);
      if (input.expiresAt === undefined && (input.kind === "certificate" || input.kind === "licence")) {
        throw new Error("expiresAt is required for a certificate or licence");
      }
      return { status: "ok" };
    },
  } as never;
  const doc = (globalThis as unknown as { document: { body: ShimNode } }).document;

  for (const kind of ["certificate", "licence"]) {
    posted.length = 0;
    openItemForm(engineStub, null, () => {});
    const root = doc.body;
    setValue(root, "expiry-label", `probe ${kind}`);

    // The order an operator actually reaches this in: the form opens on Credential, they tick No expiry,
    // and only then choose the kind. A gate applied at open alone would miss this entirely, and it is the
    // path that produced the 400, so it is the path driven.
    const box = qs(root, "#expiry-noexpiry")!;
    box.checked = true;
    fire(box, "change");
    const kindEl = qs(root, "#expiry-kind")!;
    kindEl.value = kind;
    fire(kindEl, "change");

    // Without the fix, the box was offered, tickable, on every kind, and switching to a kind the engine
    // refuses left the tick standing.
    ok(`${kind}: the No-expiry box is announced as refused`, box.getAttribute("aria-disabled") === "true");
    ok(`${kind}: the reason names the rule rather than leaving the operator to guess`,
      textOf(root).includes("always carries an expiry date") && textOf(root).includes("No expiry"));
    // Re-queried rather than read off `box`: the compiler keeps the narrowing from the assignment above,
    // because it cannot see the change listener run, so `box.checked === false` reads as always-false and
    // would prove nothing (the same trap documented in test/cov/components-custody-step.ts).
    ok(`${kind}: choosing the kind clears a tick the engine would refuse`, qs(root, "#expiry-noexpiry")!.checked === false);

    qsa(root, "button").find((b) => textOf(b).trim() === "Track item")!.click();
    await flushAsync();
    await flushAsync();
    ok(`${kind}: no request the engine would refuse is built`, posted.length === 0);
    ok(`${kind}: the operator is asked for the date instead`, textOf(root).includes("Choose the expiry date"));
    const cancel = qsa(root, "button").find((b) => textOf(b).trim() === "Cancel");
    if (cancel) cancel.click();
    await flushAsync();
  }

  // The positive control: a credential may still be no-expiry, so the gate is on the kind and not on the box.
  posted.length = 0;
  openItemForm(engineStub, null, () => {});
  const root = doc.body;
  setValue(root, "expiry-label", "probe credential");
  const kindEl = qs(root, "#expiry-kind")!;
  kindEl.value = "credential";
  fire(kindEl, "change");
  const box = qs(root, "#expiry-noexpiry")!;
  ok("credential: the No-expiry box is still offered", box.getAttribute("aria-disabled") !== "true");
  box.checked = true;
  fire(box, "change");
  qsa(root, "button").find((b) => textOf(b).trim() === "Track item")!.click();
  await flushAsync();
  await flushAsync();
  ok("credential: a no-expiry credential still saves", posted.length === 1 && posted[0]!.noExpiry === true);
}

// ---- 3. The public-client tick is not offered on an OAuth2 tile --------------------------------

{
  const engineStub = {
    createIdpConnection: async () => ({ value: { ok: true, conn: {} } }),
    idpRedirectUri: (id: string) => `https://example.invalid/callback/${id}`,
  } as never;
  const mkPreset = (id: string, kind: string, label: string) => ({ id, label, vendor: label, buttonLabel: `Sign in with ${label}`, kind, requiredVars: [], notes: [] });

  for (const [id, label] of [["github", "GitHub"], ["generic-oauth2", "Generic OAuth2"]] as const) {
    const root = presetForm(engineStub, mkPreset(id, "oauth2", label) as never, () => {}) as unknown as ShimNode;
    const box = qs(root, "#idp-public-client")!;
    // Without the fix, the tick was offered on every tile.
    ok(`${id}: the public-client tick is announced as refused`, box.getAttribute("aria-disabled") === "true");
    ok(`${id}: the reason says it is an OAuth2 connection and points at the secret`,
      textOf(root).includes("is an OAuth2 connection") && textOf(root).includes("Enter the client secret below"));
    // The over-fix guard: refusing the tick must not also take away the field the reason sends them to.
    ok(`${id}: the client-secret field stays on screen`, qs(root, "#idp-secret") !== null);
  }

  // The positive control: an OIDC tile must keep offering it, so the gate is on the connection kind and
  // not simply on the checkbox. Without this, deleting the checkbox outright would pass every assertion
  // above.
  const oidcRoot = presetForm(engineStub, mkPreset("okta", "oidc", "Okta") as never, () => {}) as unknown as ShimNode;
  const oidcBox = qs(oidcRoot, "#idp-public-client")!;
  ok("okta (OIDC): the public-client tick is still offered", oidcBox.getAttribute("aria-disabled") !== "true");
  ok("okta (OIDC): no OAuth2-only refusal is shown on an OIDC tile", !textOf(oidcRoot).includes("is an OAuth2 connection"));
}

// ---- 4. An endpoint the engine's own shape checks refuse is refused at entry ------------------
//
// The engine's shape checks on POST /admin/destination refuse:
//   "https://"      -> 400 "the destination endpoint must be an https URL"   (the PATTERN, router-destinations.ts:71)
//   "https://["     -> 400 "the destination endpoint must be a valid https URL" (the new URL() catch, :85)
//   "https://%zz"   -> 400 the same
// The pattern refuses the first of these before new URL() is ever reached, which is why the values that
// DO reach new URL() are driven here as well.

{
  const { buildS3Block } = await import("../src/screens/destination-form-fields.ts");
  const s3 = buildS3Block({ confirmReplace: false, onSaved: () => {} }) as unknown as { block: ShimNode; endpointField: { validate(): boolean; control: ShimNode } };
  const ep = qs(s3.block as ShimNode, "#dest-endpoint")!;
  const drive = (value: string): { valid: boolean; text: string } => {
    ep.value = value;
    fire(ep, "input");
    const valid = s3.endpointField.validate();
    return { valid, text: textOf(s3.block as ShimNode) };
  };

  // Without the fix, startsWith("https://") accepted all three.
  const bare = drive("https://");
  ok("an endpoint with no host is refused at entry", !bare.valid);
  ok("the reason asks for a host rather than restating the scheme", bare.text.includes("https URL with a host"));
  ok("an endpoint with a stray bracket is refused at entry", !drive("https://[").valid);
  ok("an endpoint with an unfinished escape is refused at entry", !drive("https://%zz").valid);

  // The positive control: a real endpoint still passes, so the gate is on the shape and not simply on.
  ok("a real endpoint is still accepted", drive("https://s3.example.com").valid);
  ok("an R2 endpoint is still accepted", drive("https://acct.r2.cloudflarestorage.com").valid);
  // The over-fix guard: the console must NOT claim the host is internal or that the bucket is reachable.
  // It cannot resolve a host, so a private-looking host stays accepted here and is refused by the engine.
  ok("a private-looking host is left to the engine, not guessed at here", drive("https://192.168.0.10").valid);
}

// ---- 5. A licence token that is not the engine's shape is refused at entry --------------------
//
// POST /admin/licence. The engine's shape gate is engine/src/admin/router-updates.ts:221, and it runs
// BEFORE any verify:
//   "x", "not a token", "abc.def.ghi" (THREE parts), 30000 chars -> 400 "that does not look like a licence token"
//   "abc.def" -> passes the shape, 400 {"reasonCode":"decode"} from the verify

{
  const { activationSection } = await import("../src/screens/licence/activation.ts");
  const engineStub = { activateLicence: async () => ({ ok: true }) } as never;
  const section = activationSection(engineStub, { tier: "community", source: "none" } as never, () => {}, "licence-card-heading") as unknown as ShimNode;
  const tok = qs(section, "#licence-token")!;
  const driveToken = (value: string): boolean => {
    tok.value = value;
    fire(tok, "blur");
    return tok.getAttribute("aria-invalid") !== "true";
  };

  // Without the fix, the rule was v.length >= 1, so every one of these passed.
  ok("a single character is not taken as a licence token", !driveToken("x"));
  ok("prose is not taken as a licence token", !driveToken("not a token"));
  ok("a THREE-part dot-joined value is refused, which the engine also refuses", !driveToken("abc.def.ghi"));
  ok("a paste beyond the engine's 20000-character bound is refused", !driveToken("a".repeat(20001)));
  ok("the reason says the paste has the wrong SHAPE, never that the licence is invalid",
    textOf(section).includes("does not have the shape of a licence token") && !textOf(section).includes("is not a valid licence"));

  // The positive control: a two-part token passes the console, because whether it VERIFIES is the engine's
  // answer and the console holds no key to give one.
  ok("a two-part token is accepted by the form and left to the engine to verify", driveToken("eyJhbGciOiJFZERTQSJ9.c2lnbmF0dXJl-x_y"));
  ok("the engine's own 20000-character bound is the console's, not a tighter guess", driveToken(`${"a".repeat(19990)}.bcde`));
}

// ---- 6. A connection id this engine already holds is refused at entry -------------------------
//
// Driven with the FLAT preset body the console really posts: POST /admin/idp/connections twice with the
// same id answers 200 {ok:true} and then 200 {ok:false,reason:'a connection with id "okta-prod" already
// exists'}, from engine/src/admin/idpconn.ts:59. Both add forms PRE-FILL the id, so "Add another Okta"
// opens a form already holding the taken value.

{
  const engineStub = {
    createIdpConnection: async () => ({ value: { ok: true, conn: {} } }),
    idpRedirectUri: (id: string) => `https://example.invalid/callback/${id}`,
  } as never;
  const okta = { id: "okta", label: "Okta", vendor: "Okta", buttonLabel: "Sign in with Okta", kind: "oidc", requiredVars: [], notes: [] };
  const taken = new Set(["okta", "okta-prod"]);

  const root = presetForm(engineStub, okta as never, () => {}, taken) as unknown as ShimNode;
  const idEl = qs(root, "#idp-id")!;
  const driveId = (value: string): boolean => {
    idEl.value = value;
    fire(idEl, "blur");
    return idEl.getAttribute("aria-invalid") !== "true";
  };

  // Without the fix, the form opened on the taken id and said nothing.
  ok("the pre-filled id is announced as taken the moment the form is validated", !driveId("okta"));
  ok("the reason names the id and asks for a different one",
    textOf(root).includes('already has a connection with the id "okta"') && textOf(root).includes("different id"));
  ok("a second taken id is refused too", !driveId("okta-prod"));

  // The positive control: a free id still passes, so the gate is on the collision and not on the field.
  ok("a free id is still accepted", driveId("okta-uat"));
  // And the shape half must survive the rewrite: the engine refuses a leading hyphen too.
  ok("the shape rule still refuses a leading hyphen", !driveId("-okta"));

  // WHERE THE CONSOLE CANNOT KNOW, IT SAYS NOTHING. The screen passes null when the connections payload
  // carried no list at all, and a collision rule applied to a set the console does not have would refuse a
  // free id. Without this, passing an empty Set on an unread load would look identical and be wrong.
  const blind = presetForm(engineStub, okta as never, () => {}, null) as unknown as ShimNode;
  const blindId = qs(blind, "#idp-id")!;
  blindId.value = "okta";
  fire(blindId, "blur");
  ok("with no readable connection list the form makes no collision claim", blindId.getAttribute("aria-invalid") !== "true");

  // AND A CALLER THAT SIMPLY DOES NOT PASS THE SET MUST LAND ON THE SAME "I do not know", not throw.
  // The first cut of this made the parameter required; typecheck was clean and the validate chain then
  // died inside the validator on an existing three-argument call, taking the whole run down. An absent
  // argument is the commonest way a console screen says nothing, so it is driven here.
  let threw = false;
  let free = false;
  try {
    const unsaid = (presetForm as unknown as (a: unknown, b: unknown, c: unknown) => ShimNode)(engineStub, okta as never, () => {});
    const unsaidId = qs(unsaid, "#idp-id")!;
    unsaidId.value = "okta-uat";
    fire(unsaidId, "blur");
    free = unsaidId.getAttribute("aria-invalid") !== "true";
  } catch {
    threw = true;
  }
  ok("a caller that passes no set at all neither throws nor refuses a free id", !threw && free);
}

// ---- 4. The class the sweep found: a validate rule NO submit path runs -------------------------
//
// 83 console controls carry their own `validate:` rule. Driving the residue through the engine showed the
// same shape six times over: the field marks the value bad, the operator sees the error, and the submit
// path reads the raw value and builds the request anyway. Where the engine's rule is LOOSER (it usually
// is) the refused value is then stored exactly as typed; where the engine normalises, the customer keeps
// a different value from the one they typed. Each block below asserts the CUSTOMER-VISIBLE outcome: the
// sentence shown, and whether a request was built at all.

{
  const { builderBody } = await import("../src/screens/roles-builder/form.ts");
  const created: Array<Record<string, unknown>> = [];
  const engineStub = { createCustomRole: async (p: Record<string, unknown>) => { created.push(p); return { status: "ok", value: { label: String(p.label) } }; } } as never;
  const root = builderBody(engineStub, [], () => {}) as unknown as ShimNode;

  const nameEl = setValue(root, "builder-name", "KV-Restorer");
  fire(nameEl, "blur");
  ok("a role name with an uppercase letter is marked invalid at the field", nameEl.getAttribute("aria-invalid") === "true");

  // Without the fix, onInput wrote `state.name = v.trim().toLowerCase()`, and the Save gate composes its
  // proposal from `state`, never from this control, so the builder was already holding a DIFFERENT name
  // from the one on screen and would have saved it.
  //
  // The draft is the observable, and it is the right one: form.ts:119 persists composeProposal(state), the
  // very object the create posts, so reading it asserts on the PAYLOAD rather than on any rendering of it.
  // A create-count assertion would have passed on the broken tree for the wrong reason (no capability is
  // ticked, so the save is refused either way), and an assertion that passes on the broken tree is not a
  // test. Ticking one needs the surface redraw, which calls replaceWith and the shim does not carry it.
  const { loadDraft } = await import("../src/lib/draft.ts");
  const { ROLE_DRAFT } = await import("../src/screens/roles-builder/shared.ts");
  const draft = loadDraft<{ name?: string }>(ROLE_DRAFT);
  ok("the builder does not hold a silently lowercased copy of the name the field refused", draft?.name !== "kv-restorer");
  ok("what a save would post is the name the operator actually typed", draft?.name === "KV-Restorer");
  ok("the create stub was never called while the name stands refused", created.length === 0);
}

{
  const { readPricing } = await import("../src/screens/destination-submit.ts");
  // readPricing is the reader the submit path uses. Its `coerced` list is the console's own signal that a
  // rate the operator TYPED could not be read, and the fix refuses on it instead of substituting. Driven
  // here at the reader, because that list is the whole discriminator and it is what submit now branches on.
  const mkField = (raw: string, bad: boolean) => ({ value: () => raw, badInput: () => bad }) as never;
  const ctx = {
    storageField: mkField("", true), // the number input ate "$0.015"
    classAField: mkField("4.50", false),
    classBField: mkField("0.36", false),
    egressField: mkField("-1", false), // a negative rate, the other reachable coercion
    currencyField: mkField("USD", false),
    pricingState: { edited: true },
  } as never;
  const { coerced } = readPricing(ctx, "r2");
  ok("an eaten rate and a negative rate both surface as coerced, which submit now refuses on", coerced.includes("dest-price-storage") && coerced.includes("dest-price-egress"));
  ok("a rate that reads cleanly is not reported as coerced", !coerced.includes("dest-price-classa"));

  // The over-fix guard: an EMPTY box the operator left empty is the ordinary "use the preset" choice and
  // must NOT be refused, or every destination saved without custom rates would be blocked.
  const empty = readPricing({ ...(ctx as unknown as Record<string, unknown>), storageField: mkField("", false), egressField: mkField("", false) } as never, "r2");
  ok("an empty rate box is still the ordinary use-the-preset choice, not a refusal", empty.coerced.length === 0);

  // FIXED, and the fix was the CONTRACT rather than the branch. submitDestination used to save the
  // PRESET after readPricing reported the coercion and tell the operator "Destination verified and saved", so
  // every cost estimate from then on ran on a rate the customer did not choose -- stored under
  // `source: "operator"`, which asserts it WAS their contracted rate. It now runs the console's own rule on
  // these four controls at submit and refuses. The states, the customer-visible text and the evidence that
  // replaced the silently-coerced row are driven end to end in validate-support-posture-gaps-5.ts, whose G240
  // section was rewritten in the same change and says what it now asserts and why.
  //
  // WHAT THIS BLOCK STILL EARNS is the half that suite deliberately does not: it drives the READER, whose
  // `coerced` list is stated independently of the rule that refuses. The two must agree, and this is where a
  // future loosening of either one shows up.
  ok("the reader still names every rate a save would have swapped, which is what submit refuses on", coerced.length === 2);
}

console.log(failures === 0 ? "\nrefused-combination gates: PASS" : `\nrefused-combination gates: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
