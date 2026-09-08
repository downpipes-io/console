// Wire SourceSpec assembly for the guided create wizard's "Create downpipe" step, split out of
// ./editor-wizard.ts. See ./editor.ts for the barrel.
//
// buildWizardSource maps the wizard's chosen-* selection to the engine SourceSpec, branching on the
// chosen type exactly as the wizard's old inline `source:` literal did. It is a pure function of the
// shared WizardState plus the media content opt-in; the caller still owns the Downpipe envelope
// (id, name, cadence, destinationIds).

import { recordHandoffDropped } from "../../lib/client-diag/ring.ts";
import type { SourceSpec } from "../../api.ts";
import type { WizType } from "./editor-types.ts";
import type { WizardState } from "./editor-wizard-source-rows.ts";

// buildWizardSource returns the wire SourceSpec for the wizard's chosen RADIO source. The radio types are
// EXACTLY four (workers / stream / images / artifacts) and every one of them is ACCOUNT-scoped: read with the
// engine's discovery token, carrying no wrangler binding at all.
//
// THERE IS NO BINDING ARM, and there never was a reachable one (G310). The binding-backed kinds (kv / r2 / d1,
// and secrets) are the CHECKBOX selection: they live in state.chosenMulti, KEYED BY THE BINDING NAME, and they
// are assembled by assembleBulkDownpipes (./bulk-assemble.ts). cf-config is likewise a tick-many selection
// (assembleCfConfigBulk). So nothing in the console has ever assigned chosenType = "kv" | "r2" | "d1", and a
// binding cannot go missing on this path even in principle: on the path that HAS bindings, the binding is the
// map key. The old `: { type: chosenType!, binding: chosenBinding! }` fallback arm typechecked only because
// WizType still carried the three binding kinds as a leftover, and that is what kept a dead branch looking
// alive. WizType is now the four radio types, so the branch is not merely unreached, it is unrepresentable.
//
// The chosen type is passed in NARROWED (the caller has already established it is non-null), so this function
// has no null case to invent an answer for.
export function buildWizardSource(state: WizardState, chosenType: WizType, includeContent: boolean): SourceSpec {
  // G310: the wizard LOST a pick between its own steps. Every branch below omits the account with `...(x !== null
  // ? {accountId: x} : {})`, so a source spec is assembled that is MISSING a field the operator supplied two
  // steps ago. The engine then answers a generic 400 that names a shape problem, and support cannot tell a broken
  // product journey from operator error. THE VALUE NEVER RIDES: an account id is the customer's own.
  noteWizardLoss(state, chosenType);
  return chosenType === "workers"
    ? {
        type: "workers",
        // Account-scoped (read with the discovery token), no binding. Backs up every Worker in the
        // account: there is no script-name filter.
        ...(state.chosenWorkersAccountId !== null ? { accountId: state.chosenWorkersAccountId } : {}),
        include: [],
        exclude: [],
      }
    : chosenType === "stream"
    ? {
        type: "stream",
        // Account-scoped (read with the discovery token), no binding. Metadata always; the video bytes
        // + captions only when content capture is opted in.
        ...(state.chosenStreamAccountId !== null ? { accountId: state.chosenStreamAccountId } : {}),
        ...(includeContent ? { includeContent: true } : {}),
        include: [],
        exclude: [],
      }
    : chosenType === "images"
    ? {
        type: "images",
        // Account-scoped (read with the discovery token), no binding. Metadata always; the image bytes
        // only when content capture is opted in.
        ...(state.chosenImagesAccountId !== null ? { accountId: state.chosenImagesAccountId } : {}),
        ...(includeContent ? { includeContent: true } : {}),
        include: [],
        exclude: [],
      }
    : {
        // artifacts, the fourth and last radio type: the tail of an EXHAUSTIVE chain over WizType, not a
        // catch-all. Account-scoped (read with the discovery token), no binding. Inventory always; the repo
        // blob contents only when content capture is opted in.
        type: "artifacts",
        ...(state.chosenArtifactsAccountId !== null ? { accountId: state.chosenArtifactsAccountId } : {}),
        ...(includeContent ? { includeContent: true } : {}),
        include: [],
        exclude: [],
      };
}

// noteWizardLoss records the accountless spec buildWizardSource is about to bake and SEND (G310). It reads the
// SAME null checks the builder does, so the two cannot disagree about what is missing. All four radio types are
// account-scoped, so there is one state to record here: the spec builder was reached with no account id, the spec
// goes to the engine without one, and the engine answers a shape 400 the operator cannot attribute to anything.
//
// IT DOES NOT CLAIM THE WIZARD LOST THE ACCOUNT, because the wizard cannot. Each of the four
// discovered-row apply() closures writes state.chosen<T>AccountId in the same block as chosenBinding, off a
// required field of the discovered row, and Continue stays disabled until a row is picked; the sole caller of
// buildWizardSource is gated on chosenBinding !== null. So the ONLY writer that can leave the account null is the
// deep-link prefill, which means an inbound URL carrying a BINDING plus an account-scoped TYPE and no account. No
// console screen emits one. The old class name said the pick was lost between the wizard's steps and sent support
// hunting the step state; what actually happened is that no account was ever picked, and the row now says so.
//
// The spec IS SENT here, and that is the discrimination against editor-refused-account-absent: there is a real 400
// in the customer's engine logs to go and find. The editor's local refusal makes no request at all.
function noteWizardLoss(state: WizardState, chosenType: WizType): void {
  const lost =
    chosenType === "workers" ? state.chosenWorkersAccountId === null
    : chosenType === "stream" ? state.chosenStreamAccountId === null
    : chosenType === "images" ? state.chosenImagesAccountId === null
    : state.chosenArtifactsAccountId === null;
  if (lost) recordHandoffDropped("wizard-spec-account-absent");
}
