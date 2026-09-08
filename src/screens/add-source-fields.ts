// The identifier fields for the "attach a source manually" screen (add-source.ts): one set of
// inputs per store type, built once, with setType toggling which block is visible. Pulled out of
// the screen so the picker chrome stays small. buildSourceFields constructs every field and its
// per-type block and returns them as a struct; collectInput and fieldFor are pure reads over that
// struct (no closure state), so the binding flow stays byte-identical to before.
//
// House: Australian English, no em dashes, precise claims.

import { h } from "../lib/dom.ts";
import { field, type Field } from "../components/field.ts";
import { bindingNameFieldValidator, databaseIdFieldValidator, databaseNameFieldValidator, kvNamespaceIdFieldValidator, r2BucketNameFieldValidator, secretNameFieldValidator, SECRET_NAME_REQUIRED, secretsStoreIdFieldValidator, type StoreType, type SourceInput } from "../lib/add-source.ts";

// SourceFields is the built field set: each per-type Field plus the per-type block element that
// setType shows or hides, and idsField, the wrapping "Identifiers Cloudflare needs" group.
export interface SourceFields {
  bindingField: Field;
  kvNsField: Field;
  r2BucketField: Field;
  d1NameField: Field;
  d1IdField: Field;
  secStoreField: Field;
  secNameField: Field;
  kvBlock: HTMLElement;
  r2Block: HTMLElement;
  d1Block: HTMLElement;
  secBlock: HTMLElement;
  idsField: HTMLElement;
  all: Field[];
}

// buildSourceFields constructs the identifier fields (one set per type). Each field is built once;
// the caller's setType toggles which blocks are visible. The binding name is shared across types.
export function buildSourceFields(): SourceFields {
  const bindingField = field({
    id: "as-binding",
    label: "Binding name",
    required: true,
    // The rule the hint below states, enforced AT the field and not only at Attach. Same function
    // validateSourceInput calls, so the two moments cannot disagree (lib/add-source.ts).
    validate: bindingNameFieldValidator,
    hint: "Starts with a letter or underscore (never a leading digit), then letters, digits or underscores, up to 64 characters. No spaces, dots or dashes, and not one of the engine's own reserved bindings.",
    placeholder: "SRC_KV_uploads",
    autocomplete: "off",
    doc: { href: "https://docs.downpipes.io/sources/connect-a-source", anchor: "binding-names-and-the-secrets-store" },
  });
  bindingField.control.classList.add("mono");

  // KV
  // validate: the hexadecimal rule at the field. On this path the console is the ONLY enforcement
  // point: the engine's attach route checks that a namespace id is present and not its shape.
  const kvNsField = field({ id: "as-kv-ns", label: "KV namespace id", required: true, validate: kvNamespaceIdFieldValidator, hint: h("span", "Hexadecimal only (0-9, a-f), 8 to 64 characters (Cloudflare's is 32). The id ", h("code", "kv namespace create"), " returns, also shown against the namespace in the dashboard."), placeholder: "0f2ac7c1b6e0470a…", autocomplete: "off", doc: { href: "https://docs.downpipes.io/sources/connect-a-source", anchor: "finding-the-ids-for-a-manual-attach" } });
  kvNsField.control.classList.add("mono");
  const kvBlock = h("div", kvNsField.el);

  // R2
  const r2BucketField = field({ id: "as-r2-bucket", label: "R2 bucket name", required: true, validate: r2BucketNameFieldValidator, hint: "The exact bucket name (R2 buckets are addressed by name, not an id): starts with a letter or digit, then letters, digits, hyphens or underscores, up to 64 characters.", placeholder: "uploads-prod", autocomplete: "off", doc: { href: "https://docs.downpipes.io/sources/connect-a-source", anchor: "finding-the-ids-for-a-manual-attach" } });
  r2BucketField.control.classList.add("mono");
  const r2Block = h("div", r2BucketField.el);

  // D1
  const d1NameField = field({ id: "as-d1-name", label: "D1 database name", required: true, validate: databaseNameFieldValidator, hint: "The database name: starts with a letter or digit, then letters, digits, hyphens or underscores, up to 64 characters.", placeholder: "app-db", autocomplete: "off", doc: { href: "https://docs.downpipes.io/sources/connect-a-source", anchor: "finding-the-ids-for-a-manual-attach" } });
  const d1IdField = field({ id: "as-d1-id", label: "D1 database id", required: true, validate: databaseIdFieldValidator, hint: h("span", "A UUID, or a hexadecimal id (0-9, a-f and the UUID hyphens). The id ", h("code", "d1 create"), " returns."), placeholder: "62a9…-…-…", autocomplete: "off", doc: { href: "https://docs.downpipes.io/sources/connect-a-source", anchor: "finding-the-ids-for-a-manual-attach" } });
  d1NameField.control.classList.add("mono");
  d1IdField.control.classList.add("mono");
  const d1Block = h("div", d1NameField.el, d1IdField.el);

  // Secrets Store: store id + secret NAME only. There is deliberately NO value field; the
  // value lives in Cloudflare's Secrets Store and is referenced by store id + name. The hint
  // states this plainly so the no-custody promise is visible at the point of entry.
  const secStoreField = field({ id: "as-sec-store", label: "Secrets Store id", required: true, validate: secretsStoreIdFieldValidator, hint: "The Secrets Store id: hexadecimal (0-9, a-f), 8 to 64 characters (Cloudflare's is 32). Read it from the Secrets Store area of the Cloudflare dashboard.", placeholder: "6e32e830825542ef…", autocomplete: "off", doc: { href: "https://docs.downpipes.io/sources/connect-a-source", anchor: "finding-the-ids-for-a-manual-attach" } });
  const secNameField = field({ id: "as-sec-name", label: "Secret name", required: true, requiredMessage: SECRET_NAME_REQUIRED, validate: secretNameFieldValidator, hint: "The store entry key (the secret's name): starts with a letter or digit, then letters, digits, hyphens or underscores. The secret value is never entered here; it stays in Cloudflare.", placeholder: "API_KEY", autocomplete: "off", doc: { href: "https://docs.downpipes.io/sources/connect-a-source", anchor: "binding-names-and-the-secrets-store" } });
  secStoreField.control.classList.add("mono");
  secNameField.control.classList.add("mono");
  const secBlock = h("div", secStoreField.el, secNameField.el);

  const idsField = h(
    "div",
    { class: "field" },
    h("span", { class: "field__label" }, "Identifiers Cloudflare needs"),
    bindingField.el,
    kvBlock,
    r2Block,
    d1Block,
    secBlock,
  );

  return {
    bindingField,
    kvNsField,
    r2BucketField,
    d1NameField,
    d1IdField,
    secStoreField,
    secNameField,
    kvBlock,
    r2Block,
    d1Block,
    secBlock,
    idsField,
    all: [bindingField, kvNsField, r2BucketField, d1NameField, d1IdField, secStoreField, secNameField],
  };
}

// collectInput builds the typed SourceInput from the visible fields for the current type.
export function collectInput(f: SourceFields, currentType: StoreType): SourceInput {
  const binding = f.bindingField.value();
  switch (currentType) {
    case "kv":
      return { type: "kv", binding, namespaceId: f.kvNsField.value() };
    case "r2":
      return { type: "r2", binding, bucketName: f.r2BucketField.value() };
    case "d1":
      return { type: "d1", binding, databaseName: f.d1NameField.value(), databaseId: f.d1IdField.value() };
    case "secrets":
      return { type: "secrets", binding, storeId: f.secStoreField.value(), secretName: f.secNameField.value() };
  }
}

// fieldFor maps a SourceInput field key to its control (so a validation error marks + focuses
// the right input). binding is shared; the rest are per-type.
export function fieldFor(f: SourceFields, key: string): Field | null {
  switch (key) {
    case "binding": return f.bindingField;
    case "namespaceId": return f.kvNsField;
    case "bucketName": return f.r2BucketField;
    case "databaseName": return f.d1NameField;
    case "databaseId": return f.d1IdField;
    case "storeId": return f.secStoreField;
    case "secretName": return f.secNameField;
    default: return null;
  }
}
