// Deterministic console release-bundle build (DP-B). Produces the downpipe-console-bundle/1
// document the update channel publishes as console-<version>.json, as a repeatable function of
// the committed source alone, IN THIS REPO, so the console repo's own CI can build and attest
// its artefact without reaching across repos.
//
// CONTRACT: the output must be BYTE-IDENTICAL to what the engine repo's vendor publisher
// (tools/publish-channel.mjs buildConsoleBundle) packages from the same tree. The two
// implementations are held together by the ceremony's digest check: publish-channel
// --from-release refuses to sign a console artefact whose digest the CI attestation does not
// name, so any drift between the two builders surfaces as a refusal at the owner's desk, never
// as a silently different published bundle. The packaging rules that make the bytes stable:
//   - assets walked in SORTED "/"-prefixed POSIX order (walkAssets), no timestamps anywhere;
//   - per-asset sha256 + base64 content, content type by extension from one fixed map;
//   - the shell worker built by `wrangler deploy --dry-run` (wrangler exact-pinned via the
//     lockfile, telemetry off), the same bytes a real deploy pushes;
//   - version from package.json alone (`npm run build` stamps __build.json from it first);
//   - two-space JSON.stringify of a fixed key order.
//
// Guards mirror the engine's build-release.mjs: the tree must be clean (--allow-dirty for local
// experiments only) so a release artefact is always a function of a commit.
//
// Usage:
//   node scripts/build-release-bundle.mjs                 # writes dist/console-<version>.json
//   node scripts/build-release-bundle.mjs --out <path>    # explicit artefact path
//   node scripts/build-release-bundle.mjs --allow-dirty   # local experiments only
//   node scripts/build-release-bundle.mjs --skip-build    # package the tree as-is (CI calls
//                                                         # npm run build itself first)
// Prints JSON: { version, out, sha384, sha256, bytes, assets }.
//
// FS-WRITES: none outside this repo

import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONSOLE_DIR = path.join(SCRIPT_DIR, "..");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq >= 0) out[a.slice(2, eq)] = a.slice(eq + 1);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) out[a.slice(2)] = argv[++i];
    else out[a.slice(2)] = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (!args["allow-dirty"]) {
  const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: CONSOLE_DIR, encoding: "utf8" }).trim();
  if (dirty !== "") {
    process.stderr.write(`build-release-bundle: the git tree is dirty; a release artefact must build from committed source alone. Commit or stash first (or --allow-dirty for a local experiment):\n${dirty}\n`);
    process.exit(1);
  }
}

// The same fixed extension map as the vendor publisher; anything unlisted serves as octet-stream.
const CONSOLE_ASSET_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".json", "application/json"],
  [".txt", "text/plain; charset=utf-8"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
  [".woff2", "font/woff2"],
]);
function contentTypeFor(p) {
  return CONSOLE_ASSET_TYPES.get(path.extname(p).toLowerCase()) ?? "application/octet-stream";
}

// SORTED "/"-prefixed POSIX-relative paths: the ordering is what makes the bundle byte-stable.
function walkAssets(dir, base = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkAssets(p, base, out);
    else out.push(`/${path.relative(base, p).split(path.sep).join("/")}`);
  }
  return out.sort();
}

function readConsoleStaticConfig(consoleDir) {
  const toml = readFileSync(path.join(consoleDir, "wrangler.toml"), "utf8");
  const compatibilityDate = toml.match(/^[ \t]*compatibility_date[ \t]*=[ \t]*["']([^"']+)["']/m)?.[1] ?? "2026-06-01";
  const runWorkerFirst = /^[ \t]*run_worker_first[ \t]*=[ \t]*true/m.test(toml);
  const cpuMs = toml.match(/cpu_ms[ \t]*=[ \t]*(\d+)/)?.[1];
  const config = { compatibilityDate, runWorkerFirst };
  if (cpuMs) config.limits = { cpu_ms: Number(cpuMs) };
  return config;
}

// Stamp __build.json + the version define exactly as a real build does, unless CI already ran it.
if (!args["skip-build"]) {
  execFileSync("npm", ["run", "build"], { cwd: CONSOLE_DIR, stdio: ["ignore", "ignore", "inherit"] });
}

// The shell worker: the exact bytes `wrangler deploy` would push, telemetry off, locale fixed.
const outDir = mkdtempSync(path.join(tmpdir(), "downpipe-console-release-"));
let workerSource;
try {
  execFileSync("npx", ["wrangler", "deploy", "--dry-run", "--outdir", outDir], {
    cwd: CONSOLE_DIR,
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", TZ: "UTC", LC_ALL: "C" },
  });
  const entry = path.join(outDir, "worker.js");
  if (!existsSync(entry)) {
    const present = readdirSync(outDir).join(", ");
    throw new Error(`the console dry-run produced no worker.js (found: ${present || "nothing"})`);
  }
  workerSource = new Uint8Array(readFileSync(entry));
} finally {
  try {
    rmSync(outDir, { recursive: true, force: true });
  } catch {
    /* best effort cleanup */
  }
}

const pub = path.join(CONSOLE_DIR, "public");
if (!existsSync(pub)) {
  process.stderr.write(`build-release-bundle: the console public/ directory is missing (${pub}); run the console build first\n`);
  process.exit(1);
}
const assets = walkAssets(pub).map((rel) => {
  const bytes = new Uint8Array(readFileSync(path.join(pub, rel.slice(1))));
  return { path: rel, contentType: contentTypeFor(rel), sha256: createHash("sha256").update(bytes).digest("hex"), b64: Buffer.from(bytes).toString("base64") };
});

const version = JSON.parse(readFileSync(path.join(CONSOLE_DIR, "package.json"), "utf8")).version;
const bundle = {
  format: "downpipe-console-bundle/1",
  version,
  worker: { mainModule: "worker.js", sourceB64: Buffer.from(workerSource).toString("base64") },
  config: readConsoleStaticConfig(CONSOLE_DIR),
  assets,
};
const text = JSON.stringify(bundle, null, 2);
const bytes = new TextEncoder().encode(text);

const outPath = typeof args.out === "string" ? args.out : path.join(CONSOLE_DIR, "dist", `console-${version}.json`);
mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, bytes);

// sha384 via WebCrypto (hex, lower-case) matches the engine's gating digest scheme; sha256 is the
// supply-chain tooling lingua franca (SHA256SUMS, cosign subjects, SLSA provenance).
const digest384 = Buffer.from(await crypto.subtle.digest("SHA-384", bytes)).toString("hex");
const digest256 = createHash("sha256").update(bytes).digest("hex");

// CI identifiers (present only under GitHub Actions): these become the channel's provenance block
// via the ceremony, which REFUSES a facts file without them, so a local package can never be
// passed off as an attested release. They ride release-facts.json, which SHA256SUMS.txt names and
// the release workflow cosign-signs, so they are CI's own attested claims, not operator input.
const ciFacts = {
  ...(process.env.GITHUB_REPOSITORY ? { repo: process.env.GITHUB_REPOSITORY } : {}),
  ...(process.env.GITHUB_SHA ? { commit: process.env.GITHUB_SHA } : {}),
  ...(process.env.GITHUB_REF_TYPE === "tag" && process.env.GITHUB_REF_NAME ? { tag: process.env.GITHUB_REF_NAME } : {}),
  ...(process.env.GITHUB_RUN_ID ? { runId: process.env.GITHUB_RUN_ID } : {}),
};
process.stdout.write(`${JSON.stringify({ version, out: outPath, sha384: digest384, sha256: digest256, bytes: bytes.length, assets: assets.length, ...ciFacts }, null, 2)}\n`);
