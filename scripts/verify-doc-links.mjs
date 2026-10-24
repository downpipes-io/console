// Doc-link gate: every docs.downpipes.io link in the console source must resolve to a real page,
// its #anchor must match a real heading, and the target page must not defer the answer to another
// page. This is the check that catches the failure plain existence-checking passes: a link that
// resolves but lands on a page that defers the answer elsewhere. Pairs with the field census.
//
//   node scripts/verify-doc-links.mjs           # gate: exit 1 on any dead/deferring link
//   node scripts/verify-doc-links.mjs --fix     # print the proposed edit for each dead anchor; writes nothing
//   node scripts/verify-doc-links.mjs --require # fail rather than skip when ../docs is absent (CI)
//
// --require turns that skip into a FAILURE. CI passes it, because CI checks the sibling out precisely so this
// can run, and a gate that quietly opts out when it cannot check reads as a pass. The plain skip stays for a
// single-repo developer checkout, where blocking would make the gate unrunnable for anyone editing this repo
// alone. That is the same posture the cross-repo `workspace` job in .github/workflows/ci.yml already takes.
//
// Needs the docs repo checked out as a sibling (../docs). When it is absent (a console-only
// checkout) the gate SKIPS with a note and exits 0, so it never breaks a build that cannot see docs.
//
// FS-WRITES: none outside this repo

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { findWorkspaceDir } from "./workspace-root.mjs";
import { scanDocLinks, isSourceFile, isSkippedDir, proposeFix } from "./doc-link-collect.mjs";
import { CATALOGUE, docsUrl } from "../src/screens/integrations/catalogue.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src");

// WHERE THE DOCS SIBLING IS, resolved rather than assumed. Using join(HERE, "..", "..", "docs") would
// assert the console checkout's parent is the workspace root, so from a worktree at
// <root>/console/.worktrees/<name> it would point at <root>/console/.worktrees/docs, which is precisely
// where a stale copy of a sibling lingers. Refusing when a sibling is ABSENT does not help when the guess
// lands on a real but unrelated docs tree: every link would be graded against a stranger's pages and
// reported resolving, which is wrong rather than merely incomplete.
const DOCS_MARKER = join("docs", "src", "content", "docs");
const WORKSPACE = findWorkspaceDir(join(HERE, ".."), DOCS_MARKER);
const DOCS_REPO = WORKSPACE === null ? null : join(WORKSPACE, "docs");
const DOCS = WORKSPACE === null ? null : join(WORKSPACE, DOCS_MARKER);
const DEFER_RE = /full remedy is on|remedy is the same one|exact fix[^.]*is on/i;
const FIX = process.argv.includes("--fix");

if (DOCS === null || !existsSync(DOCS)) {
  const msg = "docs repo did not resolve beside this checkout, so the doc-link gate did not run";
  if (process.argv.includes("--require")) {
    console.error(`[verify-doc-links] ${msg}. Refusing to pass without checking (--require).`);
    // Exit 2, not 1: 1 is reserved for a real dead/deferring link found below.
    process.exit(2);
  }
  console.log(`[verify-doc-links] ${msg}; skipping.`);
  process.exit(0);
}

// A docs checkout merely BEHIND its own origin/main can still carry a page or heading upstream has since
// removed, or lack one upstream has since added: either way this would grade a link against a page that no
// longer describes it. No fetch, so unknown freshness (no origin/main ref) is not judged either way.
// VERIFY_DOC_LINKS_ALLOW_STALE=1 overrides.
if (process.env.VERIFY_DOC_LINKS_ALLOW_STALE !== "1") {
  /** @type {number | null} */
  let behind = null;
  try {
    behind = Number(execFileSync("git", ["-C", /** @type {string} */ (DOCS_REPO), "rev-list", "--count", "HEAD..origin/main"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
  } catch { /* unknown freshness, nothing to conclude */ }
  if (Number.isFinite(behind) && /** @type {number} */ (behind) > 0) {
    console.error(`[verify-doc-links] FAIL: ${DOCS_REPO} is ${behind} commit(s) behind its own origin/main.`);
    console.error("  Every link below would be graded against pages that have since moved, and reported resolving.");
    console.error("  Update the checkout, or set VERIFY_DOC_LINKS_ALLOW_STALE=1 if an old tree is deliberate.");
    process.exit(2);
  }
}

const slug = (s) => s.trim().toLowerCase().replace(/`/g, "").replace(/[^\w\s-]/g, "").replace(/\s+/g, "-");
const headingSlugs = (file) => {
  const out = new Set();
  for (const l of readFileSync(file, "utf8").split("\n")) {
    const m = /^#{1,6}\s+(.*)$/.exec(l.trim());
    if (m) out.add(slug(m[1].replace(/[*_`]/g, "").trim()));
  }
  return out;
};
const walk = (d, acc) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) { if (!isSkippedDir(e.name, d === SRC)) walk(p, acc); }
    else if (isSourceFile(e.name)) acc.push(p);
  }
  return acc;
};
// --fix WRITES NOTHING. For a dead anchor it prints, per link, the file:line, the line as it is and the line as
// it would be with exactly that anchor removed, for a person to apply. A link whose anchor has no recorded
// span (a template expansion, a link inside prose) gets no proposal and is listed as one to edit by hand.
function proposeAnchorFix(relFile, url, templateValues) {
  const text = readFileSync(join(SRC, relFile), "utf8");
  return proposeFix(text, url, { templateValues }).map((p) => ({ where: `src/${relFile}:${p.line}`, before: p.before, after: p.after }));
}

// The integrations catalogue builds its docs URL from a template, `https://docs.downpipes.io/integrations/${slug}`
// (src/screens/integrations/catalogue.ts, docsUrl). The slug is not in the text, so the real function is
// run over the real catalogue and every URL it returns is graded. Any other template URL with an
// expression has no value list here and FAILS below, with its file and line.
const INTEGRATIONS_PREFIX = "https://docs.downpipes.io/integrations/";
const integrationSlugs = [...new Set(CATALOGUE.map((v) => docsUrl(v)))].map((u) => {
  if (!u.startsWith(INTEGRATIONS_PREFIX)) {
    console.error(`[verify-doc-links] FAIL: catalogue docsUrl() returned ${u}, which is outside ${INTEGRATIONS_PREFIX}.`);
    process.exit(1);
  }
  return u.slice(INTEGRATIONS_PREFIX.length);
});
const templateValues = { [INTEGRATIONS_PREFIX]: integrationSlugs };

const found = new Map();
const where = new Map();
let unresolvedCount = 0;
for (const f of walk(SRC, [])) {
  const rel = f.replace(`${SRC}/`, "");
  const scan = scanDocLinks(readFileSync(f, "utf8"), { templateValues });
  for (const { url, line } of scan.urls) {
    (found.get(url) ?? found.set(url, new Set()).get(url)).add(rel);
    (where.get(url) ?? where.set(url, new Set()).get(url)).add(`${rel}:${line}`);
  }
  for (const u of scan.unresolved) {
    unresolvedCount++;
    console.log(`  [UNRESOLVED ] src/${rel}:${u.line}\n               ${u.why}`);
  }
}

// A floor on how many links were collected. `bad` counts links that FAILED, so a scan that collected
// none prints "all 0 console doc links resolve" and exits 0. The collection is a walk over src plus one
// href regex, and either half can quietly stop matching: narrow the extension test, move src, or change
// how the console writes a doc link, and the count goes to zero without anything else changing. The console
// carries on the order of a hundred distinct docs.downpipes.io URLs, and the floor of 40 sits well under
// that, so tidying a batch of links does not trip it and a collapse cannot pass.
//
// It sits AFTER the ../docs skip above, deliberately. On the --require path (the workspace job, where the
// sibling exists) it always applies. On the plain path it applies whenever the gate actually ran, and
// never converts the single-repo skip into a failure, because that branch has already exited.
if (found.size < 40) {
  console.error(`[verify-doc-links] FAIL: collected ${found.size} docs.downpipes.io link(s) from src, expected at least 40.`);
  console.error("The link scan is no longer finding what the console ships, so a clean result here would be a statement about nothing.");
  process.exit(1);
}

let bad = unresolvedCount;
for (const [url, files] of [...found].sort()) {
  const u = new URL(url);
  const anchor = decodeURIComponent(u.hash.replace(/^#/, ""));
  const path = u.pathname.replace(/^\//, "").replace(/\/$/, "");
  const file = join(DOCS, `${path}.mdx`);
  const exists = existsSync(file);
  const anchorOk = !anchor ? true : exists && headingSlugs(file).has(anchor);
  const defers = exists && DEFER_RE.test(readFileSync(file, "utf8"));
  const status = !exists ? "PAGE 404" : !anchorOk ? "ANCHOR DEAD" : defers ? "DEFERS" : "ok";
  if (status !== "ok") {
    bad++;
    console.log(`  [${status.padEnd(11)}] ${url}\n               in: ${[...(where.get(url) ?? files)].join(", ")}`);
    if (FIX && status === "ANCHOR DEAD") {
      let any = false;
      for (const relFile of files) {
        for (const p of proposeAnchorFix(relFile, url, templateValues)) {
          any = true;
          console.log(`  [PROPOSED  ] ${p.where}\n               before: ${p.before.trim()}\n               after:  ${p.after.trim()}`);
        }
      }
      if (!any) console.log("  [PROPOSED  ] none: edit this link by hand (nothing was written)");
    }
  }
}

if (bad) {
  console.error(`\n[verify-doc-links] FAIL: ${bad} dead, deferring or unresolvable link(s) among ${found.size} graded. Fix the anchor/page, write the URL as one plain string, or run --fix to print the proposed edits.`);
  process.exit(1);
}
console.log(`[verify-doc-links] OK: all ${found.size} console doc links resolve, anchors valid, none defer.`);
