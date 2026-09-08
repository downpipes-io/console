// Shared editor prefill type, split out of ./editor.ts. See ./editor.ts.

import type { SourceType } from "./helpers.ts";

// WizType is the create wizard's set of RADIO-pickable source kinds. It lives here, the leaf type
// module, so both the wizard's source-row builder and the section-append helper can reference it
// without an import cycle between them.
//
// It is EXACTLY the four token/account-scoped kinds, and that is the whole of it. Every other source kind the
// wizard can create is a TICK-MANY selection, not a radio pick:
//   kv / r2 / d1 / secrets   the binding-backed kinds, held in WizardState.chosenMulti KEYED BY BINDING NAME
//                            and assembled by assembleBulkDownpipes (./bulk-assemble.ts)
//   cf-config                held in chosenCfZones / chosenCfAccounts and assembled by assembleCfConfigBulk,
//                            so a downpipe count > 1 bulk-creates in one pass rather than one wizard run per
//                            zone (the source-granularity audit's bulk-create fix)
//
// kv / r2 / d1 WERE members, as a leftover, and nothing ever assigned them: the radio rows write only the four
// below. The cost of the leftover was not cosmetic. It kept a binding-loss branch in buildWizardSource alive to
// the typechecker while being unreachable in the product, which shipped a `wizard-binding-lost` diagnostic class
// that no build could ever emit. A pack section that can never be populated reads like coverage and is
// not: it tells a support engineer the evidence was looked for and not found. Keeping this union tight to what
// the radio rows actually write is what makes that branch unrepresentable rather than merely unreached.
export type WizType = "workers" | "stream" | "images" | "artifacts";

// EditorPrefill seeds a fresh (create) editor from the guided add-source flow: once the
// operator's deploy makes a new binding live, the add-source screen leads into the create
// editor with the binding name + store type already chosen (and, for a Secrets Store source,
// the first secret's binding), so the journey is one coherent path (choose store -> deploy ->
// configure the downpipe) without duplicating the editor. It is ignored when editing an
// existing downpipe (existing wins). Every field is the operator's own prior input.
export interface EditorPrefill {
  binding?: string;
  type?: SourceType;
  secretBinding?: string;
  // Native resource ids carried from the discovery hand-off (the attach-success bridge / the wizard), so a
  // NEW downpipe created from a discovered source RECORDS its id with zero manual entry. The editor seeds
  // the matching override field from these on a create, so the config is roster-rebuildable on re-attach
  // without a re-save. Non-secret account metadata (a namespace/bucket/database/store id), never a value.
  namespaceId?: string; // kv
  bucketName?: string; // r2
  databaseId?: string; // d1
  secretStoreId?: string; // secrets: the Secrets Store id of the prefilled secret
  // Token / media source pre-selection carried from the "Add a source" hand-off (cf-config / workers /
  // stream / images / artifacts) and from the wizard's "Use the advanced editor" hand-off. These are
  // read by the create WIZARD (openCreateWizard) to auto-select the matching token-source row AND by
  // the create EDITOR (openEditor) when a token/media source is opened from that hand-off, so the
  // account/zone/surfaces survive the jump and the engine never rejects the save with no UI recovery.
  // accountId scopes all five; zoneId is the optional cf-config zone (absent = account-wide); surfaces
  // are the cf-config surface ids the wizard had ticked (absent = the editor seeds all visible).
  accountId?: string;
  zoneId?: string;
  surfaces?: string[];
}
