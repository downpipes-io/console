// One read of the setup model for the shell and Overview: a "shell" scope refresh (setup-state, the downpipe
// list, this setup's run rings; lib/setup-flow/model.ts), then the shell's view of it (lib/setup-state.ts
// setupViewOf). Kept apart from setup-state.ts so the shell's gate module stays free of the model's engine
// calls and the screens its actions reach.

import type { EngineClient } from "../api.ts";
import { setupModel } from "./setup-flow/model.ts";
import { type SetupView, setLastSetupView, setupViewOf } from "./setup-state.ts";

// readSetupView refreshes the model's shell facts and returns the shell's view (null: do not gate).
export async function readSetupView(): Promise<SetupView | null> {
  const m = setupModel();
  await m.refresh("shell");
  const view = setupViewOf(m.get());
  setLastSetupView(view);
  return view;
}

// readSetupViewHealed is readSetupView plus a one-shot self-heal for the demo engine's "stuck first-run marker":
// after a demo reset the signer and break-glass Worker secrets survive while a marker pins keysReady false, and
// only a key install or an explicit acknowledge clears it. When the Keys step reads not done, this asks the
// engine to acknowledge (server-enforced: it clears ONLY when it observes the keys present, so a keyless engine
// answers ok:false and nothing changes) and, if it cleared anything, reads again. It is a write, so only
// Overview calls it, once per render, never the per-navigation shell refresh. Best-effort: any failure keeps
// the first view.
export async function readSetupViewHealed(engine: EngineClient): Promise<SetupView | null> {
  const view = await readSetupView();
  if (view === null || view.complete) return view;
  if (setupModel().get().facts.keysReady) return view;
  try {
    const ack = await engine.acknowledgeSetup();
    if (ack.ok) return await readSetupView();
  } catch {
    // best-effort: keep the first view
  }
  return view;
}
