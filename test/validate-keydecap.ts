// Cross-repo parity for the browser-side key decapsulation (src/lib/keydecap.ts). The vector
// (test/vectors/keydecap-vector.json) is authored FROM the engine's master-capsule conformance vector: a
// fixed identity + capsule wraps + key commitment whose recovered master, and a fixed engine-issued
// challenge whose expected proof, are pinned here. If the console port drifts from the engine (a byte in the
// KEM/DEM/stream chain, or a one-sided @noble bump), the recovered master or proof changes and this fails.
// The engine has validate-attest-crypto.ts proving its side; together they are the three-way (Go/engine/
// console) guarantee that attended verification recovers the same per-run master the engine expects.
//
// Run with `node test/validate-keydecap.ts`.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { openCapsule, deriveAttestProof, parseIdentityFile, type CapsuleWrap } from "../src/lib/keydecap.ts";

interface Vector {
  identityFile: string;
  keyCommitment: string;
  masterHex: string;
  wraps: CapsuleWrap[];
  challenge: { ciphertextB64: string; nonceB64: string; expectedProofHex: string };
}

const HERE = dirname(fileURLToPath(import.meta.url));
const V = JSON.parse(readFileSync(join(HERE, "vectors/keydecap-vector.json"), "utf8")) as Vector;

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}
function hex(b: Uint8Array): string {
  let o = "";
  for (const x of b) o += x.toString(16).padStart(2, "0");
  return o;
}

async function main(): Promise<void> {
  const identity = parseIdentityFile(V.identityFile);

  // The core parity: the console recovers the SAME 32-byte per-run master the engine does, from the same
  // capsule + identity. This exercises the whole ported chain (KEM decap, hybrid combine, HKDF, AES-GCM
  // stream open, recipient fingerprint selection).
  const master = await openCapsule(V.wraps, identity, V.keyCommitment);
  ok("openCapsule reproduces the engine's known master (cross-repo parity)", hex(master) === V.masterHex);

  // The challenge parity: the console reproduces the engine's expected proof from a fixed engine-issued
  // challenge, so a passing live-possession prove step means the same on both sides.
  const proof = await deriveAttestProof(identity, V.challenge.ciphertextB64, V.challenge.nonceB64);
  ok("deriveAttestProof reproduces the engine's challenge proof (cross-repo parity)", hex(proof) === V.challenge.expectedProofHex);

  // A wrong-length identity file is rejected (the parse fails closed, never producing a garbage identity).
  let threw = false;
  try {
    parseIdentityFile("downpipe-identity-v1 AAAA");
  } catch {
    threw = true;
  }
  ok("parseIdentityFile rejects a wrong-length identity", threw);

  // A capsule with no wrap addressed to the identity is refused (never returns a wrong-key master).
  let noWrap = false;
  try {
    await openCapsule([{ ...V.wraps[0]!, fingerprint: "dpr1:0000" }], identity, V.keyCommitment);
  } catch {
    noWrap = true;
  }
  ok("openCapsule refuses when no wrap matches the held identity", noWrap);

  console.log(failures === 0 ? "\nKEYDECAP PARITY PASS" : `\n${failures} FAILURE(S)`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
