// Validate the PURE helpers of src/lib/webauthn-prf.ts. The WebAuthn credential API is not
// available headless, so the create/get functions are not invoked here; this validates the pure,
// deterministic pieces with the API mocked: the feature-detect decision, the HKDF
// derivation, the PRF extension inputs, and the PRF-result extraction (with a synthetic
// clientExtensionResults object). Run with `node test/validate-webauthn-prf.ts`.
//
// Coverage:
//   detectPRFSupport: the truth table over (hasCredentials, hasPublicKeyCredential,
//     isSecureContext); worthAttempting requires the API AND a secure context, while
//     webauthnApi ignores the secure-context bit
//   readWebAuthnGlobals: degrades to an all-false snapshot under Node (no navigator), and
//     does not throw
//   deriveWrappingKey: deterministic (same secret -> same key), distinct secrets -> distinct
//     keys, fixed 32-byte length regardless of input length, rejects an empty secret, and
//     matches an independent HKDF-SHA-256 reference computed with the documented salt/info
//   prfInputs: requests prf.eval.first == PRF_SALT
//   extractPRFSecret: pulls the first result from an ArrayBuffer and from a typed-array
//     view, and returns null when absent
//   prfEnabledAtCreation: reads prf.enabled
//   enrolmentGuidance: states the >=2-keys, non-exportable reality (and uses no em dash)

import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  detectPRFSupport,
  readWebAuthnGlobals,
  deriveWrappingKey,
  prfInputs,
  extractPRFSecret,
  prfEnabledAtCreation,
  enrolmentGuidance,
  enrolSecurityKey,
  deriveWrappingKeyFromAssertion,
  PRF_SALT,
  HKDF_INFO,
} from "../src/lib/webauthn-prf.ts";
import { WRAPPING_KEY_BYTES } from "../src/lib/envelope.ts";
import { ab } from "../src/bytes.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}
function throws(label: string, fn: () => unknown): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  ok(label, threw);
}
function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function rnd(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}
// A fixed 32-byte vector for the determinism and domain-separation assertions, so those
// checks do not depend on live randomness. Random input is reserved for the inherently
// probabilistic "different secrets derive different keys" assertion below.
function fixed(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 7 + 1) & 0xff;
  return out;
}

// ---- domain constants are the exact, expected labels ------------------------------
// PRF_SALT and HKDF_INFO are the stable domain separators that make the derived wrapping key
// reproducible across unwraps. The HKDF reference below imports these same constants, so it
// cannot catch a constant that has been blanked; comparing each to its hard-coded expected
// bytes does. (If either label changed, every previously wrapped break-glass file would stop
// recovering, so they are pinned literally here.)
console.log("\n-- webauthn-prf: domain constants are the exact labels --");
{
  const expectedSalt = new TextEncoder().encode("downpipes:break-glass:wrapping-key:v1");
  const expectedInfo = new TextEncoder().encode("downpipes break-glass envelope wrapping key");
  ok("PRF_SALT is the exact documented salt label", bytesEq(PRF_SALT, expectedSalt));
  ok("PRF_SALT is non-empty", PRF_SALT.length > 0);
  ok("HKDF_INFO is the exact documented info label", bytesEq(HKDF_INFO, expectedInfo));
  ok("HKDF_INFO is non-empty", HKDF_INFO.length > 0);
}

// ---- detectPRFSupport truth table -------------------------------------------------
console.log("\n-- detectPRFSupport: feature-detect decision --");
{
  const full = detectPRFSupport({ hasCredentials: true, hasPublicKeyCredential: true, isSecureContext: true });
  ok("full support -> webauthnApi true, worthAttempting true", full.webauthnApi && full.worthAttempting);

  const insecure = detectPRFSupport({ hasCredentials: true, hasPublicKeyCredential: true, isSecureContext: false });
  ok("API present but insecure context -> webauthnApi true, worthAttempting false", insecure.webauthnApi && !insecure.worthAttempting);

  const noPkc = detectPRFSupport({ hasCredentials: true, hasPublicKeyCredential: false, isSecureContext: true });
  ok("no PublicKeyCredential -> webauthnApi false, worthAttempting false", !noPkc.webauthnApi && !noPkc.worthAttempting);

  const noCreds = detectPRFSupport({ hasCredentials: false, hasPublicKeyCredential: true, isSecureContext: true });
  ok("no navigator.credentials -> webauthnApi false, worthAttempting false", !noCreds.webauthnApi && !noCreds.worthAttempting);

  const none = detectPRFSupport({ hasCredentials: false, hasPublicKeyCredential: false, isSecureContext: false });
  ok("nothing present -> both false", !none.webauthnApi && !none.worthAttempting);
}

// readWebAuthnGlobals must not throw under Node and should report no WebAuthn support.
console.log("\n-- readWebAuthnGlobals: clean degrade under Node --");
{
  let snap: ReturnType<typeof readWebAuthnGlobals> | null = null;
  let threw = false;
  try {
    snap = readWebAuthnGlobals();
  } catch {
    threw = true;
  }
  ok("readWebAuthnGlobals does not throw under Node", !threw && snap !== null);
  // No navigator.credentials in Node -> hasCredentials false -> worthAttempting false.
  ok("under Node, detect over the live snapshot is not worth attempting", snap !== null && !detectPRFSupport(snap).worthAttempting);
  // Strict (=== false, not just falsy) so a mutant that forces a typeof check to true, or that
  // returns globalThis.isSecureContext (undefined) instead of false, is caught. Node 25 exposes
  // a global navigator but no navigator.credentials, no PublicKeyCredential and no
  // isSecureContext, so each field must read as the literal false the source computes.
  ok("under Node, hasCredentials is strictly false (no navigator.credentials)", snap !== null && snap.hasCredentials === false);
  ok("under Node, hasPublicKeyCredential is strictly false", snap !== null && snap.hasPublicKeyCredential === false);
  ok("under Node, isSecureContext is strictly false (boolean, not undefined)", snap !== null && snap.isSecureContext === false);
}

// readWebAuthnGlobals must check BOTH navigator.credentials.create AND .get. Stubbing a
// credentials object with only one of the two proves each conjunct is load-bearing: a mutant
// that drops the create check passes the get-only stub, and one that drops the get check passes
// the create-only stub. Each must read hasCredentials === false on the original.
console.log("\n-- readWebAuthnGlobals: requires both credentials.create and .get --");
{
  const g = globalThis as unknown as Record<string, unknown>;
  const savedNav = Object.getOwnPropertyDescriptor(g, "navigator");
  try {
    Object.defineProperty(g, "navigator", { configurable: true, writable: true, value: { credentials: { get: () => undefined } } });
    ok("credentials with only get() -> hasCredentials false", readWebAuthnGlobals().hasCredentials === false);
    Object.defineProperty(g, "navigator", { configurable: true, writable: true, value: { credentials: { create: () => undefined } } });
    ok("credentials with only create() -> hasCredentials false", readWebAuthnGlobals().hasCredentials === false);
    Object.defineProperty(g, "navigator", { configurable: true, writable: true, value: { credentials: { create: () => undefined, get: () => undefined } } });
    ok("credentials with both create() and get() -> hasCredentials true", readWebAuthnGlobals().hasCredentials === true);
  } finally {
    if (savedNav) Object.defineProperty(g, "navigator", savedNav);
    else delete g.navigator;
  }
}

// ---- browser-API-gated functions (async) ------------------------------------------
// enrolSecurityKey and deriveWrappingKeyFromAssertion both await navigator.credentials,
// so they are exercised inside an async main(). The gated-off (null) cases run FIRST,
// while no navigator/PublicKeyCredential exist, then a controllable WebAuthn stub is
// installed and the full success and partial-failure paths are driven. The stub is
// installed last so it cannot affect the Node-degrade assertions above.
async function main(): Promise<void> {
  // -- clean degrade when the path is unavailable (Node, no WebAuthn) --
  // Gated on detectPRFSupport(readWebAuthnGlobals()).worthAttempting, which is false here,
  // so both functions must return null WITHOUT touching the API and WITHOUT throwing. This
  // is the honest fall-back the console relies on to degrade to Tier 1/2.
  console.log("\n-- enrolSecurityKey / deriveWrappingKeyFromAssertion: gated-off degrade --");
  {
    let enrolResult: unknown = "unset";
    let enrolThrew = false;
    try {
      enrolResult = await enrolSecurityKey({
        rpId: "downpipes.example",
        rpName: "Downpipes",
        userId: rnd(16),
        userName: "operator@downpipes.example",
        userDisplayName: "Operator",
        challenge: rnd(32),
      });
    } catch {
      enrolThrew = true;
    }
    ok("enrolSecurityKey returns null when WebAuthn is unavailable", !enrolThrew && enrolResult === null);

    let assertResult: unknown = "unset";
    let assertThrew = false;
    try {
      assertResult = await deriveWrappingKeyFromAssertion({
        rpId: "downpipes.example",
        challenge: rnd(32),
        allowCredentialIds: [rnd(20)],
      });
    } catch {
      assertThrew = true;
    }
    ok("deriveWrappingKeyFromAssertion returns null when WebAuthn is unavailable", !assertThrew && assertResult === null);
  }

// ---- deriveWrappingKey ------------------------------------------------------------
console.log("\n-- deriveWrappingKey: HKDF determinism and domain separation --");
{
  const secret = fixed(32);
  const k1 = deriveWrappingKey(secret);
  const k2 = deriveWrappingKey(Uint8Array.from(secret));
  ok("derive is deterministic for the same secret", bytesEq(k1, k2));
  ok("derived key is 32 bytes (AES-256)", k1.length === WRAPPING_KEY_BYTES);

  // Inherently probabilistic: a fresh random secret must not collide with the fixed vector.
  const other = deriveWrappingKey(rnd(32));
  ok("different secrets derive different keys", !bytesEq(k1, other));

  // Independent reference: HKDF-SHA-256 with the documented salt and info.
  const reference = hkdf(sha256, secret, PRF_SALT, HKDF_INFO, WRAPPING_KEY_BYTES);
  ok("derived key matches an independent HKDF-SHA-256 reference (salt+info bound)", bytesEq(k1, reference));

  // Changing the salt or info would change the key (proves they are actually bound in).
  const wrongSalt = hkdf(sha256, secret, new TextEncoder().encode("different-salt"), HKDF_INFO, WRAPPING_KEY_BYTES);
  ok("a different salt would derive a different key (salt is bound)", !bytesEq(k1, wrongSalt));
  const wrongInfo = hkdf(sha256, secret, PRF_SALT, new TextEncoder().encode("different-info"), WRAPPING_KEY_BYTES);
  ok("a different info would derive a different key (info is bound)", !bytesEq(k1, wrongInfo));

  // Fixed 32-byte output regardless of input length (e.g. a longer PRF output).
  ok("derive yields 32 bytes from a 64-byte secret too", deriveWrappingKey(fixed(64)).length === WRAPPING_KEY_BYTES);
  throws("derive rejects an empty secret", () => deriveWrappingKey(new Uint8Array(0)));
  // The empty-secret guard reports its own message; blanking it is caught.
  {
    let msg: string | null = null;
    try {
      deriveWrappingKey(new Uint8Array(0));
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    ok("derive empty-secret message names the non-empty requirement", (msg?.includes("non-empty") ?? false));
  }
}

// ---- prfInputs --------------------------------------------------------------------
console.log("\n-- prfInputs: requests PRF at the fixed salt --");
{
  const inputs = prfInputs();
  const first = inputs.prf?.eval?.first;
  ok("prfInputs sets prf.eval.first", !!first);
  // first is a BufferSource; normalise and compare to PRF_SALT.
  let firstBytes: Uint8Array | null = null;
  if (first instanceof ArrayBuffer) firstBytes = new Uint8Array(first);
  else if (first && ArrayBuffer.isView(first)) firstBytes = new Uint8Array(first.buffer, first.byteOffset, first.byteLength);
  ok("prf.eval.first equals PRF_SALT", firstBytes !== null && bytesEq(firstBytes, PRF_SALT));
}

// ---- extractPRFSecret -------------------------------------------------------------
console.log("\n-- extractPRFSecret: pull the first result from clientExtensionResults --");
{
  const secretBytes = fixed(32);
  // Case 1: results.first is an ArrayBuffer holding exactly secretBytes (the common shape).
  const buf = new ArrayBuffer(secretBytes.length);
  new Uint8Array(buf).set(secretBytes);
  const ext1: AuthenticationExtensionsClientOutputs = { prf: { results: { first: buf } } };
  const got1 = extractPRFSecret(ext1);
  ok("extracts the secret from an ArrayBuffer result", got1 !== null && bytesEq(got1, secretBytes));

  // Case 2: results.first is a typed-array VIEW (some implementations).
  const ext2: AuthenticationExtensionsClientOutputs = { prf: { results: { first: ab(secretBytes) } } };
  const got2 = extractPRFSecret(ext2);
  ok("extracts the secret from a typed-array view result", got2 !== null && bytesEq(got2, secretBytes));

  // Case 3: a view with a non-zero byteOffset (sub-array of a larger buffer).
  const big = new Uint8Array(48);
  big.set(secretBytes, 8);
  const sub = big.subarray(8, 40); // 32-byte view at offset 8
  const ext3: AuthenticationExtensionsClientOutputs = { prf: { results: { first: ab(sub) } } };
  const got3 = extractPRFSecret(ext3);
  ok("extracts the secret from an offset typed-array view", got3 !== null && bytesEq(got3, secretBytes));

  // Case 4: results.first is a DataView (a BufferSource that is NOT a Uint8Array). This is the
  // case that splits the ArrayBuffer branch from the ArrayBufferView branch: the source copies a
  // DataView out via (buffer, byteOffset, byteLength), which is correct, whereas treating it as an
  // ArrayBuffer (new Uint8Array(dataView)) would yield an EMPTY array. So a 32-byte DataView at a
  // non-zero offset must extract the exact 32 secret bytes.
  {
    const backing = new Uint8Array(48);
    backing.set(secretBytes, 8);
    const dv = new DataView(backing.buffer, 8, secretBytes.length);
    const gotDv = extractPRFSecret({ prf: { results: { first: dv } } } as AuthenticationExtensionsClientOutputs);
    ok("extracts the secret from a DataView result (32 bytes, not empty)", gotDv !== null && gotDv.length === secretBytes.length);
    ok("the DataView-extracted bytes equal the secret", gotDv !== null && bytesEq(gotDv, secretBytes));
  }

  // Case 5: no PRF result at all -> null.
  ok("returns null when prf.results is absent", extractPRFSecret({ prf: { enabled: true } }) === null);
  ok("returns null when prf is absent", extractPRFSecret({}) === null);
  ok("returns null when ext is undefined", extractPRFSecret(undefined) === null);

  // End-to-end pure path: extract then derive must equal a direct derive of the secret.
  const got = extractPRFSecret(ext2);
  ok("extract -> deriveWrappingKey matches a direct derive", got !== null && bytesEq(deriveWrappingKey(got), deriveWrappingKey(secretBytes)));
}

// ---- prfEnabledAtCreation ---------------------------------------------------------
console.log("\n-- prfEnabledAtCreation: reads prf.enabled --");
  ok("enabled:true is reported true", prfEnabledAtCreation({ prf: { enabled: true } }) === true);
  ok("enabled:false is reported false", prfEnabledAtCreation({ prf: { enabled: false } }) === false);
  ok("absent prf is reported false", prfEnabledAtCreation({}) === false);
  ok("undefined ext is reported false", prfEnabledAtCreation(undefined) === false);

// ---- enrolmentGuidance copy -------------------------------------------------------
console.log("\n-- enrolmentGuidance: honest, house-style copy --");
{
  const g = enrolmentGuidance();
  ok("guidance mentions enrolling at least two keys", /at least two/i.test(g));
  ok("guidance states the secret is non-exportable", /non-exportable/i.test(g));
  ok("guidance does not claim the key is STORED on the device", /does not store/i.test(g));
  ok("guidance contains no em dash (house style)", !g.includes("—"));
  // The final clause (the actual loss consequence) must be present in full. These phrases live in
  // the last two concatenated string fragments; blanking either drops the warning the operator
  // most needs, so they are pinned literally.
  ok("guidance warns the lost-key wrapping key cannot be reproduced", /cannot be reproduced/i.test(g));
  ok("guidance warns the wrapped break-glass file cannot be recovered", /cannot be recovered/i.test(g));
  ok("guidance names the single-enrolled-key loss scenario", /if the only enrolled key is lost/i.test(g));
}

  // -- worth-attempting path: full bodies under a controllable WebAuthn stub --
  // Install a minimal navigator.credentials + PublicKeyCredential + a secure context so
  // detectPRFSupport(readWebAuthnGlobals()).worthAttempting is true. Each test sets the
  // next create()/get() outcome (a fixture credential, null, or a no-PRF assertion) and
  // captures the options the function passed, so the assertions check real behaviour:
  // the derived key matches a direct derive, the credential id round-trips, and the
  // gated functions still return null on a null/empty result.
  console.log("\n-- enrolSecurityKey / deriveWrappingKeyFromAssertion: worth-attempting path --");
  {
    const globals = globalThis as unknown as Record<string, unknown>;
    type CredOutcome = { kind: "cred"; cred: unknown } | { kind: "null" };
    const stub: {
      nextCreate: CredOutcome;
      nextGet: CredOutcome;
      lastCreate: PublicKeyCredentialCreationOptions | null;
      lastGet: PublicKeyCredentialRequestOptions | null;
    } = { nextCreate: { kind: "null" }, nextGet: { kind: "null" }, lastCreate: null, lastGet: null };

    Object.defineProperty(globals, "navigator", {
      configurable: true,
      writable: true,
      value: {
        credentials: {
          create: async (o: { publicKey: PublicKeyCredentialCreationOptions }) => {
            stub.lastCreate = o.publicKey;
            return stub.nextCreate.kind === "cred" ? stub.nextCreate.cred : null;
          },
          get: async (o: { publicKey: PublicKeyCredentialRequestOptions }) => {
            stub.lastGet = o.publicKey;
            return stub.nextGet.kind === "cred" ? stub.nextGet.cred : null;
          },
        },
      },
    });
    globals.PublicKeyCredential = function PublicKeyCredential() {};
    Object.defineProperty(globals, "isSecureContext", { configurable: true, writable: true, value: true });

    // The stub makes the path worth attempting; confirm the gate the two functions read.
    ok("under the stub, detect over the live snapshot is worth attempting", detectPRFSupport(readWebAuthnGlobals()).worthAttempting);

    // readWebAuthnGlobals now takes the BROWSER branches (navigator present, secure context).
    const liveSnap = readWebAuthnGlobals();
    ok("readWebAuthnGlobals reports the API present under the stub", liveSnap.hasCredentials && liveSnap.hasPublicKeyCredential);
    ok("readWebAuthnGlobals reports a secure context under the stub", liveSnap.isSecureContext === true);

    // ---- enrolSecurityKey: success ----
    const rawId = rnd(20);
    const rawIdBuf = new ArrayBuffer(rawId.length);
    new Uint8Array(rawIdBuf).set(rawId);
    stub.nextCreate = {
      kind: "cred",
      cred: {
        rawId: rawIdBuf,
        getClientExtensionResults: (): AuthenticationExtensionsClientOutputs => ({ prf: { enabled: true } }),
      },
    };
    const challenge = rnd(32);
    const userId = rnd(16);
    const enrol = await enrolSecurityKey({
      rpId: "downpipes.example",
      rpName: "Downpipes",
      userId,
      userName: "operator@downpipes.example",
      userDisplayName: "Operator",
      challenge,
    });
    ok("enrolSecurityKey returns a result when worth attempting", enrol !== null);
    ok("enrolSecurityKey returns the raw credential id", enrol !== null && bytesEq(enrol.credentialId, rawId));
    ok("enrolSecurityKey reports prfEnabled from the extension results", enrol !== null && enrol.prfEnabled === true);
    // The creation options the function built are the ones a security key needs.
    ok("create() was called with the rp id", stub.lastCreate?.rp.id === "downpipes.example");
    ok("create() requested a cross-platform resident key", stub.lastCreate?.authenticatorSelection?.authenticatorAttachment === "cross-platform" && stub.lastCreate?.authenticatorSelection?.residentKey === "required");
    // The PRF extension input carries our fixed salt (same object prfInputs builds).
    {
      const first = stub.lastCreate?.extensions?.prf?.eval?.first;
      let firstBytes: Uint8Array | null = null;
      if (first instanceof ArrayBuffer) firstBytes = new Uint8Array(first);
      else if (first && ArrayBuffer.isView(first)) firstBytes = new Uint8Array(first.buffer, first.byteOffset, first.byteLength);
      ok("create() requested PRF at the fixed salt", firstBytes !== null && bytesEq(firstBytes, PRF_SALT));
    }

    // The create() user entity must carry the caller's identity. A blanked user object would
    // drop the id/name/displayName the relying party needs to bind the credential to the operator.
    {
      const u = stub.lastCreate?.user;
      let userIdBytes: Uint8Array | null = null;
      const uid = u?.id;
      if (uid instanceof ArrayBuffer) userIdBytes = new Uint8Array(uid);
      else if (uid && ArrayBuffer.isView(uid)) userIdBytes = new Uint8Array(uid.buffer, uid.byteOffset, uid.byteLength);
      ok("create() user.id carries the supplied user handle", userIdBytes !== null && bytesEq(userIdBytes, userId));
      ok("create() user.name and displayName are the supplied identity", u?.name === "operator@downpipes.example" && u?.displayName === "Operator");
    }

    // The credential parameters must offer ES256 (-7) then RS256 (-257), both public-key, in that
    // order. An emptied array, an emptied entry, a blanked type, or a flipped-sign alg (e.g. -7 to
    // +7) would all break what a security key accepts, so each field is checked exactly.
    {
      const params = stub.lastCreate?.pubKeyCredParams ?? [];
      ok("create() offers exactly two credential parameters", params.length === 2);
      ok("create() first param is public-key ES256 (-7)", params[0]?.type === "public-key" && params[0]?.alg === -7);
      ok("create() second param is public-key RS256 (-257)", params[1]?.type === "public-key" && params[1]?.alg === -257);
      ok("create() algs are negative COSE identifiers", (params[0]?.alg ?? 0) < 0 && (params[1]?.alg ?? 0) < 0);
    }

    // The remaining selection fields a roaming security-key enrolment needs.
    ok("create() requested userVerification required", stub.lastCreate?.authenticatorSelection?.userVerification === "required");
    ok("create() requested attestation none", stub.lastCreate?.attestation === "none");

    // ---- enrolSecurityKey: a key that reports PRF unavailable ----
    stub.nextCreate = {
      kind: "cred",
      cred: { rawId: rawIdBuf, getClientExtensionResults: (): AuthenticationExtensionsClientOutputs => ({}) },
    };
    const enrolNoPrf = await enrolSecurityKey({
      rpId: "downpipes.example",
      rpName: "Downpipes",
      userId,
      userName: "operator@downpipes.example",
      userDisplayName: "Operator",
      challenge: rnd(32),
    });
    ok("enrolSecurityKey reports prfEnabled false when the key did not report PRF", enrolNoPrf !== null && enrolNoPrf.prfEnabled === false);

    // ---- enrolSecurityKey: create() returns null (user cancelled / no credential) ----
    stub.nextCreate = { kind: "null" };
    const enrolNull = await enrolSecurityKey({
      rpId: "downpipes.example",
      rpName: "Downpipes",
      userId,
      userName: "operator@downpipes.example",
      userDisplayName: "Operator",
      challenge: rnd(32),
    });
    ok("enrolSecurityKey returns null when create() yields no credential", enrolNull === null);

    // ---- deriveWrappingKeyFromAssertion: success ----
    const prfSecret = rnd(32);
    const prfSecretBuf = new ArrayBuffer(prfSecret.length);
    new Uint8Array(prfSecretBuf).set(prfSecret);
    stub.nextGet = {
      kind: "cred",
      cred: {
        getClientExtensionResults: (): AuthenticationExtensionsClientOutputs => ({ prf: { results: { first: prfSecretBuf } } }),
      },
    };
    const allowIds = [rnd(20), rnd(24)];
    const key = await deriveWrappingKeyFromAssertion({ rpId: "downpipes.example", challenge: rnd(32), allowCredentialIds: allowIds });
    ok("deriveWrappingKeyFromAssertion returns a 32-byte key on a PRF result", key !== null && key.length === WRAPPING_KEY_BYTES);
    ok("derived key equals a direct deriveWrappingKey of the PRF secret", key !== null && bytesEq(key, deriveWrappingKey(prfSecret)));
    ok("get() was called with the rp id", stub.lastGet?.rpId === "downpipes.example");
    ok("get() scoped allowCredentials to both enrolled key ids", stub.lastGet?.allowCredentials?.length === 2);
    // Each allowCredentials descriptor must be a public-key entry carrying the EXACT enrolled id
    // bytes (the two ids have distinct lengths, 20 and 24, so a dropped or blanked mapping is
    // visible). A mutant that maps to undefined or to an empty object would fail these.
    {
      const ac = stub.lastGet?.allowCredentials ?? [];
      const idBytes = (b: BufferSource | undefined): Uint8Array | null => {
        if (b instanceof ArrayBuffer) return new Uint8Array(b);
        if (b && ArrayBuffer.isView(b)) return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
        return null;
      };
      ok("get() allowCredentials entries are both public-key type", ac[0]?.type === "public-key" && ac[1]?.type === "public-key");
      const id0 = idBytes(ac[0]?.id);
      const id1 = idBytes(ac[1]?.id);
      ok("get() allowCredentials[0] carries the first enrolled id (20 bytes)", id0 !== null && bytesEq(id0, allowIds[0]!));
      ok("get() allowCredentials[1] carries the second enrolled id (24 bytes)", id1 !== null && bytesEq(id1, allowIds[1]!));
    }
    ok("get() requested userVerification required", stub.lastGet?.userVerification === "required");

    // ---- deriveWrappingKeyFromAssertion: get() returns null ----
    stub.nextGet = { kind: "null" };
    const keyNull = await deriveWrappingKeyFromAssertion({ rpId: "downpipes.example", challenge: rnd(32), allowCredentialIds: allowIds });
    ok("deriveWrappingKeyFromAssertion returns null when get() yields no assertion", keyNull === null);

    // ---- deriveWrappingKeyFromAssertion: assertion present but no PRF result ----
    stub.nextGet = {
      kind: "cred",
      cred: { getClientExtensionResults: (): AuthenticationExtensionsClientOutputs => ({ prf: { enabled: true } }) },
    };
    const keyNoPrf = await deriveWrappingKeyFromAssertion({ rpId: "downpipes.example", challenge: rnd(32), allowCredentialIds: allowIds });
    ok("deriveWrappingKeyFromAssertion returns null when the assertion carries no PRF result", keyNoPrf === null);

    // Leave the globals as found so the process exits without a lingering stub.
    delete globals.navigator;
    delete globals.PublicKeyCredential;
    delete globals.isSecureContext;
  }

  // ---- Summary ----------------------------------------------------------------------
  console.log(failures === 0 ? "\nWEBAUTHN-PRF VECTORS PASS" : `\n${failures} FAILURE(S)`);
  if (failures > 0) process.exitCode = 1;
  if (failures > 0) process.exit(1);
}

void main();
