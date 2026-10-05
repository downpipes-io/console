// The credentials "Used for" usage link (usageContextLink, screens/credentials/helpers.ts) navigates
// to an allowlisted path INSIDE this console (navigate(), never window.open or an <a target="_blank">),
// so it must carry no external-link glyph: that glyph tells an operator a click leaves the console, and
// this one never does.
// Run with: node test/validate-credentials-usage-link-icon.ts

import { installDomShim } from "./dom-shim.ts";

installDomShim();

import { usageContextLink } from "../src/screens/credentials/helpers.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
let checks = 0;

function ok(label: string, cond: boolean): void {
  checks += 1;
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures += 1;
}

const link = usageContextLink({ kind: "destination", refId: "dest-1" }, "Primary bucket") as HTMLElement;
ok("the usage link renders the label", link.textContent === "Primary bucket");
ok("the usage link carries no svg: an in-app navigation shows no external-link glyph", link.querySelector("svg") === null);

// The no-link placeholder is untouched by this fix: still a quiet hyphen, still no glyph.
const placeholder = usageContextLink(undefined, "Primary bucket") as HTMLElement;
ok("the no-link placeholder stays a quiet hyphen", placeholder.textContent === "-");
ok("the no-link placeholder carries no svg either", placeholder.querySelector("svg") === null);

verdictReached(failures, checks);
console.log(`validate-credentials-usage-link-icon: ${checks} checks, ${failures} failures`);
if (failures > 0) {
  console.error(`validate-credentials-usage-link-icon: ${failures} FAILURES`);
  process.exit(1);
}
