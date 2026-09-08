// Locks the create-downpipe wizard's token-source GATE (appendSourceSections): the token-authenticated
// sections (Cloudflare config / Workers / Stream / Images / Artifacts) are offered only when the engine
// records them as ADDED (found.addedSources), with the load-bearing BACKWARD-COMPAT branch that an absent
// addedSources (older engine / env-token fallback) stays ungated and offers every supported type. The
// owner reported this misalignment twice, so this is a regression lock, not just coverage.
//
// Run: node test/cov/sources-cf-wide-gate.ts  (also auto-run by test/cov/run.mjs under the coverage gate)

import { installDomShim, qsa, textOf } from "../dom-shim.ts";

installDomShim();

const { h } = await import("../../src/lib/dom.ts");
const { appendSourceSections, cfConfigWithheldReason } = await import("../../src/screens/sources-downpipes/editor-wizard-source-sections.ts");
import type { SourceDiscovery } from "../../src/api.ts";
import type { SectionBuilders } from "../../src/screens/sources-downpipes/editor-wizard-source-sections.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

// Every section builder is a stub returning a marker row; appendSourceSections appends the section LABEL
// spans (.field__label) itself, so the test asserts on those to see which sections were offered.
const stubBuilders: SectionBuilders = {
  multiGroup: () => null,
  cfPresetControl: () => h("div"),
  cfAccountRow: () => h("div"),
  cfZoneGroup: () => h("div"),
  selectWorkers: () => h("div"),
  selectStream: () => h("div"),
  selectImages: () => h("div"),
  selectArtifacts: () => h("div"),
};

// A discovery result with EVERY token source supported + one browsed account, so the only thing deciding
// which sections render is the gate. addedSources is set per case.
function discovery(addedSources: string[] | undefined): SourceDiscovery {
  const base = {
    bound: { kv: [], r2: [], d1: [], secrets: [] },
    tokenPresent: true,
    engineAccountId: "a1",
    accounts: [{ accountId: "a1", accountName: "Acct One", kv: [], r2: [], d1: [], secrets: [], zones: [{ id: "z1", name: "example.com" }], errors: [] }],
    cfConfigSurfaces: [{ id: "dns_records", label: "DNS records", category: "DNS", scope: "zone" as const, restoreTier: "auto" }],
    workersSupported: true,
    streamSupported: true,
    imagesSupported: true,
    artifactsSupported: true,
  };
  return (addedSources === undefined ? base : { ...base, addedSources }) as SourceDiscovery;
}

function labelsFor(addedSources: string[] | undefined): string[] {
  const list = h("div");
  appendSourceSections(list, discovery(addedSources), stubBuilders);
  return qsa(list, ".field__label").map((n) => textOf(n));
}

const TOKEN_LABELS: Record<string, string> = {
  "cf-config": "Cloudflare configuration",
  workers: "Workers scripts",
  stream: "Cloudflare Stream",
  images: "Cloudflare Images",
  artifacts: "Cloudflare Artifact Registry",
};
const has = (labels: string[], type: string): boolean => labels.some((l) => l.includes(TOKEN_LABELS[type]!));

// Case A: addedSources ABSENT (older engine / env-token fallback) -> UNGATED, every supported token type
// offered EXCEPT Artifact Registry, which is held behind the ARTIFACTS_GA closed-beta gate (never offered
// while false, even ungated and advertised).
{
  const labels = labelsFor(undefined);
  ok("legacy (addedSources undefined): cf-config offered", has(labels, "cf-config"));
  ok("legacy: workers offered", has(labels, "workers"));
  ok("legacy: stream offered", has(labels, "stream"));
  ok("legacy: images offered", has(labels, "images"));
  ok("legacy: artifacts NOT offered (ARTIFACTS_GA beta gate)", !has(labels, "artifacts"));
}

// Case B: addedSources = a subset -> ONLY those types offered, the rest gated out.
{
  const labels = labelsFor(["workers", "images"]);
  ok("gated subset: workers offered (added)", has(labels, "workers"));
  ok("gated subset: images offered (added)", has(labels, "images"));
  ok("gated subset: cf-config NOT offered (not added)", !has(labels, "cf-config"));
  ok("gated subset: stream NOT offered (not added)", !has(labels, "stream"));
  ok("gated subset: artifacts NOT offered (not added)", !has(labels, "artifacts"));
}

// Case C: addedSources = [] (new engine, nothing added) -> NO token sections at all.
{
  const labels = labelsFor([]);
  ok("gated empty: no cf-config", !has(labels, "cf-config"));
  ok("gated empty: no workers", !has(labels, "workers"));
  ok("gated empty: no stream", !has(labels, "stream"));
  ok("gated empty: no images", !has(labels, "images"));
  ok("gated empty: no artifacts", !has(labels, "artifacts"));
}

// A WITHHELD Cloudflare-configuration section must say WHICH of its three reasons applies.
//
// The bug: when cf-config was not on offer the section simply did not render. On screen that is
// indistinguishable from the feature not existing, so an operator whose discovery token had expired or
// been rescoped (which makes the engine return an EMPTY surface catalogue) could not tell that apart
// from an engine too old to have the feature, or from a source nobody had added. The three have three
// different fixes. Each now gets its own sentence, and none of them carries a token, URL or API text.
{
  // A token IS stored (discovery() sets tokenPresent) and the engine still returned no catalogue. On the token
  // path the catalogue is a static compiled-in list, so the one fact this establishes is the engine's age. The
  // sentence used to hedge ("either its discovery token can no longer read your account ... or the engine
  // predates the feature"), which sent an operator to re-scope a token that was working perfectly.
  const noCatalogue = { ...discovery(["cf-config"]), cfConfigSurfaces: [] } as SourceDiscovery;
  const reasonNoCatalogue = cfConfigWithheldReason(noCatalogue, true, 1);
  ok("empty catalogue WITH a token: names the engine's age as the fact it establishes", reasonNoCatalogue.includes("predates the feature"));
  ok("empty catalogue WITH a token: prescribes the update, not a token hunt", reasonNoCatalogue.includes("Update the engine"));

  // NO TOKEN AT ALL: the default state of an install that backs up only bound sources. Account discovery is
  // opt-in, so this is not an old engine and the sentence must not send anyone to update one.
  const noToken = { ...discovery(["cf-config"]), tokenPresent: false, cfConfigSurfaces: [] } as SourceDiscovery;
  const reasonNoToken = cfConfigWithheldReason(noToken, true, 1);
  ok("no discovery token: says the token is missing", reasonNoToken.includes("no Cloudflare discovery token"));
  ok("no discovery token: never tells a healthy engine it is out of date", !reasonNoToken.includes("predates the feature"));
  ok("no discovery token: the two states are DIFFERENT sentences", reasonNoToken !== reasonNoCatalogue);

  const reasonNotAdded = cfConfigWithheldReason(discovery([]), false, 1);
  ok("not added: says it has not been added as a source", reasonNotAdded.includes("not been added as a source"));
  ok("not added: does NOT blame the token", !reasonNotAdded.includes("discovery token"));

  const reasonNoAccounts = cfConfigWithheldReason(discovery(["cf-config"]), true, 0);
  ok("no accounts: says the token could not read any account", reasonNoAccounts.includes("could not read any account"));

  // Every sentence names the control that fixes IT. Three of them are fixed under Sources; the fourth (a token
  // is stored and the engine still has no catalogue) is fixed by updating the engine, and saying "Sources" there
  // would send the operator to a screen that cannot help.
  ok("the Sources-fixable reasons name Sources", [reasonNoToken, reasonNotAdded, reasonNoAccounts].every((r) => r.includes("Sources")));
  ok("the engine-fixable reason names the engine", reasonNoCatalogue.includes("Update the engine"));
  // The reasons are DISTINCT (the whole point: different faults, different fixes).
  ok("the four reasons are distinct", new Set([reasonNoCatalogue, reasonNoToken, reasonNotAdded, reasonNoAccounts]).size === 4);

  // And the section RENDERS the reason, rather than vanishing: the gated-empty case above proves no
  // cf-config LABEL is offered, so this proves the operator is not left with silence.
  const list = h("div");
  appendSourceSections(list, discovery([]), stubBuilders);
  ok("the withheld section renders an explanation, never silence", textOf(list).includes("not on offer"));
}

console.log(failures === 0 ? "\nSOURCES-CF-WIDE-GATE VECTORS PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exitCode = 1;
if (failures > 0) process.exit(1);
