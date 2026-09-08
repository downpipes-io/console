#!/usr/bin/env node
//
// FS-WRITES: none outside this repo

// The console build with a version stamp (npm run build). One script owns the esbuild invocation so the
// build and the bundle drift guard (test/validate-bundle.ts, which runs this script into a temp directory
// and byte-compares) can never disagree about the flags or the injected define.
//
// What it stamps, and why it is DETERMINISTIC:
//   1. `--define:__CONSOLE_VERSION__="<version>"` bakes the console's own version (the single source of
//      truth: package.json `version`) into the bundle, read via src/lib/console-version.ts. The SPA finally
//      knows what it is, so it can compare itself against the update channel's recommended console version.
//   2. `public/__build.json` = `{"version":"<version>"}` + newline: the version the SERVING ORIGIN carries.
//      The SPA fetches it (cache: no-store) after a console update to confirm the origin now serves the new
//      version before prompting a reload. Its content is derived PURELY from package.json, nothing else: no
//      builtAt timestamp and no bundle hash, because those would churn on every rebuild while the committed
//      bundle bytes did not, breaking the byte-compare discipline the bundle drift guard enforces (and
//      putting meaningless diffs in every commit). The version alone is what the post-apply check needs.
//
// Determinism overall: esbuild output is byte-stable for a fixed esbuild version + source + flags (esbuild
// is pinned exactly in package.json), and the define + __build.json derive only from package.json.
//
// THE ONE INPUT THAT IS NOT SOURCE, AND HOW IT IS PINNED HERE. `--splitting` names the shared chunk
// chunk-<hash>.js, and esbuild folds each input module's path, written the way esbuild would print it
// (relative to the process working directory), into that hash. `--minify` strips those paths from the
// emitted bytes, so two builds can emit a byte-identical chunk under two different names, and the drift
// guard, which compares the file-name set first, then reads as "STALE" against a bundle that is not stale.
// Different working directories produce different chunk names but byte-identical chunk content, so the
// operating system is not an input: a macOS build in a clean checkout reproduces CI's Linux bytes exactly.
//
// So this script pins the two path inputs rather than hoping the caller has them right:
//   - it chdirs to the repo root and hands esbuild RELATIVE paths, so the module paths esbuild hashes are
//     always `src/...` and `node_modules/...` whatever directory `npm run build` was invoked from;
//   - it refuses when node_modules is a symlink out of the repo, because esbuild resolves it to its real
//     path and the dependency paths become `../<something>/node_modules/...`, which the chdir cannot reach.
// --outdir is resolved to an absolute path before the chdir, and does not feed the hash.
//
// Each pin is then ASSERTED, because the two assertions have different blind spots and neither alone covers
// the property. cwd is checked directly against the package root, since the path-escape check cannot see an
// ANCESTOR cwd (every module path is a relative descent, so nothing starts with `../`); the path-escape
// check reads the metafile, since the node_modules test cannot see individual packages that resolve
// elsewhere while node_modules itself is a real directory. Both were confirmed by mutation.
//
// Usage: node scripts/stamp-build.mjs [--outdir=DIR]   (default DIR: public)

import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, readdirSync, writeFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));

const outdirArg = process.argv.slice(2).find((a) => a.startsWith("--outdir="));
const outdirRaw = outdirArg ? outdirArg.slice("--outdir=".length) : join(ROOT, "public");
if (outdirArg && outdirRaw === "") {
  console.error("[stamp-build] --outdir= needs a directory");
  process.exit(1);
}
// Absolute BEFORE the chdir: a relative --outdir must still mean what the caller meant by it.
const outdir = resolve(outdirRaw);

// The single source of console version identity: package.json `version`. Refuse a non-semver value loudly
// rather than baking garbage into the bundle and __build.json.
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const version = typeof pkg.version === "string" ? pkg.version.trim() : "";
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`[stamp-build] package.json version ${JSON.stringify(pkg.version)} is not a plain semver triple (x.y.z)`);
  process.exit(1);
}

// node_modules must BE in the repo root, not a symlink to somewhere else. esbuild resolves the symlink and
// then prints (and hashes) every bundled dependency as `../<wherever>/node_modules/@noble/...`, which moves
// the chunk hash even though the emitted bytes are unchanged. Refusing here is the honest outcome: the
// alternative is a bundle that looks built and cannot pass the drift guard on any other machine.
const NODE_MODULES = join(ROOT, "node_modules");
let nodeModulesReal;
try {
  nodeModulesReal = realpathSync(NODE_MODULES);
} catch {
  console.error(`[stamp-build] ${NODE_MODULES} is missing. Run 'npm ci' in the console package root.`);
  process.exit(1);
}
if (nodeModulesReal !== NODE_MODULES) {
  console.error(`[stamp-build] node_modules resolves to ${nodeModulesReal}, outside the console package root.`);
  console.error("[stamp-build] esbuild hashes each bundled module's path into the split-chunk filename, so a");
  console.error("[stamp-build] symlinked node_modules renames chunk-<hash>.js without changing a single byte of");
  console.error("[stamp-build] it, and the committed bundle then fails the drift guard everywhere else.");
  console.error("[stamp-build] Install into the package root ('npm ci' here) rather than linking one in.");
  process.exit(1);
}

mkdirSync(outdir, { recursive: true });

// The working directory IS a build input (see the header): esbuild writes module paths relative to it and
// folds them into the split-chunk hash. Anchor it to the repo root and pass relative paths, so `npm run
// build` from a subdirectory, and the drift guard spawning this script from anywhere, all emit one bundle.
process.chdir(ROOT);

// Assert the anchor rather than assuming the chdir took. The property this build depends on is narrower
// than "process.chdir did not throw": the chunk hash is stable only if cwd IS the package root, and the
// path-escape check further down CANNOT see the case where cwd is an ANCESTOR of it. From an ancestor
// every module path is a plain relative descent (`bed/console/src/lib/errors.ts`), which neither starts
// with `../` nor is absolute, so that filter passes while the chunk is renamed anyway. With the chdir
// removed and cwd one level up, the build can emit a differently-named chunk with byte-identical
// contents and the escape check raises nothing. The direct check below is for the thing that actually
// matters, so it does not share that blind spot.
const cwdNow = realpathSync(process.cwd());
if (cwdNow !== ROOT) {
  console.error(`[stamp-build] the working directory is ${cwdNow}, not the package root ${ROOT}.`);
  console.error("[stamp-build] esbuild writes each module's path relative to cwd and folds it into the");
  console.error("[stamp-build] chunk-<hash>.js filename, so building from anywhere else renames the chunk");
  console.error("[stamp-build] without changing one byte of it, and the committed bundle then reads as STALE");
  console.error("[stamp-build] on every other machine. Refusing rather than emitting a bundle nobody can reproduce.");
  process.exit(1);
}

// Everything is built into a staging directory and copied into outdir only once the path-escape check
// below has passed, so a refusal never leaves a half-written or unreproducible bundle in public/. The
// metafile goes here too, because outdir is byte-compared against the committed bundle.
const STAGING = mkdtempSync(join(tmpdir(), "downpipe-stamp-"));
const METAFILE = join(STAGING, "meta.json");

// Cleanup on EXIT rather than only in a finally block. The refusals below (the vacuous metafile, the
// path-escape filter) call process.exit(1), which skips finally entirely, so a staging directory holding a
// full copy of the bundle survived every refusal, left behind in TMPDIR. An exit handler runs on
// process.exit() as well as on a normal return, and rmSync with force is idempotent, so the finally below
// stays as the ordinary path and this covers the rest.
process.on("exit", () => rmSync(STAGING, { recursive: true, force: true }));

// The exact build the old `npm run build` ran, plus the version define. JSON.stringify(version) yields the
// quoted string literal esbuild substitutes for the __CONSOLE_VERSION__ identifier.
// The binary is spawned by absolute path (where the executable lives is not a build input); only the ENTRY
// POINT is relative, because that is what esbuild echoes into the module paths it hashes.
try {
  execFileSync(
    join(NODE_MODULES, ".bin", "esbuild"),
    [
      join("src", "app.ts"),
      "--bundle",
      "--minify",
      "--format=esm",
      "--platform=browser",
      "--splitting",
      `--define:__CONSOLE_VERSION__=${JSON.stringify(version)}`,
      `--outdir=${join(STAGING, "out")}`,
      `--metafile=${METAFILE}`,
    ],
    { stdio: ["ignore", "inherit", "inherit"] },
  );

  // THE PROPERTY CHECK, on the paths esbuild actually recorded. The node_modules test above is the cheap,
  // well-named case; it is not the only way a dependency reaches outside the checkout. `npm link`, a `file:`
  // dependency and a store-based installer all leave node_modules itself a real directory while individual
  // packages inside it resolve elsewhere, and every one of those moves the chunk hash the same way. So this
  // asserts the invariant directly: no input esbuild hashed may escape the package root. A metafile with no
  // inputs is REFUSED, because a check that finds nothing to check is not a passing check.
  const inputs = Object.keys(JSON.parse(readFileSync(METAFILE, "utf8")).inputs ?? {});
  if (inputs.length === 0) {
    console.error("[stamp-build] the build recorded NO input modules, so the path-escape check has nothing to");
    console.error("[stamp-build] verify. Refusing rather than reporting a vacuous pass.");
    process.exit(1);
  }
  const escaping = inputs.filter((p) => p.startsWith("../") || isAbsolute(p));
  if (escaping.length > 0) {
    console.error(`[stamp-build] ${escaping.length} of ${inputs.length} bundled modules resolve outside the package root:`);
    for (const p of escaping.slice(0, 10)) console.error(`[stamp-build]   ${p}`);
    if (escaping.length > 10) console.error(`[stamp-build]   ... and ${escaping.length - 10} more`);
    console.error("[stamp-build] esbuild hashes these paths into chunk-<hash>.js, so this bundle would carry a name");
    console.error("[stamp-build] nobody else reproduces while its bytes are identical. Install dependencies into");
    console.error("[stamp-build] this package root ('npm ci' here) rather than linking them in from elsewhere.");
    process.exit(1);
  }

  // PRUNE BEFORE WRITING, so a rebuild leaves ONE coherent set rather than three overlapping ones. esbuild
  // names the split chunks chunk-<hash>.js and demo-fetch-<hash>.js, so any source change renames them, and
  // a copy-only build left public/ holding a MODIFIED app.js, the NEW hashed chunks (untracked) and the OLD
  // hashed chunks (still tracked and now orphaned) at the same time. Staging app.js looked complete in `git
  // status` and was not, and the bundle drift guard refused with a stale FILE SET rather than stale bytes.
  // That guard is unchanged and still compares the whole set: what changes here is that the state it exists
  // to catch stops being produced.
  //
  // The build owns exactly the .js files at the top level of outdir (test/validate-bundle.ts compares that
  // same set), so nothing else in public/ is touched: tokens.css, index.html, llms.txt and favicon.svg are
  // not build output. On a fresh --outdir this is a no-op.
  const fresh = new Set(readdirSync(join(STAGING, "out")));
  for (const f of readdirSync(outdir)) {
    if (!f.endsWith(".js") || fresh.has(f)) continue;
    rmSync(join(outdir, f));
    console.log(`[stamp-build] pruned ${f}, renamed away by this build`);
  }
  for (const f of fresh) {
    copyFileSync(join(STAGING, "out", f), join(outdir, f));
  }

  // The deterministic build descriptor the serving origin exposes at /__build.json (see the header note for
  // why it is version-only). Byte-exact: JSON.stringify + one trailing newline, so rebuilds never churn it.
  writeFileSync(join(outdir, "__build.json"), `${JSON.stringify({ version })}\n`);
} finally {
  rmSync(STAGING, { recursive: true, force: true });
}

console.log(`[stamp-build] built ${outdir} at console version ${version} (deterministic __build.json)`);
