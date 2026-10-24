// Validates the release workflow's SHA256SUMS.txt step against the shape a user downloads.
//
// The release publishes the bundle flat, as console-X.Y.Z.json, beside SHA256SUMS.txt. The sums file
// must therefore name the bundle by its bare file name. A line that names dist/console-X.Y.Z.json is
// skipped by `sha256sum -c --ignore-missing` on a flat download, with exit 0.
//
// This check pulls the "Canonical sums manifest" run block out of .github/workflows/release.yml, runs it
// in a temp directory over fixture files, copies the outputs into a flat directory, and runs the exact
// command VERIFY.md gives. It passes only when that command prints "console-X.Y.Z.json: OK", and it
// fails when the bundle byte changes.
//
// Run with `node test/validate-release-sums-shape.ts`.

// FS-WRITES: none outside this repo

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
let checks = 0;
function ok(label: string, cond: boolean): void {
  checks++;
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

const VERSION = "9.9.9";
const BUNDLE = `console-${VERSION}.json`;

/** The shell body of the named workflow step, de-indented. Null when the step or its run block is absent. */
export function stepRunBlock(workflow: string, stepName: string): string | null {
  const lines = workflow.split("\n");
  const at = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
  if (at < 0) return null;
  const runAt = lines.findIndex((l, i) => i > at && /^\s+run: \|\s*$/.test(l));
  if (runAt < 0) return null;
  const indent = (lines[runAt + 1] ?? "").match(/^\s*/)?.[0].length ?? 0;
  if (indent === 0) return null;
  const body: string[] = [];
  for (let i = runAt + 1; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (l.trim() !== "" && (l.match(/^\s*/)?.[0].length ?? 0) < indent) break;
    body.push(l.slice(indent));
  }
  return body.join("\n");
}

/** Runs a sums step over fixture files, then checks the flat download the way VERIFY.md says. */
function gradeSumsStep(script: string): { sumsLines: string[]; okLine: boolean; okExit: number; tamperFailed: boolean; tamperExit: number } {
  const root = mkdtempSync(join(tmpdir(), "sums-shape-"));
  try {
    const build = join(root, "build");
    mkdirSync(join(build, "dist"), { recursive: true });
    writeFileSync(join(build, "dist", BUNDLE), '{"bundle":"fixture"}\n');
    writeFileSync(join(build, "release-facts.json"), '{"facts":"fixture"}\n');
    writeFileSync(join(build, "sbom.cdx.json"), '{"sbom":"fixture"}\n');
    const ran = spawnSync("bash", ["-c", script], { cwd: build, env: { ...process.env, VERSION }, encoding: "utf8" });
    if (ran.status !== 0) throw new Error(`sums step exited ${ran.status}: ${ran.stderr}`);
    const flat = join(root, "flat");
    mkdirSync(flat);
    copyFileSync(join(build, "dist", BUNDLE), join(flat, BUNDLE));
    for (const f of ["release-facts.json", "sbom.cdx.json", "SHA256SUMS.txt"]) copyFileSync(join(build, f), join(flat, f));
    const sumsLines = readFileSync(join(flat, "SHA256SUMS.txt"), "utf8").split("\n").filter(Boolean);
    const verify = spawnSync("bash", ["-c", "sha256sum -c --ignore-missing SHA256SUMS.txt"], { cwd: flat, encoding: "utf8" });
    const okLine = (verify.stdout ?? "").split("\n").includes(`${BUNDLE}: OK`);
    writeFileSync(join(flat, BUNDLE), '{"bundle":"fixture"}\nX');
    const tamper = spawnSync("bash", ["-c", "sha256sum -c --ignore-missing SHA256SUMS.txt"], { cwd: flat, encoding: "utf8" });
    return {
      sumsLines,
      okLine,
      okExit: verify.status ?? -1,
      tamperFailed: (tamper.stdout ?? "").includes(`${BUNDLE}: FAILED`),
      tamperExit: tamper.status ?? -1,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function main(): void {
  const workflow = readFileSync(resolve(import.meta.dirname, "../.github/workflows/release.yml"), "utf8");
  const step = stepRunBlock(workflow, "Canonical sums manifest");
  ok("the release workflow has a Canonical sums manifest step with a run block", step !== null);
  if (step === null) {
    console.log(`\n${failures} FAILURE(S) -- release sums shape (${checks} checks)`);
    verdictReached(failures, checks);
    process.exitCode = 1;
    return;
  }

  // Negative control: a sums step that lists the bundle under dist/. The check must refuse that shape, so a
  // check that cannot fail is caught.
  const dirShape = ["sha256sum", '"dist/console-$' + "{VERSION}" + '.json"', "release-facts.json sbom.cdx.json > SHA256SUMS.txt"].join(" ");
  const control = gradeSumsStep(dirShape);
  ok("negative control: the dist/ shape lists a folder path for the bundle", control.sumsLines.some((l) => l.endsWith(`  dist/${BUNDLE}`)));
  ok("negative control: the dist/ shape does not print the bundle OK line on a flat download", !control.okLine);

  const real = gradeSumsStep(step);
  ok("the sums file lists the bundle by its bare file name", real.sumsLines.some((l) => /^[0-9a-f]{64} {2}/.test(l) && l.endsWith(`  ${BUNDLE}`)));
  ok("the sums file lists no folder path", real.sumsLines.every((l) => !/ {2}.*\//.test(l)));
  ok("the sums file lists three files", real.sumsLines.length === 3);
  ok(`a flat download prints "${BUNDLE}: OK"`, real.okLine);
  ok("the flat check exits 0 when every file is intact", real.okExit === 0);
  ok(`one extra byte in the bundle prints "${BUNDLE}: FAILED"`, real.tamperFailed);
  ok("one extra byte in the bundle makes the flat check exit non-zero", real.tamperExit !== 0);

  console.log(`\n${failures === 0 ? "OK" : `${failures} FAILURE(S)`} -- release sums shape (${checks} checks)`);
  verdictReached(failures, checks);
  if (failures > 0) process.exitCode = 1;
}

main();
