// Builds the shell's setup view (src/lib/setup-state.ts setupViewOf) from engine facts, for validators that
// render the strip, the rail locks or the shell: a shell-scope read of GET /admin/setup-state and the downpipe
// list, through the one step model (lib/setup-flow/steps.ts computeSteps), exactly as the shell's own read
// does, with no engine.

import type { DownpipeState, SetupState } from "../src/api.ts";
import { defaultDraft, emptyFacts } from "../src/lib/setup-flow/model.ts";
import { computeSteps, firstRunSealed } from "../src/lib/setup-flow/steps.ts";
import type { SetupDraft } from "../src/lib/setup-flow/types.ts";
import { type SetupView, setupViewOf } from "../src/lib/setup-state.ts";

// A downpipe whose run the engine sealed (its integrity record is present).
export function sealedDownpipe(id = "dp-1"): DownpipeState {
  return { config: { id, name: id, cadenceSeconds: 86400, enabled: true, source: { type: "kv", binding: "SRC_KV_A", include: [], exclude: [] } }, nextRunAt: 0, lastRunId: "r1", inFlight: false, lastIntegrityVerifiedAt: "2026-09-01T00:00:00Z", lastIntegrityVerifiedOk: true } as DownpipeState;
}

export function viewOf(state: SetupState, opts: { downpipes?: DownpipeState[]; draft?: Partial<SetupDraft> } = {}): SetupView {
  const facts = { ...emptyFacts(), setup: state, keysReady: state.keysReady, tokenPresent: state.discoveryTokenPresent, downpipes: opts.downpipes ?? [], readAt: 1, readsAt: { "setup-state": 1, downpipes: 1 } };
  const draft = { ...defaultDraft(), ...opts.draft };
  const runtime = { ceremonyHeld: false };
  const { steps, current } = computeSteps(facts, draft, runtime);
  const view = setupViewOf({ facts, draft, runtime, steps, current, protectedNow: firstRunSealed(facts, draft), completeSeen: false, loading: false });
  if (view === null) throw new Error("setup-view-fixture: the facts were read, so a view must exist");
  return view;
}
