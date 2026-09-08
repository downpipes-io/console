// Validate the guided "add a source" flow's pure core (src/lib/add-source.ts) and its
// capability gate. The screen (src/screens/add-source.ts) composes these; the load-bearing
// logic is the binding-name validator, the EXACT wrangler.toml stanza/command generators, and
// the no-secret-value guarantee for the Secrets Store path.
//
// Run with `node test/validate-add-source.ts` after `npm install`. Prints one line per check;
// exits non-zero on any failure. No network, no token, no secret value: a Secrets Store source
// is referenced by store id + name only, which this asserts.
//
// Coverage (per the build brief):
//   - each store type + inputs -> the generated wrangler.toml stanza matches the expected EXACT
//     text (KV / R2 / D1 / Secrets Store), and the full copy-block (stanza + state-3 reminder +
//     deploy command) matches exactly;
//   - an invalid binding name is rejected (empty, non-identifier, reserved-binding collision),
//     and a valid one is accepted;
//   - a Secrets Store source never renders or collects a secret VALUE (no value field exists;
//     the stanza references store_id + secret_name only and contains no value);
//   - the flow is capability-gated: a viewer (no downpipe.write) cannot reach the emit/create
//     action, while operator / approver / owner can (the SAME gate the create-downpipe editor
//     uses; lib/identity.ts can());
//   - the console's RESERVED_BINDINGS mirror matches the engine's set byte-for-byte (when the
//     engine source is present in the checkout), so the two cannot drift.

import {
  STORE_TYPES,
  storeTypeLabel,
  validateBindingName,
  isValidBindingName,
  validateSourceInput,
  wranglerStanza,
  fullBlock,
  draftStanza,
  draftBlock,
  deployCommand,
  DEPLOY_COMMENT,
  RESERVED_BINDINGS,
  BINDING_NAME_PATTERN,
  HEX_ID_PATTERN,
  UUID_OR_HEX_ID_PATTERN,
  RESOURCE_NAME_PATTERN,
  type SourceInput,
} from "../src/lib/add-source.ts";
import { can, ROLE_CAPABILITIES, type Role } from "../src/lib/identity.ts";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { engineRoot } from "./engine-root.ts";

let failures = 0;

function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

function eq(label: string, got: string, want: string): void {
  const cond = got === want;
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}\n    got=${JSON.stringify(got)}\n    want=${JSON.stringify(want)}`);
  if (!cond) failures++;
}

// ---------------------------------------------------------------------------
// 1. Exact wrangler.toml stanza per store type.
// ---------------------------------------------------------------------------
console.log("\n-- exact wrangler.toml stanza per store type --");

// KV: [[kv_namespaces]] binding + id (engine/wrangler.toml + downpipe init.go Step 2).
const kvInput: SourceInput = { type: "kv", binding: "SRC_KV_uploads", namespaceId: "0f2ac7c1b6e0470a8b1f" };
eq(
  "KV namespace stanza",
  wranglerStanza(kvInput),
  '[[kv_namespaces]]\nbinding = "SRC_KV_uploads"\nid = "0f2ac7c1b6e0470a8b1f"',
);

// R2: [[r2_buckets]] binding + bucket_name (engine archive binding shape).
const r2Input: SourceInput = { type: "r2", binding: "SRC_R2_assets", bucketName: "assets-prod" };
eq(
  "R2 bucket stanza",
  wranglerStanza(r2Input),
  '[[r2_buckets]]\nbinding = "SRC_R2_assets"\nbucket_name = "assets-prod"',
);

// D1: [[d1_databases]] binding + database_name + database_id (init.go Step 2).
const d1Input: SourceInput = { type: "d1", binding: "SRC_D1_app", databaseName: "app-db", databaseId: "62a9f0e2-1c34-4d56-8a90-abcdef012345" };
eq(
  "D1 database stanza",
  wranglerStanza(d1Input),
  '[[d1_databases]]\nbinding = "SRC_D1_app"\ndatabase_name = "app-db"\ndatabase_id = "62a9f0e2-1c34-4d56-8a90-abcdef012345"',
);

// Secrets Store: [[secrets_store_secrets]] binding + store_id + secret_name (the shape proven
// live in control-plane/wrangler.toml). NO value field.
const secInput: SourceInput = { type: "secrets", binding: "SRC_SECRET_api", storeId: "6e32e830825542ef86170c1b634df9e6", secretName: "API_KEY" };
eq(
  "Secrets Store stanza",
  wranglerStanza(secInput),
  '[[secrets_store_secrets]]\nbinding = "SRC_SECRET_api"\nstore_id = "6e32e830825542ef86170c1b634df9e6"\nsecret_name = "API_KEY"',
);

// The full copy-block (stanza + blank + reminder comment + deploy command), exact, for one
// representative type. The reminder + command are stable constants. The command MUST be the
// guided `npm run deploy` (binding-safe superset reconcile), never a bare `npx wrangler deploy`
// which replaces the live bindings with wrangler.toml's and drops console-attached sources
// (operations/deploy-safety-bindings is the authority; the fieldwalk audit found the old bare
// command contradicted it).
eq(
  "full copy-block (KV) is exact",
  fullBlock(kvInput),
  [
    '[[kv_namespaces]]',
    'binding = "SRC_KV_uploads"',
    'id = "0f2ac7c1b6e0470a8b1f"',
    '',
    '# Uses your wrangler login (or a scoped deploy token; revoke it after). Token scopes: docs.downpipes.io/operations/cloudflare-token-scopes',
    'cd engine && npm run deploy',
  ].join("\n"),
);
eq("deploy command is the engine-dir GUIDED deploy, never bare wrangler", deployCommand(), "cd engine && npm run deploy");
ok("the reminder points at the public token-scopes doc, not a repo file", DEPLOY_COMMENT.includes("docs.downpipes.io/operations/cloudflare-token-scopes") && !DEPLOY_COMMENT.includes("CLOUDFLARE-PERMISSIONS.md"));
ok("every full block ends with the deploy command", STORE_TYPES.every((t) => fullBlock(sampleFor(t)).trimEnd().endsWith(deployCommand())));

// Whitespace is trimmed from identifiers before emission (a trailing space in a pasted id does
// not corrupt the stanza).
eq(
  "identifiers are trimmed in the stanza",
  wranglerStanza({ type: "kv", binding: "  SRC_KV_x  ", namespaceId: "  abc123  " }),
  '[[kv_namespaces]]\nbinding = "SRC_KV_x"\nid = "abc123"',
);

// ---------------------------------------------------------------------------
// 2. Binding-name validation.
// ---------------------------------------------------------------------------
console.log("\n-- binding-name validation --");

ok("valid uppercase binding accepted", isValidBindingName("SRC_KV_uploads"));
ok("valid lowercase identifier accepted (engine accepts it too)", isValidBindingName("src_kv_uploads"));
ok("leading underscore accepted", isValidBindingName("_internal_src"));
ok("single letter accepted", isValidBindingName("K"));

ok("empty binding rejected", validateBindingName("") !== null);
ok("whitespace-only binding rejected", validateBindingName("   ") !== null);
ok("leading digit rejected (JS identifier rule)", validateBindingName("1KV") !== null);
ok("dash rejected", validateBindingName("SRC-KV") !== null);
ok("dot rejected", validateBindingName("SRC.KV") !== null);
ok("space rejected", validateBindingName("SRC KV") !== null);
ok("over-64-chars rejected", validateBindingName("A".repeat(65)) !== null);
ok("exactly-64-chars accepted", isValidBindingName("A".repeat(64)));

// Reserved-binding collision: each engine reserved binding is rejected by name.
for (const reserved of ["SCHEDULER", "DEST_R2", "SIGNER_PRIVATE", "CONSOLE_ORIGIN", "ADMIN_TOKEN"]) {
  ok(`reserved binding ${reserved} rejected`, validateBindingName(reserved) !== null);
}
ok("a reserved name is rejected with a reason naming it", (validateBindingName("DEST_R2") ?? "").includes("DEST_R2"));

// validateSourceInput surfaces a binding error against the "binding" field.
{
  const errs = validateSourceInput({ type: "kv", binding: "1bad", namespaceId: "x" });
  ok("invalid binding flagged on the binding field", errs.some((e) => e.field === "binding"));
}

// ---------------------------------------------------------------------------
// 3. Per-field validation of the identifiers Cloudflare needs.
// ---------------------------------------------------------------------------
console.log("\n-- per-field identifier validation --");

ok("KV requires a namespace id", validateSourceInput({ type: "kv", binding: "SRC_KV_x", namespaceId: "" }).some((e) => e.field === "namespaceId"));
ok("R2 requires a bucket name", validateSourceInput({ type: "r2", binding: "SRC_R2_x", bucketName: "" }).some((e) => e.field === "bucketName"));
ok("D1 requires a database name", validateSourceInput({ type: "d1", binding: "SRC_D1_x", databaseName: "", databaseId: "62a9f0e2-1c34-4d56-8a90-abcdef012345" }).some((e) => e.field === "databaseName"));
ok("D1 requires a database id", validateSourceInput({ type: "d1", binding: "SRC_D1_x", databaseName: "n", databaseId: "" }).some((e) => e.field === "databaseId"));
ok("Secrets requires a store id", validateSourceInput({ type: "secrets", binding: "SRC_S_x", storeId: "", secretName: "N" }).some((e) => e.field === "storeId"));
ok("Secrets requires a secret name", validateSourceInput({ type: "secrets", binding: "SRC_S_x", storeId: "6e32e830825542ef86170c1b634df9e6", secretName: "" }).some((e) => e.field === "secretName"));

// A fully-valid input of each type passes with no errors.
for (const t of STORE_TYPES) {
  ok(`valid ${storeTypeLabel(t)} input passes validation`, validateSourceInput(sampleFor(t)).length === 0);
}

// ---------------------------------------------------------------------------
// 3b. TOML-injection guard: an identifier carrying a
//     TOML-breaking character (quote, newline, bracket, backslash) is REJECTED before
//     the stanza is generated, while a valid identifier still generates the stanza.
// ---------------------------------------------------------------------------
console.log("\n-- TOML-injection guard on the identifier fields --");

// The injection payloads a crafted identifier could carry to break out of a quoted TOML string:
// a quote (close the string + add a key), a newline (open a new line / table), a bracket (open a
// table), and a backslash (TOML escape). None must survive into a stanza.
const tomlBreakers: Array<{ name: string; value: string }> = [
  { name: "double quote", value: 'a"b' },
  { name: "quote + injected key", value: 'x"\nmalicious = "1' },
  { name: "newline", value: "a\nb" },
  { name: "open bracket (new table)", value: "a[b" },
  { name: "close bracket", value: "a]b" },
  { name: "backslash", value: "a\\b" },
  { name: "literal injected table", value: '"]\n[[r2_buckets]]\nbinding = "EVIL' },
];

// Build a SourceInput of each type that places the crafted value in the named identifier field,
// keeping every OTHER field valid, so the only reason for rejection is the crafted field.
function inputWith(field: string, value: string): SourceInput {
  switch (field) {
    case "namespaceId": return { type: "kv", binding: "SRC_KV_x", namespaceId: value };
    case "bucketName": return { type: "r2", binding: "SRC_R2_x", bucketName: value };
    case "databaseName": return { type: "d1", binding: "SRC_D1_x", databaseName: value, databaseId: "62a9f0e2-1c34-4d56-8a90-abcdef012345" };
    case "databaseId": return { type: "d1", binding: "SRC_D1_x", databaseName: "db-x", databaseId: value };
    case "storeId": return { type: "secrets", binding: "SRC_S_x", storeId: value, secretName: "NAME" };
    case "secretName": return { type: "secrets", binding: "SRC_S_x", storeId: "6e32e830825542ef86170c1b634df9e6", secretName: value };
    default: throw new Error(`unknown field ${field}`);
  }
}

for (const field of ["namespaceId", "bucketName", "databaseName", "databaseId", "storeId", "secretName"]) {
  for (const b of tomlBreakers) {
    const errs = validateSourceInput(inputWith(field, b.value));
    ok(`${field} rejects ${b.name}`, errs.some((e) => e.field === field));
  }
}

// The whole point: a crafted value never reaches the stanza generator with the field accepted.
// Confirm that for a value that IS accepted, the stanza contains no injected table or key, and
// the rendered output is still a clean two-or-three-line stanza (no extra lines from a breaker).
{
  const cleanKv = wranglerStanza({ type: "kv", binding: "SRC_KV_ok", namespaceId: "0f2ac7c1b6e0470a8b1f1234567890ab" });
  ok("a clean KV stanza has no injected newline beyond its 3 lines", cleanKv.split("\n").length === 3);
  ok("a clean KV stanza has no stray quote past the id", (cleanKv.match(/"/g) ?? []).length === 4);
}

// Direct quote/backslash injection: wranglerStanza performs no
// escaping, so the guarantee is that validateSourceInput rejects a quote- or backslash-bearing
// identifier BEFORE the stanza is ever generated. Assert the rejection for each crafted value,
// and confirm that the stanza generator, if fed the same value, would emit it verbatim (which is
// exactly why the value must never pass validation).
for (const field of ["namespaceId", "bucketName", "databaseName", "databaseId", "storeId", "secretName"]) {
  for (const crafted of ['x"y', "x\\y", 'a"]\n[[r2_buckets]]\nbinding = "EVIL']) {
    const input = inputWith(field, crafted);
    ok(
      `${field} rejects a quote/backslash value before stanza generation`,
      validateSourceInput(input).some((e) => e.field === field),
    );
    ok(
      `wranglerStanza would emit the crafted ${field} verbatim (so validation must gate it)`,
      wranglerStanza(input).includes(crafted),
    );
  }
}

// And the valid identifiers still pass (the green half of red-before-green): a real hex KV id, a
// UUID D1 id, a hex store id, and dashed/underscored resource names all generate with no error.
ok("valid hex KV namespace id accepted", validateSourceInput({ type: "kv", binding: "SRC_KV_ok", namespaceId: "0f2ac7c1b6e0470a8b1f1234567890ab" }).length === 0);
ok("valid UUID D1 database id accepted", validateSourceInput({ type: "d1", binding: "SRC_D1_ok", databaseName: "app-db_2", databaseId: "62a9f0e2-1c34-4d56-8a90-abcdef012345" }).length === 0);
ok("valid hex Secrets Store id accepted", validateSourceInput({ type: "secrets", binding: "SRC_S_ok", storeId: "6e32e830825542ef86170c1b634df9e6", secretName: "API_KEY-1" }).length === 0);
ok("dashed R2 bucket name accepted", validateSourceInput({ type: "r2", binding: "SRC_R2_ok", bucketName: "assets-prod_01" }).length === 0);

// The exported patterns themselves: each rejects the breakers and accepts a representative value.
ok("HEX_ID_PATTERN rejects a quote", !HEX_ID_PATTERN.test('0f2a"'));
ok("HEX_ID_PATTERN accepts a 32-char hex id", HEX_ID_PATTERN.test("0f2ac7c1b6e0470a8b1f1234567890ab"));
ok("HEX_ID_PATTERN rejects a non-hex letter", !HEX_ID_PATTERN.test("ns123ggggggg"));
ok("UUID_OR_HEX_ID_PATTERN accepts a UUID", UUID_OR_HEX_ID_PATTERN.test("62a9f0e2-1c34-4d56-8a90-abcdef012345"));
ok("UUID_OR_HEX_ID_PATTERN accepts a bare hex id", UUID_OR_HEX_ID_PATTERN.test("62a9f0e21c344d568a90abcdef012345"));
ok("UUID_OR_HEX_ID_PATTERN rejects a newline", !UUID_OR_HEX_ID_PATTERN.test("62a9f0e2\n"));
ok("RESOURCE_NAME_PATTERN accepts a dashed name", RESOURCE_NAME_PATTERN.test("assets-prod_01"));
ok("RESOURCE_NAME_PATTERN rejects a bracket", !RESOURCE_NAME_PATTERN.test("a[b"));
ok("RESOURCE_NAME_PATTERN rejects a leading hyphen", !RESOURCE_NAME_PATTERN.test("-bad"));

// ---------------------------------------------------------------------------
// 4. The Secrets Store source NEVER renders or collects a secret value.
// ---------------------------------------------------------------------------
console.log("\n-- Secrets Store: no secret value collected or rendered --");

// The SecretsSourceInput shape carries no value field. We construct one with a sentinel value
// in EVERY string field and assert the sentinel never appears in the rendered stanza/block via
// a value-bearing key: the stanza references store_id + secret_name only.
const secretSentinel = "SUPER_SECRET_VALUE_SHOULD_NEVER_RENDER";
// The only way a value could leak is if a future edit added it to a field; assert the type's
// own fields cannot carry it into the output. We put the sentinel as the secret NAME (a public
// key, legitimately rendered) and confirm there is no SECOND occurrence implying a value field.
const secWithSentinelName: SourceInput = { type: "secrets", binding: "SRC_SECRET_x", storeId: "store-1", secretName: secretSentinel };
const secStanza = wranglerStanza(secWithSentinelName);
ok("secrets stanza has no `value =` key", !/\bvalue\s*=/.test(secStanza));
ok("secrets stanza has no `secret_value` key", !secStanza.includes("secret_value"));
ok("secrets stanza references store_id", secStanza.includes("store_id ="));
ok("secrets stanza references secret_name", secStanza.includes("secret_name ="));
// The secret NAME is a public reference and is the ONLY place the (sentinel) string appears.
ok("secret name appears exactly once (as the reference, not duplicated as a value)", occurrences(secStanza, secretSentinel) === 1);
// The full block likewise carries no value key.
ok("full secrets block has no value key", !/\bvalue\s*=/.test(fullBlock(sampleFor("secrets"))));

// Belt-and-braces: the SourceInput union for secrets must not contain a `value`-like key. We
// enumerate the keys of a constructed secrets input and assert none looks like a value field.
{
  const keys = Object.keys(secWithSentinelName);
  ok("secrets input has no value-like key", !keys.some((k) => /value|secretvalue|plaintext/i.test(k)));
  ok("secrets input keys are exactly type/binding/storeId/secretName", keys.sort().join(",") === ["binding", "secretName", "storeId", "type"].sort().join(","));
}

// ---------------------------------------------------------------------------
// 5. Capability gate: viewer cannot reach the emit/create action; operator+ can.
//    The screen gates the emit (generate stanza) and configure controls on
//    canCap("downpipe.write"), which delegates to can(role, "downpipe.write").
// ---------------------------------------------------------------------------
console.log("\n-- capability gate (downpipe.write, the create-downpipe gate) --");

const GATE = "downpipe.write" as const;
ok("viewer does NOT hold downpipe.write (cannot reach emit/create)", !can("viewer", GATE));
ok("restore-operator does NOT hold downpipe.write", !can("restore-operator", GATE));
ok("access-admin does NOT hold downpipe.write", !can("access-admin", GATE));
ok("operator holds downpipe.write (can add a source)", can("operator", GATE));
ok("approver holds downpipe.write", can("approver", GATE));
ok("owner holds downpipe.write", can("owner", GATE));

// The set of roles that can add a source must EXACTLY equal the set that can create/edit a
// downpipe (no looser path): both are "holds downpipe.write".
{
  const roles: Role[] = ["viewer", "operator", "restore-operator", "approver", "access-admin", "owner"];
  const canAdd = roles.filter((r) => can(r, GATE)).sort();
  const canCreateDownpipe = roles.filter((r) => ROLE_CAPABILITIES[r].has("downpipe.write")).sort();
  eq("add-source role set == create-downpipe role set", canAdd.join(","), canCreateDownpipe.join(","));
}

// ---------------------------------------------------------------------------
// 6. RESERVED_BINDINGS mirror matches the engine byte-for-byte (when present).
// ---------------------------------------------------------------------------
console.log("\n-- RESERVED_BINDINGS mirror vs the engine set --");

const _here = dirname(fileURLToPath(import.meta.url));
// The engine defines RESERVED_BINDINGS somewhere under src/sched/ (it lived in scheduler-do.ts and
// now lives in config-validate.ts after the section-6 split). Scan the directory for whichever file
// carries the Set literal rather than pinning a filename, so this mirror check survives the move and
// any future relocation. The scan is read-only and stays inside the sibling engine checkout.
// Resolved through the shared helper rather than hardcoded, so an explicit DOWNPIPES_ENGINE can point
// this at a known checkout. This was the ONE cross-repo reader here with no override, and it
// failed against a sibling working tree 44 commits behind its own origin/main: the mirror's 40 names were
// right and the 38 it compared against were stale, with no way to aim it anywhere better.
const engineRootPath = engineRoot();
const engineSchedDir = engineRootPath === null ? "" : join(engineRootPath, "src", "sched");
if (existsSync(engineSchedDir)) {
  let src = "";
  for (const f of readdirSync(engineSchedDir)) {
    if (!f.endsWith(".ts")) continue;
    const text = readFileSync(join(engineSchedDir, f), "utf8");
    if (text.includes("RESERVED_BINDINGS = new Set")) { src = text; break; }
  }
  const engineSet = parseEngineReserved(src);
  ok("engine RESERVED_BINDINGS parsed (non-empty)", engineSet.size > 0);
  // Same membership both ways.
  const consoleExtra = [...RESERVED_BINDINGS].filter((b) => !engineSet.has(b));
  const engineExtra = [...engineSet].filter((b) => !RESERVED_BINDINGS.has(b));
  ok(`console mirror has no binding the engine lacks (extra: ${consoleExtra.join(", ") || "none"})`, consoleExtra.length === 0);
  ok(`console mirror is missing none the engine has (missing: ${engineExtra.join(", ") || "none"})`, engineExtra.length === 0);
  eq("mirror size matches engine size", String(RESERVED_BINDINGS.size), String(engineSet.size));
} else {
  // Isolated console checkout (each component is its own git repo): the engine source is not present, so
  // the cross-repo byte-for-byte check did not run. The mirror's own self-consistency is still asserted
  // below, which is why the exit code stays 0 here.
  //
  // CANNOT CHECK, AND A REQUIRE ARM THAT DID NOT EXIST. This file had neither: in a checkout with no sibling
  // engine it exited 0 with REQUIRE_ENGINE=1 exactly as it did without,
  // announcing the miss in lower case among a hundred ok lines. RESERVED_BINDINGS is the mirror that went
  // red against a sibling 44 commits stale, so it is precisely the comparison that must not
  // be allowed to pass by not happening.
  console.log("CANNOT CHECK the engine RESERVED_BINDINGS cross-check: engine source not present in this checkout");
  if (process.env.REQUIRE_ENGINE === "1") {
    console.error("validate-add-source: REFUSED, REQUIRE_ENGINE=1 and no engine checkout is reachable.\n" +
        "  The console's RESERVED_BINDINGS mirror is graded against the engine's own Set under src/sched,\n" +
        "  so with no engine the mirror is only checked against itself and this file will not report that\n" +
        "  the cross-repo comparison passed.\n" +
        "  Point it at one with DOWNPIPES_ENGINE=/path/to/engine and re-run.",); process.exit(2);
  }
  ok("console RESERVED_BINDINGS is non-empty", RESERVED_BINDINGS.size > 0);
  ok("console RESERVED_BINDINGS contains the load-bearing entries", ["SCHEDULER", "DEST_R2", "SIGNER_PRIVATE", "BREAK_GLASS_PUBLIC"].every((b) => RESERVED_BINDINGS.has(b)));
}

// The pattern is a subset of the engine's looser binding regex (no leading digit), so every
// name the console accepts is one the engine accepts. Spot-check the boundary.
ok("pattern rejects a leading digit the engine would accept (console is stricter, safe)", !BINDING_NAME_PATTERN.test("1abc"));
ok("pattern accepts a normal identifier", BINDING_NAME_PATTERN.test("SRC_KV_uploads"));

// ---------------------------------------------------------------------------
// 8. draftStanza / draftBlock: the block built from input NOTHING has gated yet.
// ---------------------------------------------------------------------------
//
// The screen's refreshCli rebuilds the copyable block on every keystroke, so it renders input that
// has not reached validateSourceInput. draftStanza is what it renders through. Two properties, and
// the first is what stops the two renderers drifting into describing different wrangler tables.
console.log("\n-- draftStanza: identical for valid input, withholding for refused input --");

// (a) IDENTITY. For input validateSourceInput accepts, draftStanza is wranglerStanza byte for byte,
// per store type. If either renderer's table shape is edited alone, this fails.
for (const t of STORE_TYPES) {
  const sample = sampleFor(t);
  ok(`${t}: sample is valid (so the identity below is asserted over ACCEPTED input)`, validateSourceInput(sample).length === 0);
  eq(`${t}: draftStanza == wranglerStanza for valid input`, draftStanza(sample), wranglerStanza(sample));
  eq(`${t}: draftBlock == fullBlock for valid input`, draftBlock(sample), fullBlock(sample));
}

// (b) WITHHOLDING. A value the EXISTING rules refuse is never emitted, the key survives, and the
// rule's own reason rides in the block as a TOML comment. The crafted value is the one from the
// injection set above: verbatim emission there forges a whole table into the customer's paste.
{
  const crafted = 'X"\nid = "deadbeefdeadbeefdeadbeefdeadbeef"\n[[r2_buckets]]\nbinding = "PWN';
  const injected = draftStanza({ type: "kv", binding: crafted, namespaceId: "0f2ac7c1b6e0470a8b1f1234567890ab" });
  ok("a crafted binding is NOT emitted into the draft stanza", !injected.includes("PWN"));
  ok("a crafted binding forges no second table", !injected.includes("[[r2_buckets]]"));
  ok("the draft stanza still declares its own table", injected.startsWith("[[kv_namespaces]]"));
  ok("the refused key is still present (never silently dropped)", /(^|\n)binding = ""/.test(injected));
  ok("the refused key carries the rule's own reason", injected.includes("# binding: "));
  ok("a valid sibling value is untouched by a refused neighbour", injected.includes('id = "0f2ac7c1b6e0470a8b1f1234567890ab"'));
  ok("every line of the draft stanza is a table header, a key or a comment",
    injected.split("\n").every((l) => l.startsWith("[[") || l.startsWith("# ") || /^[a-z_]+ = "/.test(l)));
}

// (c) EMPTY IS NOT REFUSED. A field nobody has typed into is the "not typed yet" state that
// field()'s own `required` arm owns, so a pristine form renders exactly what it always rendered.
eq(
  "an untouched KV form renders the same empty stanza as before",
  draftStanza({ type: "kv", binding: "", namespaceId: "" }),
  '[[kv_namespaces]]\nbinding = ""\nid = ""',
);

// (d) NOT TIGHTER THAN ATTACH. Every value validateSourceInput accepts, the block renders unchanged;
// this is the guard against the draft path drifting stricter than the button.
for (const name of ["SRC_KV_uploads", "src_kv_uploads", "_leading_underscore", "A"]) {
  const input: SourceInput = { type: "kv", binding: name, namespaceId: "0f2ac7c1b6e0470a8b1f1234567890ab" };
  ok(`${name}: accepted by validateSourceInput`, validateSourceInput(input).length === 0);
  ok(`${name}: rendered verbatim in the draft stanza`, draftStanza(input).includes(`binding = "${name}"`));
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(failures === 0 ? "\nADD-SOURCE VALIDATORS PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exitCode = 1; // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
if (failures > 0) process.exit(1);

// ---- helpers ----------------------------------------------------------------

// sampleFor returns a fully-valid SourceInput for a store type (used by the all-types passes).
function sampleFor(t: (typeof STORE_TYPES)[number]): SourceInput {
  switch (t) {
    case "kv": return { type: "kv", binding: "SRC_KV_s", namespaceId: "0f2ac7c1b6e0470a8b1f1234567890ab" };
    case "r2": return { type: "r2", binding: "SRC_R2_s", bucketName: "bucket-s" };
    case "d1": return { type: "d1", binding: "SRC_D1_s", databaseName: "db-s", databaseId: "62a9f0e2-1c34-4d56-8a90-abcdef012345" };
    case "secrets": return { type: "secrets", binding: "SRC_SECRET_s", storeId: "6e32e830825542ef86170c1b634df9e6", secretName: "NAME_S" };
  }
}

function occurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

// parseEngineReserved extracts the engine's RESERVED_BINDINGS set from its source text. It pulls
// ONLY the quoted strings WITHIN the `new Set([ ... ])` array literal, so the test compares the
// actual engine members and is not fooled by other quoted UPPER_CASE binding names that the engine
// file may carry OUTSIDE the literal (the section-6 god-module split left such names in the same
// file). It finds the literal's opening bracket, walks bracket depth to its matching close, and
// scans quoted strings only inside that span, so a stray `])` or quoted name elsewhere cannot
// over-read or truncate the set.
function parseEngineReserved(src: string): Set<string> {
  const out = new Set<string>();
  const decl = src.indexOf("RESERVED_BINDINGS = new Set([");
  if (decl === -1) return out;
  // The opening bracket of the array literal is the `[` in `new Set([`.
  const open = src.indexOf("[", decl);
  if (open === -1) return out;
  // Walk from just after the opening bracket to its matching close, tracking nesting depth so a
  // nested `[` (none today, but cheap insurance) does not end the literal early.
  let depth = 1;
  let end = -1;
  for (let i = open + 1; i < src.length; i++) {
    const ch = src[i];
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) return out;
  const block = src.slice(open + 1, end);
  const re = /"([^"]+)"/g;
  for (let m = re.exec(block); m !== null; m = re.exec(block)) out.add(m[1]!);
  return out;
}
