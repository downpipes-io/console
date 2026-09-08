// Validate that the console key ceremony produces well-formed, cryptographically sound
// keys in the exact encodings the engine and the Go offline tool consume. Run with
// `node test/validate-keygen.ts` after `npm install`.

import { ml_kem1024 } from "@noble/post-quantum/ml-kem.js";
import { ml_dsa87 } from "@noble/post-quantum/ml-dsa.js";
import { x25519, ed25519 } from "@noble/curves/ed25519.js";
import { runKeyCeremony, identityFile, recipientFile, signerPublicFile, signerPrivateFile } from "../src/keygen.ts";
import { b64urlDecode } from "../src/bytes.ts";
import { requireDownpipeRoot, readDownpipeSource } from "./downpipe-root.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}
function eq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// goKeyLabels pulls the four key-file label constants out of the READER'S OWN SOURCE.
//
// They used to sit in this file as four string literals, cited to "main.go:498-501". The citation had
// already gone stale (the const block is at main.go:302-305 today) and the literals could not have
// noticed: an assertion that a console label equals a console constant holds whatever the Go side does,
// which is the whole second-opinion class. Whether the values happened to still agree is not the point,
// because nothing here was capable of telling us either way.
//
// A missing constant is a FAILURE, not a smaller set of assertions. A rename in the reader is exactly
// the divergence this is for, and quietly checking three of four would report it as a pass.
function goKeyLabels(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of src.matchAll(/^\s*(label[A-Za-z]+)\s*=\s*"([^"]+)"/gm)) {
    const name = m[1];
    const value = m[2];
    if (name !== undefined && value !== undefined) out.set(name, value);
  }
  return out;
}

async function main(): Promise<void> {
  const c = await runKeyCeremony({ operational: true });

  const id = b64urlDecode(c.breakGlass.identityB64);
  const pub = b64urlDecode(c.breakGlass.recipientPublicB64);
  ok("break-glass identity is 96 bytes", id.length === 96);
  ok("recipient public is 1600 bytes", pub.length === 1600);

  const xScalar = id.subarray(0, 32);
  const mlkemSeed = id.subarray(32, 96);
  const xPub = pub.subarray(0, 32);
  const ek = pub.subarray(32);

  // The published x25519 public matches the identity scalar.
  ok("x25519 public matches scalar", eq(x25519.getPublicKey(xScalar), xPub));

  // ML-KEM round-trip: encapsulate to the published ek, decapsulate with the seed-derived
  // key, secrets match (proves the seed, ek and decapsulation are mutually consistent).
  const enc = ml_kem1024.encapsulate(ek);
  const decapKey = ml_kem1024.keygen(mlkemSeed).secretKey;
  ok("ML-KEM encapsulate/decapsulate round-trip", eq(ml_kem1024.decapsulate(enc.cipherText, decapKey), enc.sharedSecret));

  // Operational recipient present and distinct.
  ok("operational recipient generated", c.operational !== null && c.operational.fingerprint !== c.breakGlass.fingerprint);

  // Signer: published ed public matches the seed, and sign/verify round-trips.
  const sPriv = b64urlDecode(c.signer.privateB64);
  const sPub = b64urlDecode(c.signer.publicB64);
  ok("signer public is 2624 bytes", sPub.length === 32 + 2592);
  ok("ed25519 public matches seed", eq(ed25519.getPublicKey(sPriv.subarray(0, 32)), sPub.subarray(0, 32)));
  const msg = new TextEncoder().encode("recovery sheet attestation");
  // privateB64 stores the ML-DSA SEED (bytes 32..64); derive the secret key to sign with it.
  const sig = ml_dsa87.sign(msg, ml_dsa87.keygen(sPriv.subarray(32)).secretKey);
  ok("ML-DSA sign/verify round-trip", ml_dsa87.verify(sig, msg, sPub.subarray(32)));

  // ---- Labelled key-file format compatibility (CON-L2 / XC-L3) ----
  //
  // The Go offline CLI reads key files with readKeyFile (cmd/downpipe/main.go), which delegates the
  // parse to parseKeyFileBytes (cmd/downpipe/recombine.go):
  //   fields := strings.Fields(string(content))
  //   if len(fields) != 2 || fields[0] != label { return error }
  //   return base64.RawURLEncoding.DecodeString(fields[1])
  //
  // And writes them in writeKeyFile as:
  //   line := label + " " + base64.RawURLEncoding.EncodeToString(raw) + "\n"
  //
  // These tests pin the exact byte-level contract: one label token, one space, one base64url-no-pad
  // token, one trailing newline, nothing else. WHERE THE EXPECTATION COMES FROM is the part that was
  // wrong until: the labels and the parse rule are now READ OUT OF THE READER'S SOURCE
  // through test/downpipe-root.ts, so a rename or a format change on the Go side fails here. Held as
  // literals, they could only ever have failed if the CONSOLE moved, which is not what this check is for.
  function checkKeyFile(
    label: string,
    file: string,
    raw: Uint8Array,
    name: string,
  ): void {
    // Exact format: "<label> <b64url-no-pad>\n"
    ok(`${name}: ends with exactly one newline`, file.endsWith("\n") && !file.endsWith("\n\n"));
    const line = file.slice(0, -1); // strip the trailing newline
    ok(`${name}: no embedded newlines before the final one`, !line.includes("\n"));
    const parts = line.split(" ");
    ok(`${name}: exactly two space-separated fields`, parts.length === 2);
    ok(`${name}: label matches Go constant`, parts[0] === label);
    const b64Field = parts[1] ?? "";
    ok(`${name}: b64 field is non-empty`, b64Field.length > 0);
    ok(`${name}: b64 field contains no padding (=)`, !b64Field.includes("="));
    ok(`${name}: b64 field contains no standard base64 chars (+, /)`, !b64Field.includes("+") && !b64Field.includes("/"));
    // Round-trip: b64urlDecode(b64Field) must equal the original raw bytes.
    let decoded: Uint8Array;
    try {
      decoded = b64urlDecode(b64Field);
    } catch (_e) {
      ok(`${name}: b64 field decodes without error`, false);
      return;
    }
    ok(`${name}: decoded length matches raw`, decoded.length === raw.length);
    ok(`${name}: decoded bytes match raw`, eq(decoded, raw));
    // Confirm strings.Fields sees exactly 2 tokens (no leading/trailing whitespace).
    const fields = line.split(/\s+/).filter((f) => f.length > 0);
    ok(`${name}: strings.Fields-equivalent sees exactly 2 tokens`, fields.length === 2);
  }

  // ---- The four labels, taken from the reader rather than restated here ----
  //
  // A checkout with no reader sibling cannot run these cross-repo assertions, so
  // test/downpipe-root.ts's requireDownpipeRoot returns null on a reader-less checkout and THROWS under
  // REQUIRE_DOWNPIPE=1. The cross-repo assertions below are skipped loudly when there is no reader; a CI
  // job that checks the reader out runs this file again with REQUIRE_DOWNPIPE=1, where the skip is
  // impossible and a missing sibling fails the job. Everything above this line is console-against-console
  // and still runs everywhere.
  const readerRoot = requireDownpipeRoot("validate-keygen.ts key-file label pins");
  if (readerRoot === null) {
    console.log(
      "\n  SKIPPED (no reader sibling): the four label pins, the parse-rule pins and the four key-file byte\n" +
        "       checks were NOT run. They are enforced in the Cross-repo gates CI job, which checks the reader\n" +
        "       out and sets REQUIRE_DOWNPIPE=1 so this branch throws instead of skipping. To run them here,\n" +
        "       point DOWNPIPES_DOWNPIPE at a reader checkout.",
    );
  } else {
    const labels = goKeyLabels(readDownpipeSource(readerRoot, "cmd/downpipe/main.go"));
    const label = (constName: string): string => {
      const v = labels.get(constName);
      ok(`reader defines ${constName}`, v !== undefined);
      return v ?? `<${constName} MISSING FROM THE READER>`;
    };
    const LABEL_IDENTITY = label("labelIdentity");
    const LABEL_RECIPIENT = label("labelRecipient");
    const LABEL_SIGNER_PUBLIC = label("labelSignerPublic");
    const LABEL_SIGNER_PRIVATE = label("labelSignerPrivate");
    ok("the four reader labels are distinct", new Set([LABEL_IDENTITY, LABEL_RECIPIENT, LABEL_SIGNER_PUBLIC, LABEL_SIGNER_PRIVATE]).size === 4);

    // The parse rule the byte-level assertions below ASSUME. If the reader stops splitting on
    // strings.Fields, stops demanding exactly two of them, or moves off RawURLEncoding, then "exactly two
    // space-separated fields" and "no padding" stop being the contract and this file would go on asserting
    // a format nothing consumes.
    const parseSrc = readDownpipeSource(readerRoot, "cmd/downpipe/recombine.go");
    const parseFn = parseSrc.slice(parseSrc.indexOf("func parseKeyFileBytes"));
    ok("reader still splits key files on strings.Fields", parseFn.includes("strings.Fields("));
    ok("reader still demands exactly two fields", /len\(fields\)\s*!=\s*2/.test(parseFn));
    ok("reader still matches fields[0] against the label", /fields\[0\]\s*!=\s*label/.test(parseFn));
    ok("reader still decodes the second field as base64 raw-url (no padding)", parseFn.includes("base64.RawURLEncoding.DecodeString(fields[1])"));
    const writeSrc = readDownpipeSource(readerRoot, "cmd/downpipe/main.go");
    const writeFn = writeSrc.slice(writeSrc.indexOf("func writeKeyFile"));
    ok("reader still writes label + space + b64url + one newline", writeFn.includes('line := label + " " + base64.RawURLEncoding.EncodeToString(raw) + "\\n"'));

    // Re-decode the raw bytes so we can feed them to checkKeyFile.
    const bgId = b64urlDecode(c.breakGlass.identityB64);
    const bgPub = b64urlDecode(c.breakGlass.recipientPublicB64);
    const sPrivRaw = b64urlDecode(c.signer.privateB64);
    const sPubRaw = b64urlDecode(c.signer.publicB64);

    checkKeyFile(LABEL_IDENTITY, identityFile(c.breakGlass), bgId, "identityFile");
    checkKeyFile(LABEL_RECIPIENT, recipientFile(c.breakGlass), bgPub, "recipientFile");
    checkKeyFile(LABEL_SIGNER_PUBLIC, signerPublicFile(c.signer), sPubRaw, "signerPublicFile");
    checkKeyFile(LABEL_SIGNER_PRIVATE, signerPrivateFile(c.signer), sPrivRaw, "signerPrivateFile");
  }

  console.log(failures === 0 ? "\nKEY CEREMONY VECTORS PASS" : `\n${failures} FAILURE(S)`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
