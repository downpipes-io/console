// RG14: every IdP preset the ENGINE actually publishes, rendered through the REAL console form.
//
//   node test/validate-idp-presets-drift.ts        (cross-repo: needs ../engine)
//
// This is a DRIFT gate, not a fixture test. The console does not hold its own preset table: it fetches
// GET /admin/idp/presets and renders whatever the engine returns (client-idp.ts). So the failure mode is
// one-sided change. The engine adds a provider, or alters one var's shape, and the console renders it
// wrongly or not at all, with nothing in either repo's own suite noticing because each side is
// self-consistent. The presets are therefore imported from the engine's own listPresets() the same way
// validate-licence-compat.ts imports the engine verifier, so this file measures the REAL catalogue rather
// than a copy of it that could rot.
//
// The subtle rule, and the one that has already bitten once: a var whose default is the EMPTY STRING is
// OPTIONAL. That is the engine's signal for "additive, leave it blank for a sign-in-only connection", and
// forms.ts implements it as `v.default === ""`. Requiring those fields once blocked exactly the
// sign-in-only setup the documentation told the operator to perform (recorded in forms.ts as fieldwalk
// , OIDC F1). An empty-string default is FALSY, so any refactor reaching for a truthiness test
// re-breaks it, and nothing on screen would look wrong: the field simply becomes mandatory.
//
// The last section is the actual drift assertion: every var in the live catalogue must fall into one of
// the three shapes the console handles. A fourth shape appearing in the engine fails here rather than in
// a customer's connection attempt.

import { existsSync } from "node:fs";
import { installDomShim, qsa, textOf } from "./dom-shim.ts";
import { verdictCannotCheck, verdictReached, verdictSkipped } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts
installDomShim();

const { presetForm } = await import("../src/screens/idp-connections/forms.ts");
// Resolved at RUNTIME rather than imported statically, which is how validate-identity.ts reaches the
// engine and for the same reason: this file is a cross-repo gate, run from `validate:workspace` in the
// job that checks out the siblings. A static import makes the console's own single-repo type check
// depend on a directory that is not there, and it fails with a missing module plus a cascade of
// implicit anys. That is what it did the first time the test type check was wired into CI.
//
// DOWNPIPES_ENGINE overrides the location, because this work happens in worktrees and a run from the
// console main checkout would otherwise compare against the engine's main branch rather than the code
// under change.
//
// The shape below is declared here on purpose. It is the contract this file exists to police, so
// writing it out means a change to the engine's preset shape shows up as a type error in the console
// rather than as an untyped value that renders wrongly.
interface PresetVar {
  key: string;
  label: string;
  example?: string;
  default?: string;
}
interface IdpPreset {
  id: string;
  label: string;
  vendor: string;
  buttonLabel: string;
  kind: string;
  requiredVars: PresetVar[];
  notes: string[];
  docsUrl?: string;
}
const engineOverride = process.env.DOWNPIPES_ENGINE;
const ENGINE_PRESETS = engineOverride
  ? new URL(`file://${engineOverride}/src/admin/oidc-presets.ts`).href
  : new URL("../../engine/src/admin/oidc-presets.ts", import.meta.url).href;
// THE IMPORT IS ASKED ABOUT BEFORE IT IS MADE. This line was a bare `await import`, so a
// checkout with no engine got ERR_MODULE_NOT_FOUND, a module-resolution stack and exit 1: a could-not-check
// wearing the exit code that means "the console diverged from the engine", with no sentence anywhere saying
// which of the two it was. Measured at console 9933448b from a console worktree with no engine at any
// candidate path, exit read off the process: 1, through the loader, before a single assertion ran.
//
// EVERY assertion in this file is derived from listPresets(), so unlike its neighbours there is no
// console-only half to fall back to. It refuses in the chain that must have an engine and declares a skip
// elsewhere, which is the shape test/validate-cf-surface-contract.ts already settled on for the same reason.
if (!existsSync(new URL(ENGINE_PRESETS).pathname)) {
  const why = `no engine checkout supplied src/admin/oidc-presets.ts (looked at ${new URL(ENGINE_PRESETS).pathname})`;
  if (process.env.REQUIRE_ENGINE === "1") {
    verdictCannotCheck(
      `validate-idp-presets-drift: REFUSED, REQUIRE_ENGINE=1 and ${why}.\n` +
        "  Every preset graded here is the engine's own listPresets() output, so with no engine this file has\n" +
        "  nothing to render and nothing to compare, and it will not report that the drift check happened.\n" +
        "  Point it at one with DOWNPIPES_ENGINE=/path/to/engine, or check the engine out beside this repo.",
    );
  }
  verdictSkipped(`IDP PRESETS DRIFT: CANNOT CHECK, ${why}, so nothing here compared anything`);
  process.exit(0);
}
const { listPresets } = (await import(ENGINE_PRESETS)) as { listPresets: () => IdpPreset[] };
const { markConnected } = await import("./dom-shim.ts");

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

const PRESETS = listPresets();

// A minimal engine. The form's guide panel calls idpRedirectUri SYNCHRONOUSLY while rendering (it shows
// the operator the exact callback URL to register at their IdP), so a stub without it throws during
// render rather than on submit. Everything else here is only reached on submit, which this file never does.
const engine = {
  idpPresets: async () => ({ ok: true, presets: PRESETS }),
  idpRedirectUri: (connId: string) => `https://console.example/admin/idp/callback/${connId}`,
} as unknown;

function render(preset: unknown): { el: HTMLElement; text: string } {
  const el = presetForm(engine as never, preset as never, () => {});
  markConnected(el as unknown as never);
  return { el, text: textOf(el as unknown as never) };
}

// fieldFor finds the rendered control for a preset var by the id forms.ts assigns it.
//
// Required-ness is read from aria-required, not from a `required` attribute. field() marks a required
// control with `aria-required="true"` (components/field.ts) and enforces it in its own blur validation
// rather than leaning on native constraint validation, so aria-required IS the rendered signal here. My
// first version checked for a `required` attribute and reported every genuinely required var as optional,
// which would have inverted the very rule this file exists to pin.
function fieldFor(el: HTMLElement, key: string): { value: string; required: boolean } | undefined {
  const inputs = qsa(el, "input") as unknown as Array<{ id: string; value: string; getAttribute: (k: string) => string | null }>;
  const found = inputs.find((i) => i.id === `idp-var-${key}`);
  if (found === undefined) return undefined;
  return { value: found.value, required: found.getAttribute("aria-required") === "true" };
}

async function main(): Promise<void> {
  console.log(`(1) the live catalogue is non-trivial and every preset renders (${PRESETS.length} presets)`);
    // A guard on the guard: if listPresets ever returned an empty array this whole file would pass while
    // testing nothing, which is the vacuous-test failure mode.
    ok("(1a) the engine publishes several presets", PRESETS.length >= 8);
    ok("(1b) more than one kind is represented", new Set(PRESETS.map((p) => p.kind)).size >= 2);
    for (const p of PRESETS) {
      let rendered = false;
      try {
        const { text } = render(p);
        rendered = text.length > 0;
      } catch {
        rendered = false;
      }
      ok(`(1c) ${p.id} renders a form`, rendered);
    }

  console.log("\n(2) every preset's label and every one of its vars reaches the form");
    for (const p of PRESETS) {
      const { el, text } = render(p);
      ok(`(2) ${p.id}: the provider label appears`, text.includes(p.label));
      const missing = p.requiredVars.filter((v) => fieldFor(el, v.key) === undefined);
      ok(`(2) ${p.id}: all ${p.requiredVars.length} var(s) render a control`, missing.length === 0);
      const unlabelled = p.requiredVars.filter((v) => !text.includes(v.label));
      ok(`(2) ${p.id}: every var carries its engine-supplied label`, unlabelled.length === 0);
    }

  console.log("\n(3) THE FALSY-DEFAULT RULE: default === \"\" means optional, everything else required");
  {
    const emptyDefault = PRESETS.flatMap((p) => p.requiredVars.filter((v) => v.default === "").map((v) => ({ p, v })));
    const realDefault = PRESETS.flatMap((p) => p.requiredVars.filter((v) => v.default !== undefined && v.default !== "").map((v) => ({ p, v })));
    const noDefault = PRESETS.flatMap((p) => p.requiredVars.filter((v) => v.default === undefined).map((v) => ({ p, v })));
    // The catalogue must actually contain each class, or the assertions below prove nothing.
    ok(`(3a) the catalogue contains at least one empty-string default (found ${emptyDefault.length})`, emptyDefault.length >= 1);
    ok(`(3b) at least one meaningful default (found ${realDefault.length})`, realDefault.length >= 1);
    ok(`(3c) at least one var with no default (found ${noDefault.length})`, noDefault.length >= 1);

    for (const { p, v } of emptyDefault) {
      const f = fieldFor(render(p).el, v.key);
      ok(`(3d) ${p.id}.${v.key} (empty default) is NOT required`, f !== undefined && f.required === false);
      ok(`(3e) ${p.id}.${v.key} (empty default) starts blank`, f !== undefined && f.value === "");
    }
    for (const { p, v } of realDefault) {
      const f = fieldFor(render(p).el, v.key);
      ok(`(3f) ${p.id}.${v.key} is required`, f !== undefined && f.required === true);
      ok(`(3g) ${p.id}.${v.key} is pre-filled with the engine's default ${JSON.stringify(v.default)}`, f !== undefined && f.value === v.default);
    }
    for (const { p, v } of noDefault) {
      const f = fieldFor(render(p).el, v.key);
      ok(`(3h) ${p.id}.${v.key} (no default) is required`, f !== undefined && f.required === true);
      ok(`(3i) ${p.id}.${v.key} (no default) starts blank`, f !== undefined && f.value === "");
    }
  }

  console.log("\n(4) an optional var's label says so, so the operator is not left guessing");
    // The engine's own labels carry "(optional...)" for these. Worth pinning: an unrequired field with no
    // hint of why reads as an oversight, and an operator who fills it anyway changes behaviour.
    for (const p of PRESETS) {
      for (const v of p.requiredVars.filter((x) => x.default === "")) {
        ok(`(4) ${p.id}.${v.key} is labelled optional`, /optional/i.test(v.label));
      }
    }

  console.log("\n(5) THE DRIFT ASSERTION: no var shape the console does not handle");
  {
    // forms.ts branches on exactly one thing, `v.default === ""`, so every var must be classifiable by
    // it. This section fails if the engine grows a shape the console has no branch for: a new field on
    // PresetVar that changes whether the value is required, or a default of some other falsy kind.
    const unclassified = PRESETS.flatMap((p) =>
      p.requiredVars
        .filter((v) => !(v.default === "" || (typeof v.default === "string" && v.default !== "") || v.default === undefined))
        .map((v) => `${p.id}.${v.key}`),
    );
    ok(`(5a) every var is one of the three shapes forms.ts handles${unclassified.length > 0 ? ` (unhandled: ${unclassified.join(", ")})` : ""}`, unclassified.length === 0);
    // A default of a NON-string falsy type would pass `!== ""` and be treated as required while being
    // pre-filled with something odd, so it is called out separately rather than folded into the above.
    const nonString = PRESETS.flatMap((p) => p.requiredVars.filter((v) => v.default !== undefined && typeof v.default !== "string").map((v) => `${p.id}.${v.key}`));
    ok(`(5b) no default is a non-string value${nonString.length > 0 ? ` (found: ${nonString.join(", ")})` : ""}`, nonString.length === 0);
    // Every key must be usable as a DOM id fragment, because forms.ts interpolates it into one. A key with
    // whitespace or a quote would produce a control the form cannot find again.
    const badKeys = PRESETS.flatMap((p) => p.requiredVars.filter((v) => !/^[A-Za-z0-9_]+$/.test(v.key)).map((v) => `${p.id}.${v.key}`));
    ok(`(5c) every var key is a safe id fragment${badKeys.length > 0 ? ` (bad: ${badKeys.join(", ")})` : ""}`, badKeys.length === 0);
    // Two vars sharing a key inside one preset would collide on the id and silently lose a value.
    const dupes = PRESETS.filter((p) => new Set(p.requiredVars.map((v) => v.key)).size !== p.requiredVars.length).map((p) => p.id);
    ok(`(5d) no preset repeats a var key${dupes.length > 0 ? ` (${dupes.join(", ")})` : ""}`, dupes.length === 0);
  }

  console.log(`\n${failures === 0 ? `IDP-PRESETS-DRIFT OK: all ${PRESETS.length} engine presets render, and an empty-string default stays OPTIONAL on every one of them` : `${failures} FAILURE(S)`}`);
  verdictReached(failures); // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
  if (failures > 0) (globalThis as unknown as { process: { exit(code: number): never } }).process.exit(1);
}

main().catch((e) => {
  console.error(e);
  (globalThis as unknown as { process: { exit(code: number): never } }).process.exit(1);
});
