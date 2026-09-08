// Cross-repo parity for the browser-side "open a sealed export" pipeline (src/lib/sealed-export-unseal.ts).
// The vector (test/vectors/sealed-export-vector.json) is authored FROM the engine's OWN
// sealControlPlaneExport + signSealedControlPlaneExport (src/admin/control-plane-seal.ts): a fixed
// break-glass identity, a real sealed artefact, its real detached signature and the matching signer.pub. If
// this port drifts from the engine (canonicalJSON, an AAD label, the KEM/DEM/stream chain, or a one-sided
// @noble bump), the recovered plaintext or one of the verify verdicts changes and this fails. The engine has
// validate-control-plane-seal.ts proving its own side; together they are the two-way guarantee that a browser
// unseal recovers exactly the plaintext the engine sealed, both ways proven: the vector's real artefact opens
// (this file), and this port's OWN sealing primitives (reused from control-plane-seal.ts's design, ported
// here read-only) could not have been used to forge one the engine would accept (the engine independently
// re-verifies on POST /control-plane/import-sealed, proven server-side in
// the engine repository's test/validate-cov-admin-router-identity.ts).
//
// Also proves every honest failure state the row calls for (wrong key, corrupt file, version mismatch) is
// reachable and produces a DISTINCT, stable code -- and that NONE of it ever puts the private identity, or
// any secret, on a request path (this module imports no Transport/EngineClient at all; see the "no network
// surface" assertion below).
//
// Run with `node test/validate-sealed-export-unseal.ts`.

import { readFileSync } from "node:fs";
import { blankComments } from "./lib/source-text.ts";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  unsealControlPlaneExport,
  looksLikeSealedControlPlaneExport,
  parseSignerPublic,
  verifySealedSignatureDetailed,
  canonicalJSON,
  type SealedControlPlaneExport,
} from "../src/lib/sealed-export-unseal.ts";
import { parseIdentityFile } from "../src/lib/keydecap.ts";

interface Vector {
  identityFile: string;
  otherIdentityFile: string;
  signerPublic: string;
  sealed: SealedControlPlaneExport;
  sealedSignature: string;
  badHashSealed: SealedControlPlaneExport;
  badHashSignature: string;
  badCapsuleSealed: SealedControlPlaneExport;
  badCapsuleSignature: string;
  badBodySealed: SealedControlPlaneExport;
  badBodySignature: string;
  innerExport: unknown;
}

// The bindings and module paths that would give a file under sealed-export-unseal.ts a route to the
// network. Declared once, at module scope, so the ban and the self-test that proves the ban works read the
// SAME rule; a self-test written against its own private copy would go on passing after the real one
// drifted.
//
// MATCHED AS WHOLE BINDINGS, NOT AS SUBSTRINGS. The rule used to be the regex
// /EngineClient|Transport|api\/client|engineFetch/ tested against a line, and it has two faults that were
// hiding each other. The line scan could not see a multi-line import at all (see the ban site below), and
// because it never reached one, the substring looseness never fired either. It does immediately once the
// scan is fixed: client-diag/ring.ts imports CLIENT_DIAG_TRANSPORT_CLASS_SET and ClientDiagTransportClass
// from ./vocab.ts, and both contain "Transport". Neither is the api/client Transport, and vocab.ts is a
// closed-class word list with no network anything. A ban that cannot tell those apart is not usable, so
// the bindings are compared by exact name and the specifier by path.
const BANNED_BINDINGS = new Set(["EngineClient", "Transport", "engineFetch"]);
const BANNED_SPECIFIER = /(^|\/)api\/client(\.ts)?$/;

// bannedImport decides whether ONE whole import statement reaches the network, by name rather than by
// substring: it splits the brace list into bindings (dropping the `type` modifier and any `as` alias, and
// keeping the default and namespace forms) and reads the specifier separately.
function bannedImport(statement: string): boolean {
  const spec = /from\s+["']([^"']+)["']/.exec(statement)?.[1] ?? "";
  if (BANNED_SPECIFIER.test(spec)) return true;
  const braces = /\{([\s\S]*)\}/.exec(statement)?.[1] ?? "";
  const named = braces.split(",").map((b) => b.replace(/^\s*type\s+/, "").split(/\s+as\s+/)[0]!.trim()).filter((b) => b !== "");
  // `import X from`, `import * as X from` and `import X, { ... } from` all bind a name outside the braces.
  const head = /^\s*import\s+(?:type\s+)?([^{;]*?)(?:,|\s+from\b)/.exec(statement)?.[1] ?? "";
  const outer = head.replace(/\*\s+as\s+/, "").trim();
  return [...named, outer].some((b) => BANNED_BINDINGS.has(b));
}

const HERE = dirname(fileURLToPath(import.meta.url));
const V = JSON.parse(readFileSync(join(HERE, "vectors/sealed-export-vector.json"), "utf8")) as Vector;

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

async function main(): Promise<void> {
  const identity = parseIdentityFile(V.identityFile);
  const otherIdentity = parseIdentityFile(V.otherIdentityFile);

  console.log("sealed-export-unseal: shape gate");
  ok("looksLikeSealedControlPlaneExport accepts the real vector", looksLikeSealedControlPlaneExport(V.sealed));
  ok("looksLikeSealedControlPlaneExport rejects junk", !looksLikeSealedControlPlaneExport({ v: 1 }) && !looksLikeSealedControlPlaneExport(null) && !looksLikeSealedControlPlaneExport("not an object"));

  console.log("sealed-export-unseal: the core round trip -- BOTH WAYS proven");
  // WAY 1: the engine's real sealed artefact opens in the browser to EXACTLY the engine's real plaintext.
  // Compared via canonicalJSON (sorted-key byte equality), not JSON.stringify: the recovered value's key
  // order follows the SIGNED canonical bytes (alphabetical), while V.innerExport's follows the generator
  // script's plain JSON.stringify (insertion order) -- same content, different incidental key order.
  const good = await unsealControlPlaneExport(V.sealed, V.sealedSignature, V.signerPublic, identity);
  ok(
    "unsealControlPlaneExport recovers the engine's exact plaintext (cross-repo parity)",
    good.ok && Buffer.from(canonicalJSON(good.exportArtefact)).toString("hex") === Buffer.from(canonicalJSON(V.innerExport)).toString("hex"),
  );
  ok("the recovered value is the SAME artefact the engine's own no-custody builder produced (opaque, unmodified)", good.ok && (good.exportArtefact as { configVersion?: number }).configVersion === 3);

  console.log("sealed-export-unseal: signature verify, mirroring the engine's own five-world split");
  const verifier = parseSignerPublic(V.signerPublic);
  ok("verifySealedSignatureDetailed: the real signature verifies ok", verifySealedSignatureDetailed(V.sealed, V.sealedSignature, verifier) === "ok");
  ok("verifySealedSignatureDetailed: a truncated signature is sig-decode", verifySealedSignatureDetailed(V.sealed, V.sealedSignature.slice(0, 20), verifier) === "sig-decode");
  const tampered: SealedControlPlaneExport = { ...V.sealed, exportedAt: "2099-01-01T00:00:00.000Z" };
  ok("verifySealedSignatureDetailed: a tampered sealed artefact fails BOTH halves (the tamper verdict)", verifySealedSignatureDetailed(tampered, V.sealedSignature, verifier) === "ed25519-mismatch");
  const wrongVerifier = { ed: verifier.ed, mldsa: new Uint8Array(verifier.mldsa) };
  wrongVerifier.mldsa[5] = wrongVerifier.mldsa[5]! ^ 0xff;
  ok("verifySealedSignatureDetailed: a corrupt ML-DSA half of the verifier is mldsa-mismatch, never tamper", verifySealedSignatureDetailed(V.sealed, V.sealedSignature, wrongVerifier) === "mldsa-mismatch");

  console.log("sealed-export-unseal: canonicalJSON is stable and content-bound");
  ok("canonicalJSON re-serialises the same object to the same bytes", Buffer.from(canonicalJSON(V.sealed)).toString("hex") === Buffer.from(canonicalJSON(JSON.parse(JSON.stringify(V.sealed)))).toString("hex"));
  ok("canonicalJSON changes when the content changes", Buffer.from(canonicalJSON(V.sealed)).toString("hex") !== Buffer.from(canonicalJSON(tampered)).toString("hex"));

  console.log("sealed-export-unseal: the row's three named failure states, EACH its own honest, distinct code");

  // WRONG KEY: a real identity, just not a recipient of this artefact.
  const wrongKey = await unsealControlPlaneExport(V.sealed, V.sealedSignature, V.signerPublic, otherIdentity);
  ok("wrong key: refused", wrongKey.ok === false);
  ok("wrong key: DP-R24, not lumped in with a corrupt file", !wrongKey.ok && wrongKey.code === "DP-R24");

  // CORRUPT FILE, several distinct shapes of "corrupt", each its own code:
  const tamperedSig = await unsealControlPlaneExport(tampered, V.sealedSignature, V.signerPublic, identity);
  ok("corrupt (tampered header): DP-R15, the ONLY code a genuine tamper can reach", !tamperedSig.ok && tamperedSig.code === "DP-R15");

  const tamperedBody: SealedControlPlaneExport = { ...V.sealed, body: `${V.sealed.body.slice(0, -4)}AAAA` };
  const tamperedBodyResult = await unsealControlPlaneExport(tamperedBody, V.sealedSignature, V.signerPublic, identity);
  ok(
    "corrupt (tampered body ciphertext, signature NOT re-issued): caught by the SIGNATURE check first (verify precedes decrypt) -- never silently decrypted",
    !tamperedBodyResult.ok && tamperedBodyResult.code === "DP-R15",
  );

  // A capsule wrap corrupted AND independently re-signed (exactly what a genuinely bit-rotted bucket object's
  // OWN .sig would cover): the signature verifies, the right key is held, but that wrap's own AEAD open fails.
  ok("(fixture sanity) the corrupted capsule differs from the original", V.badCapsuleSealed.capsule[0]!.sealed !== V.sealed.capsule[0]!.sealed);
  const badCapsuleResult = await unsealControlPlaneExport(V.badCapsuleSealed, V.badCapsuleSignature, V.signerPublic, identity);
  ok("corrupt (capsule, re-signed): refused", badCapsuleResult.ok === false);
  ok("corrupt (capsule, re-signed): DP-R25, distinct from DP-R24 (wrong key) and DP-R15 (tamper)", !badCapsuleResult.ok && badCapsuleResult.code === "DP-R25");

  // A body ciphertext corrupted AND independently re-signed: the capsule opens fine (right key), but the
  // body's own AEAD open fails.
  ok("(fixture sanity) the corrupted body differs from the original", V.badBodySealed.body !== V.sealed.body);
  const badBodyResult = await unsealControlPlaneExport(V.badBodySealed, V.badBodySignature, V.signerPublic, identity);
  ok("corrupt (body, re-signed): refused", badBodyResult.ok === false);
  ok("corrupt (body, re-signed): DP-R26, distinct from every other corruption code", !badBodyResult.ok && badBodyResult.code === "DP-R26");

  const missingBodyHash = { ...V.sealed } as Record<string, unknown>;
  delete missingBodyHash.bodyHash;
  const noHashResult = await unsealControlPlaneExport(missingBodyHash as unknown as SealedControlPlaneExport, V.sealedSignature, V.signerPublic, identity);
  ok("corrupt (predates bodyHash): DP-R23, refused honestly rather than trusted unverified", !noHashResult.ok && noHashResult.code === "DP-R23");

  // VERSION MISMATCH: named honestly, checked BEFORE any crypto runs.
  const wrongVersion: SealedControlPlaneExport = { ...V.sealed, v: 2 };
  const versionResult = await unsealControlPlaneExport(wrongVersion, V.sealedSignature, V.signerPublic, identity);
  ok("version mismatch: refused", versionResult.ok === false);
  ok("version mismatch: DP-R22, and the message names the actual version", !versionResult.ok && versionResult.code === "DP-R22" && versionResult.error.includes("version 2"));

  // The DP-R28 defensive state: a validly-signed artefact whose bodyHash does not match its own body. Proves
  // the cross-check is genuinely load-bearing (wired in, not dead code) even though AEAD success makes it
  // unreachable via any HONEST engine-produced artefact.
  const badHashResult = await unsealControlPlaneExport(V.badHashSealed, V.badHashSignature, V.signerPublic, identity);
  ok("bodyHash mismatch (defensive): refused rather than trusted", badHashResult.ok === false);
  ok("bodyHash mismatch (defensive): DP-R28", !badHashResult.ok && badHashResult.code === "DP-R28");

  // Malformed signer.pub -> DP-R20, same code the engine's own route uses for the identical state.
  const badPub = await unsealControlPlaneExport(V.sealed, V.sealedSignature, "not-a-valid-signer-pub", identity);
  ok("malformed signer.pub: DP-R20", !badPub.ok && badPub.code === "DP-R20");

  console.log("sealed-export-unseal: NO-CUSTODY -- this module's WHOLE TRANSITIVE IMPORT GRAPH cannot reach the network");
  // The strongest available proof that the private identity never leaves the browser is structural: no file
  // reachable from sealed-export-unseal.ts by a chain of LOCAL imports contains a network primitive, so there
  // is no code path anywhere under it that could put ANY value -- let alone the identity -- on a request.
  //
  // A single-file scan (the original version of this check) proves nothing about a helper it calls: this
  // module itself never says "fetch", but if client-diag/ring.ts's recordRecoveryRefusal quietly grew a
  // beacon call, or keydecap.ts's crypto helpers reached for a WASM loader over HTTP, a one-file grep would
  // stay green while the no-custody guarantee broke two hops away. So this walks the REAL import graph
  // (parsing every `import ... from "./x"` / "../x" line, recursively, skipping bare package specifiers like
  // "@noble/..." which is node_modules-mediated and cannot reach the console's own Transport) and checks
  // every file it finds, not just the one this test is nominally about.
  //
  // THE BAN READS WHOLE IMPORT STATEMENTS, NOT LINES, and that is the whole point of importStatements
  // below. It used to read lines: `text.split("\n").filter((l) => /^import\b/.test(l.trim()))`. A
  // multi-line import contributes exactly one matching line, the bare `import {`, and every named binding
  // sits on a continuation line that does not start with `import` and was therefore never scanned. So
  //
  //     import {
  //       EngineClient,
  //       engineFetch,
  //     } from "./api/client.ts";
  //
  // passed the ban. This is not hypothetical: src/lib/client-diag/ring.ts:20 is inside this very walk and
  // already imports across lines. The recursive walk itself was never affected, because its own importRe
  // spans newlines; only the ban was per-line. The guarantee this file exists to prove was enforced
  // against single-line imports alone.
  const root = join(HERE, "../src/lib/sealed-export-unseal.ts");
  const visited = new Map<string, string>(); // resolved path -> source text
  const importRe = /^\s*import\b[^;]*?\bfrom\s+["']([^"']+)["'];?\s*$/gm;
  // importStatements returns each import as ONE string from `import` through its specifier, continuation
  // lines included. `[^;]*?` matches newlines (it is a negated character class, not `.`), which is exactly
  // why the sibling importRe above has always resolved multi-line imports correctly.
  const importStatements = (text: string): string[] => [...text.matchAll(/^\s*import\b[^;]*?\bfrom\s+["'][^"']+["'];?/gm)].map((m) => m[0]);
  function resolveLocal(fromFile: string, spec: string): string | null {
    if (!spec.startsWith(".")) return null; // a bare package specifier: node_modules-mediated, not a local hop
    let resolved = new URL(spec, `file://${fromFile}`).pathname;
    if (!resolved.endsWith(".ts")) resolved = `${resolved}.ts`;
    return resolved;
  }
  function walk(file: string): void {
    if (visited.has(file)) return;
    const text = readFileSync(file, "utf8");
    visited.set(file, text);
    for (const m of text.matchAll(importRe)) {
      const target = resolveLocal(file, m[1]!);
      if (target) walk(target);
    }
  }
  walk(root);
  // THE BAN IS TESTED BEFORE IT IS TRUSTED. Every per-file line below is a NEGATIVE assertion, and a
  // negative assertion over a scanner that finds nothing is green for the same reason as one over a
  // scanner that works. The per-line version was green on both counts for as long as it existed. So the
  // ban is first run against two fixtures whose answer is known: it must catch the banned name written
  // on one line AND written across lines, and it must not fire on an innocent import.
  ok("the ban catches a banned name in a single-line import", importStatements(`import { EngineClient } from "./elsewhere.ts";\n`).some(bannedImport));
  ok("the ban catches a banned name in a MULTI-LINE import, which the per-line version did not", importStatements(`import {\n  EngineClient,\n  engineFetch,\n} from "./elsewhere.ts";\n`).some(bannedImport));
  ok("and the ban does not fire on an innocent multi-line import", !importStatements(`import {\n  classifyError,\n} from "../errors.ts";\n`).some(bannedImport));
  // The exact pair a substring rule gets wrong, and the reason the rule compares whole bindings: both of
  // these CONTAIN "Transport" and neither is the api/client Transport. client-diag/ring.ts imports both.
  ok("and not on CLIENT_DIAG_TRANSPORT_CLASS_SET or ClientDiagTransportClass, which merely contain the word", !importStatements(`import {\n  CLIENT_DIAG_TRANSPORT_CLASS_SET,\n  type ClientDiagTransportClass,\n} from "./vocab.ts";\n`).some(bannedImport));
  // The specifier arm, which catches a banned module imported under any local name at all.
  ok("the ban catches the api/client module however its bindings are named or aliased", importStatements(`import { thing as other } from "../api/client.ts";\n`).some(bannedImport));
  ok("the ban catches a namespace import of a banned binding", importStatements(`import Transport from "./somewhere.ts";\n`).some(bannedImport));
  ok("the walked graph really does contain a multi-line import, so the case above is live rather than theoretical", [...visited.values()].some((t) => importStatements(t).some((s) => s.includes("\n"))));
  ok("the transitive walk actually reached more than one file (else this proves nothing beyond the single-file check)", visited.size > 1);
  ok(`the walk covers keydecap.ts, client-diag/ring.ts and control-plane-recovery.ts (found ${visited.size} file(s) total)`, [...visited.keys()].some((f) => f.endsWith("/keydecap.ts")) && [...visited.keys()].some((f) => f.endsWith("/client-diag/ring.ts")) && [...visited.keys()].some((f) => f.endsWith("/control-plane-recovery.ts")));
  // THE FOUR NAME BANS READ CODE, NOT PROSE. A comment such as "what the browsers themselves say when
  // fetch() rejects with no response" in src/lib/errors.ts, inside this walk, would otherwise match
  // `\bfetch\s*\(` and turn this file red over a sentence describing behaviour rather than any code at
  // all. A raw-text scanner is wrong both ways round (it can also miss a real call that was commented
  // out), and blankComments is the repair for both directions.
  //
  // Blanking, not stripping: every comment byte becomes a space and newlines are kept, so a line number
  // taken from the blanked text still points at the same line. Import statements are read from the blanked
  // text for the same reason, so a commented-out import cannot be counted as a real one.
  //
  // AND THE BLANKING IS PROVED BEFORE IT IS TRUSTED, on the same principle the import ban above already
  // holds itself to: a scanner that has been made to find nothing is green for the same reason as one that
  // works. Both directions are asserted, because only the pair distinguishes them.
  ok("the ban still fires on a REAL call, so blanking comments has not blinded it", /\bfetch\s*\(/.test(blankComments(`const r = await fetch("/admin/status");\n`)));
  ok("and it no longer fires on the same words in a comment, which is what turned this file red", !/\bfetch\s*\(/.test(blankComments(`// what the browsers say when fetch() rejects\n`)));
  ok("blanking preserves line count, so any offset read off it still points at the right line", blankComments("// a\nfetch(1);\n").split("\n").length === "// a\nfetch(1);\n".split("\n").length);
  ok("and it leaves STRING literals intact, which the sibling gates below depend on", blankComments(`const s = "fetch(";\n`).includes('"fetch("'));
  for (const [file, text] of visited) {
    const rel = file.slice(file.indexOf("/src/"));
    const code = blankComments(text);
    ok(`${rel}: no fetch(`, !/\bfetch\s*\(/.test(code));
    ok(`${rel}: no XMLHttpRequest`, !/XMLHttpRequest/.test(code));
    ok(`${rel}: no sendBeacon`, !/sendBeacon/.test(code));
    ok(`${rel}: no WebSocket`, !/\bnew\s+WebSocket\b/.test(code));
    const statements = importStatements(code);
    ok(`${rel}: no import statement names EngineClient, Transport, api/client or engineFetch`, !statements.some(bannedImport));
  }
  const rootSrc = visited.get(root)!;
  ok("the identity parameter is never referenced inside a template string that could serialise it onto a request body", !/`[^`]*\$\{identity[^}]*\}[^`]*`/.test(rootSrc));

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} validate-sealed-export-unseal (${failures} failure(s))`);
  if (failures > 0) process.exitCode = 1;
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
