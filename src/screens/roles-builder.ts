// The custom role builder (section 1, the composable-roles surface). It is the
// console face of the engine's /admin/custom-roles CRUD + custom-role assignment: an operator with the
// access.policy capability (Owner OR access-admin) composes a NAMED capability bundle for their own org
// (e.g. "kv-restorer", "compliance-reader"), shown ALONGSIDE the six built-ins (never replacing them).
//
// What it builds:
//   - a NAME + LABEL (the storage-key name and the human display name);
//   - a CAPABILITY MATRIX (every Capability, the owner-reserved two barred);
//   - a per-screen SEE/EDIT grid (hidden / read / edit), with the engine's edit-requires-write-cap
//     guard mirrored EXACTLY (a screen cannot be "edit" without its write capability in the set);
//   - a TECHNICAL / SHINY presentation switch (a cosmetic skin hint, no authority);
//   - a LANDING picker (the screen the holder opens on; cannot be a hidden screen);
//   - the SIX BUILT-INS shown as editable PRESETS (clone-and-tweak starting points);
//   - a LIVE "what this role will see" PREVIEW that reflects the composed surface + capabilities and
//     the engine's accept/reject verdict (via the same pure validateCustomRole the engine runs).
//
// Authority: this screen is access.policy-gated (Owner / access-admin) for the CLIENT gate; the engine
// re-runs every guardrail (no privilege escalation against the CREATOR's own capabilities, owner-
// reserved caps barred, edit-requires-write-cap, no built-in-name collision) at the write boundary, so
// the console is UX only and never the control. No-custody: a custom role carries a name, label,
// capability list, surface map, presentation and landing only; never a secret, key or value.
//
// CSP: built entirely with the h() builder (lib/dom.ts). NO inline <script>, NO inline event handlers
// (listeners are wired via on:/addEventListener), NO setAttribute("style")/.cssText/injected <style>
// (dynamic styling is per-property CSSOM through h()). See console/SECURITY.md.
//
// This file is the COORDINATOR: it owns the screen descriptor (route, title, measure, actions, render) and
// re-exports the symbols external callers (the roles-builder validator) depend on. The pure composition +
// guard logic, the catalogues and the BuilderState shape live in the ./roles-builder/shared.ts leaf; the
// form half (the composer + every field section) in ./roles-builder/form.ts; the live preview, the Save
// action, the catalogue list and the access gate in ./roles-builder/preview.ts. The file was split for size
// while keeping the public surface byte-identical.
//
// House style: Australian English, no em dashes, precise claims; the engine is the enforcement point.

import { h } from "../lib/dom.ts";
import {
  pageHeader,
  requireEngine,
  canCap,
  pendingEngineNote,
  type Screen,
  type ScreenContext,
} from "./common.ts";
import { navigate } from "../lib/nav.ts";
import { isUnauthorised, classifyError } from "../lib/errors.ts";
import { blockError, sessionEnded } from "../components/error-view.ts";
import { skeletonRows } from "../components/feedback.ts";
import { callerCan } from "../lib/identity-custom-roles.ts";
import { ROUTE_BUILDER, errText } from "./roles-builder/shared.ts";
import { builderBody } from "./roles-builder/form.ts";
import { accessGateCard } from "./roles-builder/preview.ts";

// Re-exports: the roles-builder validator (test/validate-roles-builder.ts) imports the pure composition +
// guard logic BY NAME from this module, so the split keeps every one of those imports working unchanged.
// They live in the ./roles-builder/shared.ts leaf (all pure + DOM-free, so importing them in Node never
// touches a DOM); re-exporting them here keeps the public import surface of screens/roles-builder.ts
// byte-identical.
export {
  composeProposal,
  canSetScreenEdit,
  previewRole,
  nonHiddenScreens,
  demoteEditsLosingWriteCap,
  emptyBuilderState,
  stateFromPreset,
  type BuilderState,
} from "./roles-builder/shared.ts";

// ---------------------------------------------------------------------------
// The screen descriptor. It owns the builder route under the Roles area and
// contributes one capability-gated action so the palette surfaces it only to a caller who can compose
// roles (the engine re-enforces access.policy server-side).
// ---------------------------------------------------------------------------

export const rolesBuilderScreen: Screen = {
  route: ROUTE_BUILDER,
  title: "Custom role builder",
  measure: "wide",
  actions: [
    {
      id: "roles.builder",
      title: "Build a custom role",
      group: "Navigation",
      kind: "navigate",
      keywords: ["custom role", "role builder", "capability", "rbac", "compose", "preset", "surface", "shiny", "technical"],
      target: ROUTE_BUILDER,
      // Surfaced only to a caller who holds access.policy (Owner / access-admin), mirroring the engine
      // gate on the custom-role writes; a null caller fails closed. Read through callerCan, the same
      // resolution the screen's own gate uses (canCap("access.policy") below): reading
      // ROLE_CAPABILITIES[c.role] directly floored a NAMED custom role to the "viewer" its role field
      // carries, so a custom role that genuinely holds access.policy could open the builder from the
      // rail but not find it in the palette.
      when: ({ caller: c }) => c !== null && callerCan(c.role, "access.policy", c.customRole ?? null),
    },
  ],
  render(_ctx: ScreenContext): HTMLElement {
    const engine = requireEngine();
    const root = h("div");
    if (!engine) return root;

    root.appendChild(
      pageHeader(
        "Custom role builder",
        "Compose a named capability bundle for your org, alongside the six built-in roles. Pick the capabilities, decide what each screen shows, choose the presentation and where the holder lands, then preview exactly what the role will see. The engine re-checks every rule when you save: you can never compose a role more powerful than yourself.",
        undefined,
        { label: "Roles and access", to: "/access/roles" },
      ),
    );

    // access.policy gate (Owner / access-admin). The engine is the enforcement point; this is the
    // client mirror. A caller without the capability sees the honest gate, not a 403 later.
    if (!canCap("access.policy")) {
      root.appendChild(accessGateCard());
      return root;
    }

    // The async region: load the existing catalogue (so the builder can show existing roles and refuse
    // a name clash early), then render the builder + the catalogue list.
    const region = h("div", { class: "async-region", style: "margin-top:var(--space-5)" });
    root.appendChild(region);

    const load = (): void => {
      region.replaceChildren(skeletonRows(4));
      void engine
        .listCustomRoles()
        .then((roles) => region.replaceChildren(builderBody(engine, roles, load)))
        .catch((err) => {
          if (isUnauthorised(err)) {
            // PAINT FIRST, THEN LEAVE: the builder region is a skeleton until this replaces it.
            region.replaceChildren(sessionEnded(load));
            return navigate("/signed-out");
          }
          // A 404/501 means the
          // engine's custom-role endpoint is genuinely not wired yet, and composing over an empty catalogue is
          // the honest interim. But a 500 is the engine live and broken, and a network throw is unreachable: in
          // both cases the catalogue was NOT read, and the customer must not be told the feature is merely
          // "pending the engine" while a real fault hides it. Route a genuine fault to the honest block error
          // with Retry; keep the pending-engine note only for a real not-wired build.
          const cls = classifyError(err);
          const notWired = cls.kind === "server" && (cls.status === 404 || cls.status === 501);
          if (!notWired) {
            region.replaceChildren(blockError(err, load, { origin: location.origin }));
            return;
          }
          const body = builderBody(engine, [], load);
          region.replaceChildren(
            pendingEngineNote({
              what: "The existing custom-role catalogue could not load. You can still compose and preview a role below; saving requires the engine's custom-role endpoints.",
              dependsOn: "the engine /admin/custom-roles CRUD (GET and POST)",
              // Save stays visible below (saveRow is unconditional), so the copy must not deny it.
              interim: `The engine returned: ${errText(err)}. Save will be refused until the engine backs it.`,
            }),
            body,
          );
        });
    };
    load();

    return root;
  },
};
