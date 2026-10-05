// SECURITY.md and .github/dependency-advisories.json must describe the same repository settings.
//
// SECURITY.md's "Repository settings" paragraph says secret scanning with push protection is on and that
// dependency-review.yml runs on every pull request to main, and it sends the reader to the notCovered block of
// .github/dependency-advisories.json for what the automated checks do not cover. That block said code and
// secret scanning were off and that the dependency review does not run. That was measured,
// before this source was published, and it is not true of the public repository SECURITY.md describes. A
// reader who followed the link got the opposite answer. This pins the two files to each other, and pins the
// licence claim to the workflow that makes it.
//
// Each premise is asserted on its own first, so a SECURITY.md that stops stating a setting fails here
// rather than making the agreement check below pass on nothing.
//
// FS-WRITES: none outside this repo

import { readFileSync } from "node:fs";
import { makeChecks } from "./validate-checks.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

const checks = makeChecks();
const { ok } = checks;

const read = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const securityMd = read("SECURITY.md").replace(/\s+/g, " ");
const advisories = JSON.parse(read(".github/dependency-advisories.json")) as { notCovered?: Record<string, string> };
const reviewWorkflow = read(".github/workflows/dependency-review.yml");
const notCovered = advisories.notCovered ?? {};
const channels = notCovered["github-security-api-channels"] ?? "";
const licences = notCovered.licences ?? "";

console.log("-- SECURITY.md and the notCovered block agree on the repository settings --");

ok("SECURITY.md sends the reader to the notCovered block", securityMd.includes("`notCovered` block of `.github/dependency-advisories.json`"));
ok("notCovered carries a github-security-api-channels entry", channels !== "");
ok("notCovered carries a licences entry", licences !== "");

const scanningOn = securityMd.includes("secret scanning with push protection is on");
ok("SECURITY.md states secret scanning with push protection is on", scanningOn);
ok(
  "notCovered does not say secret scanning is off or disabled",
  !/secret scanning (?:are|is) (?:off|disabled)|secret-scanning\/alerts answers 404/i.test(channels),
);
ok("notCovered does not say code scanning is off", !/code scanning and secret scanning are off|code-scanning\/analyses answers 403/i.test(channels));

const reviewRuns = securityMd.includes("`.github/workflows/dependency-review.yml` runs on every pull request");
ok("SECURITY.md states dependency-review.yml runs on every pull request", reviewRuns);
ok("notCovered does not say the dependency review does not run", !/does not run/i.test(licences));
ok("dependency-review.yml is triggered by pull_request", /^on:\s*\n\s+pull_request:/m.test(reviewWorkflow));

// The trigger filters on the base branch, so the review runs on a pull request to main and on no other.
// Both files said "every pull request" without that filter. Each must name the branch the trigger names.
const reviewBranches = /^on:\s*\n\s+pull_request:\s*\n\s+branches:\s*\[([^\]]*)\]/m.exec(reviewWorkflow);
const onlyBranch = reviewBranches === null ? null : (reviewBranches[1] ?? "").split(",").map((b) => b.trim().replace(/^["']|["']$/g, ""));
const branch = onlyBranch?.length === 1 ? (onlyBranch[0] ?? "") : "";
ok("dependency-review.yml filters pull_request on exactly one branch", branch !== "");
ok(`SECURITY.md says the review runs on pull requests to ${branch}`, securityMd.includes(`runs on every pull request to \`${branch}\``));
ok(`notCovered says the review runs on pull requests to ${branch}`, licences.includes(`runs on every pull request to ${branch} `));
ok(
  "the licence claim names the allow-list, and the workflow carries one",
  /allow-licenses/.test(licences) && /^\s+allow-licenses:\s*\S/m.test(reviewWorkflow),
);

console.log(checks.failures === 0 ? "\nSECURITY.MD SETTINGS PASS" : `\n${checks.failures} FAILURE(S)`);
verdictReached(checks.failures);
if (checks.failures > 0) process.exit(1);
