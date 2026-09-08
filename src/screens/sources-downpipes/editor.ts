// Create and edit for the Sources + downpipes screen (flow.md D) plus the schedule picker
// (flow.md E), the guided create wizard (flow.md J) and the bulk import drawer. The full-power
// upsert editor, the advanced-schedule section, the wizard and the list importer were split by
// section into sibling modules (move-only); this module keeps the query
// prefill and RE-EXPORTS the moved entry points, so every importer is unchanged. Australian
// English, no em dashes, precise claims.

import { recordHandoffDropped } from "../../lib/client-diag/ring.ts";
import { isTokenSourceType } from "../../lib/token-source.ts";
import type { EditorPrefill } from "./editor-types.ts";

// The moved entry points are re-exported here so the screen module (and the validator) keep
// importing { openEditor, openCreateWizard, openImport, prefillFromQuery } from "./editor.ts".
export { openEditor } from "./editor-upsert.ts";
export { openCreateWizard } from "./editor-wizard.ts";
export { openImport } from "./editor-import.ts";
export type { EditorPrefill } from "./editor-types.ts";

// prefillFromQuery reads the add-source bridge params off the create route's query into an
// EditorPrefill. Two hand-offs land here:
//   - a BINDING source (/downpipes/new?binding=...&type=kv|r2|d1|secrets&secretBinding=...): type is
//     honoured for the four binding types; binding/secretBinding are the operator's own prior input.
//   - a TOKEN source (/downpipes/new?type=cf-config&zone=... or ?type=workers&account=...):
//     type is honoured for the five token types, with the optional account (all five) and zone
//     (cf-config only) pre-selection carried so the wizard opens with that token source chosen
//     (lib/token-source.ts builds this query; the keys match exactly). A cross-field value is ignored
//     (a zone on a workers type is not read).
// All fields are optional, so a bare /downpipes/new prefill is empty. Exported for the validator
// (the load-bearing query round-trip).
export function prefillFromQuery(query: URLSearchParams): EditorPrefill {
  const out: EditorPrefill = {};
  const binding = query.get("binding");
  if (binding) out.binding = binding;
  const secretBinding = query.get("secretBinding");
  if (secretBinding) out.secretBinding = secretBinding;
  const type = query.get("type");
  if (type === "kv" || type === "r2" || type === "d1" || type === "secrets") out.type = type;
  else if (isTokenSourceType(type)) {
    out.type = type;
    const account = query.get("account");
    if (account) out.accountId = account;
    if (type === "cf-config") {
      const zone = query.get("zone");
      if (zone) out.zoneId = zone;
    }
  } else if (type !== null && type !== "") {
    // The deep link NAMED a source type and this console build does not know it, so the type is dropped on
    // the floor and the editor opens with nothing selected. That is the "I clicked Protect this zone and the
    // wizard opened blank" ticket, and today it is indistinguishable from an operator who opened the wizard
    // themselves: the prefill is consumed browser-side, no request is made, and the engine sees nothing at all.
    //
    // NOISE: a bare /downpipes/new with no `type` at all is the ORDINARY way the wizard is opened and records
    // nothing. Only a link that named a type the console could not honour does. The type STRING never rides: it is
    // a query parameter, which is to say an arbitrary string from outside the console.
    recordHandoffDropped("prefill-type-invalid");
  }
  // Native resource ids carried from the attach-success bridge so the new downpipe records them with zero
  // manual entry (the editor seeds the matching override field). Non-secret ids; absent on a hand-typed link.
  const namespaceId = query.get("namespaceId");
  if (namespaceId) out.namespaceId = namespaceId;
  const bucketName = query.get("bucketName");
  if (bucketName) out.bucketName = bucketName;
  const databaseId = query.get("databaseId");
  if (databaseId) out.databaseId = databaseId;
  const storeId = query.get("storeId");
  if (storeId) out.secretStoreId = storeId;
  return out;
}
