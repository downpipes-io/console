// Drift guard for the committed SPA bundle. The browser app is built from src/app.ts by
// scripts/stamp-build.mjs (the `build` script), which runs esbuild with code-splitting plus the
// `__CONSOLE_VERSION__` define (the console's own version, from package.json) and emits the deterministic
// public/__build.json version descriptor. The committed output is several files in public/: the entry app.js
// (referenced by public/index.html), a shared chunk-*.js, a lazy demo-fetch-*.js tour chunk fetched only on
// the tour host, and __build.json. They are committed (so a checkout carries the deployable bundle). This
// validator rebuilds the bundle from source by running THE SAME stamp-build script into a temp directory
// (one owner of the flags + define, so the guard and the build can never disagree) and byte-compares the
// full set of emitted .js files AND __build.json against the committed public/ copies, so the bundle can
// never silently drift from the source: a changed, missing or extra file all fail.
//
// Determinism: esbuild output (including the content-hashed chunk filenames) is byte-stable for a fixed
// esbuild version + source + flags + defines, so esbuild is pinned to an exact version in package.json, and
// __build.json is deliberately version-only (derived purely from package.json; no builtAt timestamp, no
// bundle hash), so a rebuild never churns bytes. A mismatch therefore means the source (or the package
// version) changed without a rebuild, or an artefact was hand-edited; the fix is `npm run build` then
// commit the public/ artefacts.
//
// One input is NOT source and this guard checks it directly. `--splitting` names the shared chunk
// chunk-<hash>.js, and esbuild folds each input module's path, printed relative to the process working
// directory, into that hash; `--minify` then strips those paths from the emitted bytes. So the same bytes
// can ship under two names, and this guard's file-name comparison would read "STALE" against a bundle that
// is not stale unless the working directory is pinned. scripts/stamp-build.mjs pins the working directory
// and refuses a symlinked node_modules for this reason, and the cwd-independence check below is the
// regression teeth for that pinning.
//
// Why splitting: a static import of the side-effectful tour entry would inline the whole tour subtree
// (~41 KB) into the single bundle every genuine-console visitor downloads. app.ts imports only the cheap
// isTourMode guard statically and loads startDemo() via a dynamic import, and --splitting makes the tour a
// lazy chunk, so the default app.js + shared chunk carry no tour code. This guard byte-checks all of them.
//
// No-custody / cost: this is a local, deterministic rebuild to a temp directory. No network, no deploy, no
// secret. The temp directory is removed in every path.
//
// FS-WRITES: none outside this repo

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, rmSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

// Run from the console package root (npm run validate sets cwd there).
const ESBUILD = join("node_modules", ".bin", "esbuild");
const STAMP_BUILD = join("scripts", "stamp-build.mjs");
// Resolved against COMPARE_ROOT below, which is "." for a clean tree and a HEAD worktree otherwise.
const PUBLIC = "public";
// A unique temp directory for the fresh split build (esbuild --splitting emits several files).
const FRESH_DIR = mkdtempSync(join(tmpdir(), "downpipe-app-bundle-"));

// jsFiles lists the .js artefacts in a directory (the build emits only .js plus __build.json, checked
// separately below; other public/ assets like index.html / tokens.css are not build output and are not
// part of this guard).
function jsFiles(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith(".js")).sort();
}

// THE FRESH BUILD IS OF THE WORKING TREE, WHICH IS NOT ALWAYS THE TREE THAT WAS COMMITTED. A commit made
// while any uncommitted source sits in the tree would bundle that uncommitted work, and this guard would
// then compare the committed artefacts against a build of the same dirty tree, agreeing with itself while
// disagreeing with HEAD.
//
// SO WHEN src/ IS DIRTY, THE COMPARISON COPY IS BUILT FROM A CLEAN CHECKOUT OF HEAD instead. A detached
// worktree gives one without disturbing the working tree. node_modules is HARDLINKED rather than symlinked:
// stamp-build.mjs refuses a symlink out of the repo, because esbuild resolves it to its real path and
// renames chunk-<hash>.js without changing a byte. A hardlink copy leaves real directories, so the refusal
// is satisfied honestly.
//
// If the clean checkout cannot be made, this REFUSES (exit 2, could-not-check) rather than falling back to
// the working-tree build, because that fallback is the exact false green this arm exists to remove.
const DIRTY_SRC = execFileSync("git", ["status", "--porcelain", "--", "src"], { encoding: "utf8" })
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l !== "" && /\.(ts|js|mjs|cjs)$/.test(l));

let COMPARE_ROOT = ".";
let HEAD_WORKTREE: string | null = null;
if (DIRTY_SRC.length > 0) {
  console.log(`-- src/ holds ${DIRTY_SRC.length} uncommitted source change(s), so the comparison copy is built from a clean checkout of HEAD --`);
  for (const l of DIRTY_SRC) console.log(`     ${l}`);
  const wt = mkdtempSync(join(tmpdir(), "downpipe-head-src-"));
  try {
    execFileSync("git", ["worktree", "add", "--detach", wt, "HEAD"], { stdio: "pipe" });
    HEAD_WORKTREE = wt;
    // Hardlink, not symlink: see above. cp -al is metadata only, so this is cheap in bytes if not in inodes.
    execFileSync("cp", ["-al", "node_modules", join(wt, "node_modules")], { stdio: "pipe" });
    COMPARE_ROOT = wt;
  } catch (e) {
    console.error(`src/ is dirty and a clean checkout of HEAD could not be prepared (${e instanceof Error ? e.message : String(e)}), so the only build available here would be a build of a tree nobody has landed. ` +
        "Comparing against that would answer a different question than this guard asks. Commit or revert the listed files, or fix the checkout, and run it again.",); process.exit(2);
  }
}

console.log("-- SPA bundle drift guard (public/*.js + __build.json vs a fresh stamp-build of src/app.ts) --");

ok("esbuild binary is present (pinned devDependency)", existsSync(ESBUILD));
ok("stamp-build script is present (the one owner of the build flags)", existsSync(STAMP_BUILD));
ok("committed entry bundle public/app.js exists", existsSync(join(PUBLIC, "app.js")));
ok("committed build descriptor public/__build.json exists", existsSync(join(PUBLIC, "__build.json")));

if (failures === 0) {
  try {
    // THE build (scripts/stamp-build.mjs), pointed at the temp directory: same flags, same define, same
    // __build.json emission as `npm run build`; --outdir changes only the directory, not the bytes.
    // COMPARE_ROOT is "." for a clean tree and a detached HEAD worktree when src/ is dirty, so the copy
    // this guard compares against is always a build of COMMITTED sources.
    execFileSync(process.execPath, [join(COMPARE_ROOT, STAMP_BUILD), `--outdir=${FRESH_DIR}`], { stdio: ["ignore", "ignore", "pipe"] });

    const fresh = jsFiles(FRESH_DIR);
    const committed = jsFiles(PUBLIC);

    // The committed set of .js filenames must match the fresh set exactly: a content-hashed chunk that
    // changed name (or an added/removed chunk) is a drift the byte-compare below could otherwise miss.
    const sameNames = fresh.length === committed.length && fresh.every((f, i) => f === committed[i]);
    ok(
      sameNames
        ? `committed bundle file set matches a fresh build (${fresh.length} file(s))`
        : `committed bundle file set is STALE (committed [${committed.join(", ")}] vs fresh [${fresh.join(", ")}]) - run 'npm run build' and commit public/*.js`,
      sameNames,
    );

    // Byte-compare every fresh file against its committed twin (only when the name sets agree, so each
    // fresh file has a committed counterpart to read).
    if (sameNames) {
      for (const f of fresh) {
        const a = readFileSync(join(FRESH_DIR, f));
        const b = readFileSync(join(PUBLIC, f));
        ok(
          a.equals(b)
            ? `committed ${f} matches a fresh build`
            : `committed ${f} is STALE (committed ${b.length}b vs fresh ${a.length}b) - run 'npm run build' and commit public/*.js`,
          a.equals(b),
        );
      }
    }

    // __build.json: byte-compare against the fresh build AND against the deterministic expected content
    // (version-only, straight from package.json), so a hand-edited descriptor, a stale version after a
    // bump, or a regression that reintroduces churning fields (builtAt, a hash) all fail loudly here.
    const freshBuild = readFileSync(join(FRESH_DIR, "__build.json"));
    const committedBuild = readFileSync(join(PUBLIC, "__build.json"));
    ok(
      freshBuild.equals(committedBuild)
        ? "committed __build.json matches a fresh build"
        : "committed __build.json is STALE - run 'npm run build' and commit public/__build.json",
      freshBuild.equals(committedBuild),
    );
    const pkgVersion = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version;
    const expected = `${JSON.stringify({ version: pkgVersion })}\n`;
    ok(
      committedBuild.toString("utf8") === expected
        ? `__build.json is the deterministic version-only descriptor for ${pkgVersion}`
        : `__build.json content drifted from the deterministic contract (want exactly ${JSON.stringify(expected)})`,
      committedBuild.toString("utf8") === expected,
    );

    // The version define must actually be baked into the committed entry bundle: the SPA reads its own
    // version from it, and the post-apply reload check depends on it. The bare identifier must be gone.
    const appJs = readFileSync(join(PUBLIC, "app.js"), "utf8");
    ok(`committed app.js carries the baked console version "${pkgVersion}"`, appJs.includes(JSON.stringify(pkgVersion)));
    ok("committed app.js has no unsubstituted __CONSOLE_VERSION__ identifier", !appJs.includes("__CONSOLE_VERSION__"));

    // The working directory must not be a build input. Build a second time from a directory that is not the
    // package root and require the same file names and the same bytes. Without stamp-build's chdir this
    // fails on the chunk NAME while every byte of the chunk is unchanged, which is the confusing shape that
    // which is easy to misdiagnose as a build fault. Absolute paths throughout, because cwd is the thing under test.
    const ELSEWHERE_DIR = mkdtempSync(join(tmpdir(), "downpipe-app-bundle-cwd-"));
    try {
      execFileSync(process.execPath, [resolve(join(COMPARE_ROOT, STAMP_BUILD)), `--outdir=${ELSEWHERE_DIR}`], {
        cwd: tmpdir(),
        stdio: ["ignore", "ignore", "pipe"],
      });
      const elsewhere = jsFiles(ELSEWHERE_DIR);
      const sameNamesElsewhere = elsewhere.length === fresh.length && elsewhere.every((f, i) => f === fresh[i]);
      ok(
        sameNamesElsewhere
          ? "a build run from another working directory emits the same file names (cwd is not a build input)"
          : `the working directory leaks into the bundle: from the package root [${fresh.join(", ")}], from elsewhere [${elsewhere.join(", ")}] - esbuild hashes module paths relative to cwd, so stamp-build must chdir to the package root`,
        sameNamesElsewhere,
      );
      if (sameNamesElsewhere) {
        const differing = elsewhere.filter((f) => !readFileSync(join(ELSEWHERE_DIR, f)).equals(readFileSync(join(FRESH_DIR, f))));
        ok(
          differing.length === 0
            ? "a build run from another working directory is byte-identical"
            : `a build run from another working directory differs in ${differing.join(", ")}`,
          differing.length === 0,
        );
      }
    } finally {
      rmSync(ELSEWHERE_DIR, { recursive: true, force: true });
    }
  } catch (e) {
    ok(`stamp-build rebuild succeeded (${(e as Error).message})`, false);
  } finally {
    rmSync(FRESH_DIR, { recursive: true, force: true });
  }
}

console.log(failures === 0 ? "\nBUNDLE DRIFT GUARD PASS" : `\n${failures} FAILURE(S)`);
// The worktree is removed with git rather than deleted: a parent-directory delete is how a pass destroyed
// twenty of them once, and git is the thing that knows about the administrative files.
if (HEAD_WORKTREE !== null) {
  try {
    execFileSync("git", ["worktree", "remove", "--force", HEAD_WORKTREE], { stdio: "pipe" });
  } catch {
    console.log(`  NOTE: the temporary HEAD worktree at ${HEAD_WORKTREE} could not be removed, so it is left for a human rather than deleted by hand.`);
  }
}

if (failures > 0) process.exitCode = 1;
if (failures > 0) process.exit(1);
