// The restore receipt must SHOW a fidelity shortfall, not just classify one.
//
// WHY THIS EXISTS
// ---------------
// The classifier is already covered (validate-stepup-dest-idp.ts): a restore that lost TTLs or dropped D1
// schema objects returns kind "reduced" rather than "clean". That is only half the claim. The half a
// customer experiences is whether the receipt on screen SAYS so, and this session has twice produced an
// engine-side safety signal that no screen rendered: the cross-zone warning, then five fidelity fields the
// console did not even declare. A classifier that returns the right string into a screen that ignores it
// is the same failure wearing a passing test.
//
// So this drives the REAL renderReceipt under the shared DOM shim and reads the rendered text.
//
// It also pins POSITION, which is not decoration. "3,000 records restored" reads as unqualified success,
// so a qualification arriving below it is read after the impression has already formed. The shortfall
// block must come before the headline figures in document order.
//
// Run with `node test/validate-restore-fidelity-render.ts`.

import { installDomShim, qs, textOf } from "./dom-shim.ts";
installDomShim();

import type { RestoreResult } from "../src/lib/api/types/restore-types.ts";
import { fidelityShortfalls, renderReceipt, restoreOutcome } from "../src/screens/restore-flow/receipt.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

const base: RestoreResult = {
  ok: true,
  runId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  mode: "applied",
  recordsVerified: 3000,
  recordsRestored: 3000,
  bytesRestored: 1024 * 1024,
  isLatest: true,
  failures: [],
  complete: true,
};

const render = (res: RestoreResult): { text: string; el: HTMLElement } => {
  const el = renderReceipt(res, "op@example.com", "hash", null, () => undefined);
  return { text: textOf(el), el };
};

console.log("-- a full-fidelity restore is unqualified --");
{
  const { text } = render(base);
  ok("a clean restore does not claim anything did not carry across", !/did not carry across/i.test(text));
  ok("a clean restore still reports its records", /3,?000/.test(text));
}

console.log("\n-- dropped metadata is SHOWN, not merely classified --");
{
  const res: RestoreResult = { ...base, metadataFieldsDropped: { cacheExpiry: 12 } };
  ok("the classifier calls it reduced", restoreOutcome(res).kind === "reduced");
  const { text } = render(res);
  ok("the receipt says some data did not carry across in full", /did not carry across/i.test(text));
  ok("it NAMES the field, not just a count", /cacheExpiry/.test(text));
  // The whole line, not a bare number. textOf concatenates without separators, so the rendered text reads
  // "...in full12 record(s)..." and a \b-anchored digit match cannot fire: "l" and "1" are both word
  // characters, so there is no boundary between them. Asserting the line is immune to that and is the
  // stronger claim anyway, because it pins what the operator actually reads.
  ok("it carries the count, as part of the sentence the operator reads", text.includes("12 record(s) lost their cacheExpiry"));
  ok("it does not present as an unqualified success", /reduced fidelity/i.test(text));
}

console.log("\n-- each shortfall kind reaches the screen --");
for (const [label, res, needle] of [
  ["filtered D1 schema objects", { ...base, d1SchemaObjectsFiltered: 5 }, /index/i],
  ["a D1 fault", { ...base, d1Fault: { d1ErrorClass: "constraint" } }, /D1 restore fault/i],
  ["media that did not re-upload", { ...base, mediaFaults: { upload: 3 } }, /did not re-upload/i],
  ["media id conflicts", { ...base, mediaConflictDigests: [{ archivedSha384: "a", liveSha384: "b" }] }, /already held different live bytes/i],
] as Array<[string, RestoreResult, RegExp]>) {
  const { text } = render(res);
  ok(`${label} is rendered`, needle.test(text));
}

console.log("\n-- a shed metadata field reads as its OWN outcome, not as one sentence for all of them --");
{
  // The engine keeps `kv-expiration` and `kv-expiration-lapsed` as separate members of
  // METADATA_SHED_FIELDS precisely because they are different conversations with the customer: an
  // UNUSABLE expiration is a defect signal (something wrote a value the format does not allow), while a
  // LAPSED one is the ordinary consequence of restoring a backup older than the namespace's TTLs. This
  // screen collapsed both into "which could not be reproduced" and printed the raw wire key, so on the
  // more ordinary of the two it named the wrong cause AND spoke in the transport's words.
  //
  // These assert the TEXT the operator reads. Asserting only that a line appeared is the vacuous shape
  // this session has already removed six of: the whole defect was a line that appeared and was wrong.
  const lineFor = (field: string, n: number): string => {
    const lines = fidelityShortfalls({ ...base, metadataFieldsDropped: { [field]: n } });
    ok(`${field} produces exactly one shortfall line`, lines.length === 1);
    return lines[0] ?? "";
  };

  const lapsed = lineFor("kv-expiration-lapsed", 3);
  ok("a lapsed expiry does NOT claim the value could not be reproduced", !/could not be reproduced/i.test(lapsed));
  ok("it says the archived expiry had already passed", /already passed/i.test(lapsed));
  ok("it speaks of KV keys rather than the raw wire key", /KV key/.test(lapsed) && !lapsed.includes("kv-expiration-lapsed"));
  ok("it tells the operator to set a TTL again", /TTL/.test(lapsed));
  ok("it carries the count as part of the sentence", lapsed.startsWith("3 KV key(s)"));

  const unusable = lineFor("kv-expiration", 2);
  ok("an UNUSABLE expiry keeps the defect-signal wording", /could not be reproduced/i.test(unusable));
  ok("and it does not claim the expiry had passed, which is the other member's cause", !/already passed/i.test(unusable));
  ok("the two KV members do not read as the same outcome", unusable !== lapsed);
  ok("neither prints the raw wire key", !unusable.includes("kv-expiration"));

  const r2 = lineFor("r2-cache-expiry", 5);
  ok("a shed R2 cache-expiry is named in the operator's words", /cache-expiry/.test(r2) && !r2.includes("r2-cache-expiry"));
  ok("and it keeps the defect-signal wording, because an unparseable date is one", /could not be reproduced/i.test(r2));

  // The wording has to reach the SCREEN, not merely the classifier.
  const { text } = render({ ...base, metadataFieldsDropped: { "kv-expiration-lapsed": 3 } });
  ok("the lapsed sentence is what the receipt renders", text.includes(lapsed));
  ok("the raw wire key never reaches the screen", !text.includes("kv-expiration-lapsed"));
}

console.log("\n-- the signed receipt is offered as a DOWNLOAD, and only when there is one --");
{
  // The attestation is the artefact an auditor gets months later, and offering it is the entire point of
  // surfacing the receipt at all. Nothing in this repo asserted it: the only proof was a browser journey in
  // a separate manual check, so deleting the download from this screen left the console suite green.
  const withReceipt: RestoreResult = {
    ...base,
    receipt: { runId: base.runId, restoredAt: "2026-07-27T00:00:00.000Z", isLatest: true, records: [], summary: { recordsRestored: 3000, bytesRestored: 1024, allVerified: true }, receiptSha384: "sha384:abc" },
  };
  const { el } = render(withReceipt);
  const dl = qs(el, '[data-dp="restore-flow.button.deliver-file"]');
  ok("a receipt is offered as a download", dl !== null);
  ok("and the control says what it is, because that is what someone looks for", /receipt/i.test(textOf(dl ?? el)));

  // The other direction. A dry run writes nothing and carries no receipt, so offering a download would
  // promise an artefact that does not exist.
  const { el: none } = render(base);
  ok("NO download is offered when the engine returned no receipt", qs(none, '[data-dp="restore-flow.button.deliver-file"]') === null);
}

console.log("\n-- POSITION: the qualification precedes the payoff figures --");
{
  const { text } = render({ ...base, metadataFieldsDropped: { cacheExpiry: 12 } });
  const shortfallAt = text.search(/did not carry across/i);
  const figuresAt = text.search(/3,?000/);
  ok("both the shortfall and the figures rendered, so this comparison is not vacuous", shortfallAt >= 0 && figuresAt >= 0);
  ok("the shortfall appears BEFORE the records figure", shortfallAt < figuresAt);
}

console.log("\n-- a failure and a shortfall are different problems and both are shown --");
{
  const res: RestoreResult = { ...base, recordsRestored: 2990, failures: [{ name: "k1", reason: "denied" }], metadataFieldsDropped: { cacheExpiry: 4 } };
  ok("a failure still outranks the shortfall in the title", restoreOutcome(res).kind === "failed");
  const { text } = render(res);
  ok("the failure is reported", /failure/i.test(text));
  ok("and the shortfall is reported alongside it, not swallowed by it", /did not carry across/i.test(text) && /cacheExpiry/.test(text));
}

console.log(failures === 0 ? "\nRESTORE FIDELITY RENDER PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exitCode = 1; // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
if (failures > 0) process.exit(1);
