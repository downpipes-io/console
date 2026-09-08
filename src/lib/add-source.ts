// The pure logic behind the guided "add a source" flow (the day-2 UX gap: an operator
// adds a new Cloudflare store binding without hand-editing engine/wrangler.toml). The
// engine reaches a customer's KV / R2 / D1 / Secrets Store ONLY through wrangler.toml
// BINDINGS, and at runtime holds NO Cloudflare deploy token (the no-custody guarantee,
// engine/docs/CLOUDFLARE-PERMISSIONS.md). So adding a new source binding is necessarily a
// GUIDED, out-of-band flow: the console COMPUTES the exact wrangler.toml stanza plus the
// deploy command, and the operator applies it with their OWN scoped, short-lived deploy
// token (the state 1 -> state 3 elevate -> deploy -> revoke model). This mirrors the
// key-ceremony "copy this command, we never handle your secret" pattern.
//
// This module is the PURE, framework-free, DOM-free core so it can be unit round-tripped
// (test/validate-add-source.ts): the binding-name validator and the exact stanza/command
// generators. The screen (src/screens/add-source.ts) composes these with the wizard chrome
// and bridges into the existing add-downpipe flow. Nothing here reaches the network, reads
// a token, or touches a secret VALUE: a Secrets Store source is referenced by store id +
// secret name + binding only (the value lives in Cloudflare, never on the wire and never in
// this console).
//
// House: Australian English, no em dashes, precise claims.

// ---- the four store types ---------------------------------------------------

// StoreType is the Cloudflare store a source binding addresses. It is a SUPERSET vocabulary
// of the downpipe SourceSpec["type"] in api.ts (kv / r2 / d1 / secrets) named for the
// wrangler.toml table each maps to, so the generated stanza shape is unambiguous.
export type StoreType = "kv" | "r2" | "d1" | "secrets";

// STORE_TYPES is the value-level companion to StoreType (the union is type-only): the closed
// set the picker renders and the validator switches over. Kept in lockstep with StoreType.
export const STORE_TYPES: readonly StoreType[] = ["kv", "r2", "d1", "secrets"];

// storeTypeLabel is the human label for a store type (the picker + the generated stanza
// heading). Secrets Store is named in full so the no-value-collected promise reads clearly.
export function storeTypeLabel(t: StoreType): string {
  switch (t) {
    case "kv": return "KV namespace";
    case "r2": return "R2 bucket";
    case "d1": return "D1 database";
    case "secrets": return "Secrets Store secret";
  }
}

// ---- binding-name validation ------------------------------------------------

// RESERVED_BINDINGS mirrors the engine's RESERVED_BINDINGS set (engine
// src/sched/config-validate.ts) byte for byte: a source binding may never name one of the
// engine's own env bindings, else a downpipe could seal the signer key or the destination
// credentials into a backup. The console rejects these up front (a clear inline reason)
// rather than letting the operator deploy a stanza the engine will refuse at config time.
// Mirrored here (not imported) because the console is its own package with no engine
// dependency; validate-add-source.ts asserts the two stay in step.
export const RESERVED_BINDINGS: ReadonlySet<string> = new Set<string>([
  "SCHEDULER",
  "CF_ACCESS_TEAM_DOMAIN",
  "CF_ACCESS_AUD",
  "ADMIN_TOKEN",
  "CONSOLE_ORIGIN",
  "DEST_ENDPOINT",
  "DEST_BUCKET",
  "DEST_REGION",
  "DEST_ACCESS_KEY_ID",
  "DEST_SECRET_ACCESS_KEY",
  "DEST_R2",
  "DEST_KIND",
  "SIGNER_PRIVATE",
  "BREAK_GLASS_PUBLIC",
  "OPERATIONAL_PUBLIC",
  "OPERATIONAL_PRIVATE",
  // The config recipient: a key pair whose ONLY job is opening this engine's own sealed configuration export.
  // Reserved for the same reason as every other key slot, so a source can never be bound over it.
  //
  "CONFIG_RECIPIENT_PUBLIC",
  "CONFIG_RECIPIENT_PRIVATE",
  "UPDATE_CHANNEL_URL",
  "UPDATE_SIGNER_PUBLIC",
  "LICENCE_TOKEN",
  "LICENCE_SIGNER_PUBLIC",
  "RUNSEAL",
  "SLICED_RUNS_DISABLED",
  "SCALE_SLICE_SUBREQUESTS",
  "SCALE_SLICE_WALL_MS",
  "SCALE_SHARD_MAX_RECORDS",
  "SCALE_SEGMENT_TARGET_BYTES",
  "VENDOR_SUPPORT_PUBLIC",
  "EMAIL",
  "EMAIL_FROM",
  "INVITE_EMAIL_FROM",
  "BOOTSTRAP_OWNER_EMAIL",
  "DISCOVERY_API_TOKEN",
  "CF_ACCOUNT_ID",
  // Later engine secret bindings the mirror had not yet caught up with: the SCIM provisioning token, the
  // beacon ingest key, and the config-secret wrap key.
  "SCIM_BEARER_TOKEN",
  "BEACON_INGEST_KEY",
  "CONFIG_WRAP_KEY",
  // Engine-internal Durable Object and version-metadata bindings: a source must never name these.
  "RATELIMIT_DO",
  "CF_VERSION_METADATA",
  // Later engine reservations the mirror must track (validate-add-source.ts asserts parity with the
  // engine set whenever the engine source is present in the checkout): the SCIM bearer, the beacon
  // ingest key and the destination-credential wrap key are all engine env bindings a source binding
  // must never shadow.
  "SCIM_BEARER_TOKEN",
  "BEACON_INGEST_KEY",
  "CONFIG_WRAP_KEY",
]);

// BINDING_NAME_PATTERN bounds a binding name to a VALID JavaScript / wrangler identifier: a
// leading letter or underscore, then letters / digits / underscores, 1 to 64 chars. This is
// deliberately a SUBSET of the engine's looser binding regex (/^[A-Za-z0-9_]{1,64}$/, which
// also permits a leading digit): every name the console accepts, the engine also accepts, so
// the console never emits a stanza the engine would reject on the binding shape. The
// JS-identifier rule (no leading digit) is the stricter, safer convention the hint teaches.
export const BINDING_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

// validateBindingName is the PURE guardrail the form runs before it generates a stanza. It
// returns null when the name is acceptable, or a precise reason string when it is not. The
// order: required, shape (valid identifier), then the reserved-binding collision. It never
// throws. The "uppercase-ish convention" is a HINT (most bindings read SRC_KV_uploads), not a
// hard rule: a lowercase-but-valid identifier is accepted, since the engine accepts it too;
// only an empty name, a non-identifier, or a reserved name is rejected.
export function validateBindingName(raw: string): string | null {
  const name = raw.trim();
  if (name === "") return "A binding name is required.";
  if (!BINDING_NAME_PATTERN.test(name)) {
    return "Use a valid binding name: a letter or underscore, then letters, digits or underscores (for example SRC_KV_uploads). No spaces, dots or dashes.";
  }
  if (RESERVED_BINDINGS.has(name)) {
    return `${name} is one of the engine's own reserved bindings and cannot name a source. Choose another name (for example SRC_KV_${name.toLowerCase()}).`;
  }
  return null;
}

// isValidBindingName is the boolean companion (a gate can read it without the reason text).
export function isValidBindingName(raw: string): boolean {
  return validateBindingName(raw) === null;
}

// ---- the store inputs (one shape per type) ----------------------------------

// KvSourceInput is the operator's input for a KV namespace source: the chosen binding name
// plus the Cloudflare KV namespace id (the id `wrangler kv namespace create` returns).
export interface KvSourceInput {
  type: "kv";
  binding: string;
  namespaceId: string;
}

// R2SourceInput is the operator's input for an R2 bucket source: the binding name plus the
// bucket name (R2 buckets are addressed by name, not an opaque id).
export interface R2SourceInput {
  type: "r2";
  binding: string;
  bucketName: string;
}

// D1SourceInput is the operator's input for a D1 database source: the binding name, the
// human database name, and the database id (`wrangler d1 create` returns the id).
export interface D1SourceInput {
  type: "d1";
  binding: string;
  databaseName: string;
  databaseId: string;
}

// SecretsSourceInput is the operator's input for a Secrets Store secret source: the binding
// name, the Secrets Store id, and the secret NAME (the store entry key). There is
// deliberately NO value field: the secret value lives in Cloudflare's Secrets Store and is
// referenced by store id + name only, exactly as the engine reads it (an async binding get()).
export interface SecretsSourceInput {
  type: "secrets";
  binding: string;
  storeId: string;
  secretName: string;
}

// SourceInput is the discriminated union of the four. The screen narrows on `.type`.
export type SourceInput = KvSourceInput | R2SourceInput | D1SourceInput | SecretsSourceInput;

// ---- per-field identifier patterns (TOML-injection guard) -------------------
//
// Every identifier below is emitted VERBATIM into a generated wrangler.toml stanza
// (wranglerStanza) inside a double-quoted TOML string. Without a charset guard a crafted
// identifier could carry a quote, newline or bracket and inject TOML (a new key, a new table,
// or a closing quote), so each field is bound to the TIGHT charset Cloudflare actually uses
// and anything outside it is rejected BEFORE the stanza is generated. The patterns are
// deliberately a subset of "safe in a TOML string": none of these charsets contains a quote,
// a backslash, a newline, or a bracket, so a value that passes can never break the stanza.

// HEX_ID_PATTERN bounds an opaque hex id (a KV namespace id or a Secrets Store id): hex digits
// only, 8 to 64 chars. Cloudflare's KV namespace ids and Secrets Store ids are 32-char hex; the
// range is widened slightly so a future id length still passes, but the charset stays hex-only
// (no quote, no bracket, no newline) so it can never inject TOML.
export const HEX_ID_PATTERN = /^[0-9a-fA-F]{8,64}$/;

// UUID_OR_HEX_ID_PATTERN bounds a D1 database id: either a canonical UUID (8-4-4-4-12 hex with
// hyphens) or a bare 8 to 64 char hex id. `wrangler d1 create` returns a UUID; the bare-hex
// alternative keeps the validator robust to id-shape changes while still admitting only hex and
// the UUID hyphens (no quote, no bracket, no newline).
export const UUID_OR_HEX_ID_PATTERN =
  /^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9a-fA-F]{8,64})$/;

// RESOURCE_NAME_PATTERN bounds a human resource name (an R2 bucket name, a D1 database name, or
// a Secrets Store secret name): a leading alphanumeric, then alphanumerics, hyphens or
// underscores, 1 to 64 chars. This matches Cloudflare's R2 bucket-name rule and is a safe
// superset for the D1 name and the secret name. The charset has no quote, no bracket and no
// newline, so a name that passes can never break the TOML string it is emitted into.
export const RESOURCE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

// ---- per-field validation (the identifiers Cloudflare needs) ----------------

// A FieldError names the input field that failed and why, so the screen can mark the right
// control. The `field` is a stable key the screen maps to its control.
export interface FieldError {
  field: string;
  reason: string;
}

// validateHexId returns null when a trimmed value is a required hex id (KV namespace id /
// Secrets Store id), or a precise reason when it is empty or carries any non-hex character (the
// injection guard). Pure; never throws.
function validateHexId(raw: string, label: string): string | null {
  const v = raw.trim();
  if (v === "") return `The ${label} is required.`;
  if (!HEX_ID_PATTERN.test(v)) {
    return `The ${label} must be hexadecimal (0-9, a-f) only, 8 to 64 characters. Paste the id exactly as Cloudflare returns it.`;
  }
  return null;
}

// validateDatabaseId returns null when a trimmed D1 database id is a UUID or a bare hex id, or a
// precise reason when it is empty or carries any character outside hex and the UUID hyphens.
function validateDatabaseId(raw: string): string | null {
  const v = raw.trim();
  if (v === "") return "The D1 database id is required (the id wrangler returns from `d1 create`).";
  if (!UUID_OR_HEX_ID_PATTERN.test(v)) {
    return "The D1 database id must be a UUID or a hexadecimal id (0-9, a-f and the UUID hyphens only). Paste the id exactly as wrangler returns it.";
  }
  return null;
}

// validateResourceName returns null when a trimmed resource name (R2 bucket / D1 database /
// secret name) is a leading-alphanumeric name of alphanumerics, hyphens and underscores, or a
// precise reason when it is empty or carries any character outside that safe charset.
function validateResourceName(raw: string, label: string): string | null {
  const v = raw.trim();
  if (v === "") return `The ${label} is required.`;
  if (!RESOURCE_NAME_PATTERN.test(v)) {
    return `The ${label} may use letters, digits, hyphens and underscores only (starting with a letter or digit), up to 64 characters.`;
  }
  return null;
}

// validateSourceInput validates a whole SourceInput: the binding name (always), then the
// type-specific identifiers. It returns the list of errors (empty when valid), in field order,
// so the screen can mark every bad field at once and focus the first. It NEVER inspects or
// requires a secret value (there is no such field on SecretsSourceInput). Pure; never throws.
export function validateSourceInput(input: SourceInput): FieldError[] {
  const errors: FieldError[] = [];

  const bindingReason = validateBindingName(input.binding);
  if (bindingReason !== null) errors.push({ field: "binding", reason: bindingReason });

  // Each identifier below is bound to its TIGHT Cloudflare charset (the TOML-injection guard):
  // the value is emitted verbatim into a quoted wrangler.toml string, so a value carrying a
  // quote, newline or bracket is rejected here rather than corrupting the stanza.
  switch (input.type) {
    case "kv": {
      const r = validateHexId(input.namespaceId, "KV namespace id");
      if (r !== null) errors.push({ field: "namespaceId", reason: r });
      break;
    }
    case "r2": {
      const r = validateResourceName(input.bucketName, "R2 bucket name");
      if (r !== null) errors.push({ field: "bucketName", reason: r });
      break;
    }
    case "d1": {
      const rn = validateResourceName(input.databaseName, "D1 database name");
      if (rn !== null) errors.push({ field: "databaseName", reason: rn });
      const ri = validateDatabaseId(input.databaseId);
      if (ri !== null) errors.push({ field: "databaseId", reason: ri });
      break;
    }
    case "secrets": {
      const rs = validateHexId(input.storeId, "Secrets Store id");
      if (rs !== null) errors.push({ field: "storeId", reason: rs });
      const rn = validateResourceName(input.secretName, SECRET_NAME_LABEL);
      if (rn !== null) errors.push({ field: "secretName", reason: rn });
      break;
    }
  }
  return errors;
}

// ---- the exact wrangler.toml stanza generators ------------------------------
//
// Each generator returns the EXACT wrangler.toml table for the store, matching the real
// binding shapes the engine declares: [[kv_namespaces]] / [[r2_buckets]] /
// [[d1_databases]] (engine/wrangler.toml + downpipe init.go Step 2) and
// [[secrets_store_secrets]] (the shape proven live in control-plane/wrangler.toml:
// binding / store_id / secret_name). Values are emitted verbatim from the operator's input
// (already validated); the screen sets them via textContent so nothing is ever parsed as
// markup. No secret VALUE is ever emitted: a secrets source references store_id +
// secret_name only.

// wranglerStanza renders the wrangler.toml table for a validated SourceInput. The output is
// stable and exact (a test byte-compares it), so a careless edit that changes the shape is
// caught. It assumes the input passed validateSourceInput (the screen gates on that); a
// malformed input would simply emit its (empty) fields, never throw.
export function wranglerStanza(input: SourceInput): string {
  const binding = input.binding.trim();
  switch (input.type) {
    case "kv":
      return [
        "[[kv_namespaces]]",
        `binding = "${binding}"`,
        `id = "${input.namespaceId.trim()}"`,
      ].join("\n");
    case "r2":
      return [
        "[[r2_buckets]]",
        `binding = "${binding}"`,
        `bucket_name = "${input.bucketName.trim()}"`,
      ].join("\n");
    case "d1":
      return [
        "[[d1_databases]]",
        `binding = "${binding}"`,
        `database_name = "${input.databaseName.trim()}"`,
        `database_id = "${input.databaseId.trim()}"`,
      ].join("\n");
    case "secrets":
      // Secrets Store: store_id + secret_name + binding ONLY. The value lives in Cloudflare;
      // it is never collected, never rendered, and never on the wire.
      return [
        "[[secrets_store_secrets]]",
        `binding = "${binding}"`,
        `store_id = "${input.storeId.trim()}"`,
        `secret_name = "${input.secretName.trim()}"`,
      ].join("\n");
  }
}

// DEPLOY_COMMENT is the one-line comment that precedes the deploy command in the copyable
// block. It points at the public token-scopes doc (never a repo-internal file a customer
// cannot open) so the operator can check what the deploy needs and revoke afterwards.
export const DEPLOY_COMMENT =
  "# Uses your wrangler login (or a scoped deploy token; revoke it after). Token scopes: docs.downpipes.io/operations/cloudflare-token-scopes";

// deployCommand is the guided-deploy line the operator runs from the engine directory after
// adding the stanza to engine/wrangler.toml. It is `npm run deploy` (scripts/deploy.sh), NEVER
// a bare `npx wrangler deploy`: the guided deploy reconciles the live worker's bindings and
// deploys a superset, so it cannot silently drop the OTHER console-attached sources the way a
// bare wrangler deploy (which replaces bindings with wrangler.toml's) would. The docs page
// operations/deploy-safety-bindings is the authority for this rule.
export function deployCommand(): string {
  return "cd engine && npm run deploy";
}

// fullBlock composes the copyable block the code-block renders: the stanza, a blank line, the
// state-3 reminder comment, and the deploy command. This is the exact text the operator copies
// and applies. Kept pure (a test byte-compares the whole block per store type) so the guidance
// can never silently drift from the real binding shape.
export function fullBlock(input: SourceInput): string {
  return [
    wranglerStanza(input),
    "",
    DEPLOY_COMMENT,
    deployCommand(),
  ].join("\n");
}

// ---- the same rules, wired at the FIELD rather than only at submit -----------
//
// THE DEFECT THESE CLOSE, and it is the one components/field-bounds.ts already names for its own
// controls: field.ts runs a field's validator on blur only when the field carries one, and neither
// identifier field carried one. validateSourceInput ran at Attach and nowhere else, so an operator
// who typed a binding name with a space, or a namespace id that is not hexadecimal, left the control
// with NO error under a hint that had just told them the rule.
//
// These are wrappers, not new rules. Each calls the SAME function the submit path calls, so the
// client rule cannot drift between the two moments, and the empty case is handed back to field()'s
// own `required` arm, which owns it and deliberately records no evidence for it (field.ts
// runValidate). Nothing here tightens what the console accepts: every value validateSourceInput
// takes at Attach, blur takes too.

// bindingNameFieldValidator is validateBindingName as a field() validator: the identifier shape and
// the reserved-binding collision, blank left to `required`.
export function bindingNameFieldValidator(value: string): string | null {
  return value.trim() === "" ? null : validateBindingName(value);
}

// kvNamespaceIdFieldValidator is validateHexId as a field() validator for the KV namespace id. The
// hexadecimal charset is the CONSOLE'S OWN guarantee on this path, not a mirror of a server rule:
// the engine's attach route checks only that a namespace id is present (attach-plan.ts
// bindingFromSource), and the charset is also what keeps the copyable wrangler.toml stanza a valid
// TOML string, so the field is where it has to hold.
export function kvNamespaceIdFieldValidator(value: string): string | null {
  return value.trim() === "" ? null : validateHexId(value, "KV namespace id");
}

// ---- the block for input that has NOT been gated yet ------------------------
//
// THE DEFECT THIS CLOSES. wranglerStanza emits every identifier VERBATIM into a double-quoted TOML
// string and says so: it assumes validateSourceInput has already passed. On the Attach path that
// assumption holds. On the add-source screen's fallback block it did not. refreshCli rebuilt the
// copyable block from collectInput on EVERY KEYSTROKE, through persistForm, so the block offered
// for copying was built from a value nothing had gated. Typing a binding name with a space rendered
// `binding = "SRC KV uploads"` into the block,
// and a binding name carrying a quote and two newlines rendered a WHOLE SECOND TABLE the operator
// never configured (`[[r2_buckets]]` / `binding = "PWN"`) into the text they are invited to paste
// into engine/wrangler.toml. The charset guard above is not a nicety on this path: it IS what keeps
// the stanza a valid TOML string, so an ungated value is a TOML injection into the customer's own
// configuration, which is the very thing this module's identifier patterns exist to prevent.
//
// THE RULES ARE NOT NEW AND NOTHING IS TIGHTENED. draftStanza calls validateSourceInput, the SAME
// function the Attach button calls, and adds no rule of its own. A value Attach accepts, the block
// renders unchanged.
//
// WHY THIS IS A SEPARATE FUNCTION AND NOT A GUARD INSIDE wranglerStanza. wranglerStanza has three
// other callers (sources/account.ts, sources/add-source.ts) and they render bindings the ENGINE
// already holds, not input somebody is typing. The console's BINDING_NAME_PATTERN is DELIBERATELY a
// subset of the engine's (the engine also permits a leading digit), so a guard inside wranglerStanza
// would blank the binding of a real, already-attached source named `1SRC` on the Sources screen.
// That is the over-tightening this repair must not commit: the console's stricter rule is the
// authority over what the OPERATOR may type, never over what the engine already has.
//
// WHAT IT RENDERS, AND THE COST. The block never vanishes and never loses a line: a snippet that
// disappears as somebody types is hostile, and one that silently drops a key is worse than one that
// shows it wrong. Every table heading and every key stays, in order. A key whose value the existing
// rules refuse renders with an EMPTY value, which is exactly what the block has always rendered for
// a field nobody has typed into yet, above a `#` comment carrying that rule's own reason. So the
// paste explains itself. The cost is real and is accepted deliberately: an operator who copies the
// block while a field is refused gets a stanza with an empty value, and wrangler refuses it. That
// refusal is loud, immediate and local, and the console has already named the field and the reason
// both at the control and in the block, which is strictly better than a stanza that applies cleanly
// and configures the wrong thing, or one that carries a table nobody asked for.
//
// AN EMPTY FIELD IS NOT A REFUSAL. Emptiness is the "not typed yet" state, owned by field()'s own
// `required` arm (the same split the field validators above make), so a pristine form renders
// byte-for-byte what it rendered before this existed and nobody is scolded for not having started.

// draftStanza is wranglerStanza for a draft: identical output for input validateSourceInput accepts,
// and for input it refuses, the refused values withheld with their reasons in place. The identity
// half is byte-asserted per store type in test/validate-add-source.ts, so the two renderers cannot
// drift into describing different wrangler tables.
export function draftStanza(input: SourceInput): string {
  const refused = new Map<string, string>();
  for (const e of validateSourceInput(input)) refused.set(e.field, e.reason);

  // withheld decides one key. `raw` empty means untyped, which is not a refusal and renders as the
  // empty value it always did. A reason is flattened to one line because a `#` comment is
  // line-scoped: a reason carrying a newline would end the comment and put prose in the table.
  const emit = (key: string, field: string, raw: string): string[] => {
    const reason = raw.trim() === "" ? undefined : refused.get(field);
    if (reason === undefined) return [`${key} = "${raw.trim()}"`];
    return [`# ${key}: ${reason.replace(/\s+/g, " ").trim()}`, `${key} = ""`];
  };

  switch (input.type) {
    case "kv":
      return [
        "[[kv_namespaces]]",
        ...emit("binding", "binding", input.binding),
        ...emit("id", "namespaceId", input.namespaceId),
      ].join("\n");
    case "r2":
      return [
        "[[r2_buckets]]",
        ...emit("binding", "binding", input.binding),
        ...emit("bucket_name", "bucketName", input.bucketName),
      ].join("\n");
    case "d1":
      return [
        "[[d1_databases]]",
        ...emit("binding", "binding", input.binding),
        ...emit("database_name", "databaseName", input.databaseName),
        ...emit("database_id", "databaseId", input.databaseId),
      ].join("\n");
    case "secrets":
      return [
        "[[secrets_store_secrets]]",
        ...emit("binding", "binding", input.binding),
        ...emit("store_id", "storeId", input.storeId),
        ...emit("secret_name", "secretName", input.secretName),
      ].join("\n");
  }
}

// draftBlock is fullBlock for a draft: the same composition (stanza, blank line, the reminder
// comment, the deploy command) over draftStanza, so the copyable block keeps its exact shape while
// the operator is still typing.
export function draftBlock(input: SourceInput): string {
  return [
    draftStanza(input),
    "",
    DEPLOY_COMMENT,
    deployCommand(),
  ].join("\n");
}

// ---- the remaining five identifier fields, on exactly the same terms ---------
//
// Each of these five was checked at two moments (after blur, and after the three calls
// add-source.ts getValidatedInput makes at Attach), and all five were clean on blur but answered with
// a precise error at Attach, on the catalogued invalid value and on a 65-character value alike. So
// none of them was ever accepting what its published rule forbids: the console refused, and it
// refused where the operator was no longer looking.
//
// Each wrapper hands the SAME label to the SAME function validateSourceInput calls, so the message
// an operator reads on blur is byte-identical to the one Attach would have shown, and the two moments
// cannot drift. Blank goes back to field()'s own `required` arm, which owns it. Nothing here is a new
// rule and nothing is tighter: every value Attach already accepted, blur accepts too.

// r2BucketNameFieldValidator is validateResourceName for the R2 bucket name. R2 buckets are addressed
// by name rather than by an id, so this name is the whole reference.
export function r2BucketNameFieldValidator(value: string): string | null {
  return value.trim() === "" ? null : validateResourceName(value, "R2 bucket name");
}

// databaseNameFieldValidator is validateResourceName for the D1 database name.
export function databaseNameFieldValidator(value: string): string | null {
  return value.trim() === "" ? null : validateResourceName(value, "D1 database name");
}

// databaseIdFieldValidator is validateDatabaseId for the D1 database id. The engine's attach route
// checks that a database id is PRESENT and not its shape (attach-plan.ts), so the UUID-or-hex charset
// is the console's own guarantee here, and it is also what keeps the copyable wrangler.toml stanza a
// valid TOML string.
export function databaseIdFieldValidator(value: string): string | null {
  return value.trim() === "" ? null : validateDatabaseId(value);
}

// secretsStoreIdFieldValidator is validateHexId for the Secrets Store id, on the same footing as the
// KV namespace id above: presence is the engine's check, the charset is the console's.
export function secretsStoreIdFieldValidator(value: string): string | null {
  return value.trim() === "" ? null : validateHexId(value, "Secrets Store id");
}

// secretNameFieldValidator is validateResourceName for the store entry key. The secret VALUE is never
// entered in this console; only the name that references it.
export function secretNameFieldValidator(value: string): string | null {
  return value.trim() === "" ? null : validateResourceName(value, SECRET_NAME_LABEL);
}

// ---- the store entry key's own words, kept in one place ---------------------
//
// as-sec-name said TWO SENTENCES FOR ONE STATE. An empty box read "Secret name is required." on blur,
// because components/field.ts composes the required message from the control's LABEL, and "The secret
// name (the store entry key) is required." at Attach, because validateSourceInput composes it from the
// noun phrase passed to validateResourceName. Same field, same empty box, two sentences.
//
// The Attach wording is the one kept, and not because it is longer. "Secret name" reads, to an operator
// meeting the Secrets Store for the first time, as though the console wants the secret itself; the
// parenthetical is the whole point of the field, which references a store entry and never carries a
// value. The label above the box stays "Secret name", so the short form is still what the operator sees
// as the field's name; the refusal is where the fuller description earns its place.
//
// Both the noun phrase and the sentence live here, beside the validator that produces the Attach
// message, so an edit to the wording moves both moments together instead of leaving one behind.
// test/validate-field-bounds.ts drives both moments and asserts the sentences are byte-identical,
// which is the check whose absence let them split.
//
// THIS SITS AT THE END OF THE FILE ON PURPOSE, so appending here moves no other coordinate in the file.
// Module-scoped, not exported: nothing outside this file should name the store entry key itself, and
// an export no caller uses is what the dead-code gate exists to refuse.
const SECRET_NAME_LABEL = "secret name (the store entry key)";
export const SECRET_NAME_REQUIRED = `The ${SECRET_NAME_LABEL} is required.`;
