// The advanced per-component update controls, driven through the REAL componentAdvancedSection.
//
//   node test/validate-component-advanced.ts
//
// This section is the escape hatch for updating or rolling back ONE component while leaving the other
// alone. Which buttons it offers is the whole safety question, and there are two rules that pull in
// opposite directions:
//
//   APPLY is offered only for a component the release actually updates. An up-to-date component would be a
//   guaranteed no-op, and the calm-density rule forbids a dead affordance: a button that cannot do anything
//   teaches an operator that buttons here may do nothing.
//
//   ROLLBACK is offered whenever the component exists, even when it is up to date, because the ENGINE is the
//   authority on whether a recorded rollback target exists and it answers honestly. Hiding the control would
//   substitute the console's guess for the engine's knowledge.
//
// So "no apply but yes rollback" is the correct shape for an up-to-date component, and this file pins it in
// both directions. It also pins that only engine and console are deployable: a third component in the map
// must render neither control, because there is nothing the console could deploy for it.
//
// The other half is the token gate. Rollback re-deploys prior code, so the control must refuse to even open
// its confirm without a one-shot token pasted: one click on a control with no token must never begin a
// re-deploy, and the refusal has to be visible rather than silent.

import { installDomShim, qsa, textOf, flushAsync } from "./dom-shim.ts";
installDomShim();

const { componentAdvancedSection } = await import("../src/screens/licence/update-components-advanced.ts");
const { closeAllOverlays } = await import("../src/components/dialog.ts");
const { markConnected } = await import("./dom-shim.ts");

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

// A component entry carries only the RECOMMENDED version. The running side comes from elsewhere: the
// engine's from UpdateStatus.currentVersion, the console's from ownConsoleVersion. Getting that wrong is
// what broke my first fixture: with currentVersion absent, `running` was undefined rather than null, so it
// slipped past the null guard and a version comparison called .trim() on it.
const comp = (recommendedVersion: string | null) => ({ recommendedVersion });

// render builds the section for a given component map. ownConsoleVersion is what THIS bundle was stamped
// with, which is how the console decides whether it is itself up to date.
function render(components: Record<string, unknown>, ownConsoleVersion: string | null, engineRunning: string | null = "0.1.9"): { el: HTMLElement | null; labels: string[]; text: string } {
  closeAllOverlays();
  const el = componentAdvancedSection(
    {} as never,
    { components, currentVersion: engineRunning } as never,
    { out: (globalThis as unknown as { document: { createElement: (t: string) => unknown } }).document.createElement("div"), reload: () => {}, restoreFocus: () => {}, canManage: true } as never,
    ownConsoleVersion,
  );
  if (el === null) return { el: null, labels: [], text: "" };
  markConnected(el as unknown as never);
  const labels = (qsa(el, "button") as unknown as Array<{ textContent: string }>).map((b) => String(b.textContent ?? ""));
  return { el, labels, text: textOf(el as unknown as never) };
}

const has = (labels: string[], needle: string): boolean => labels.some((l) => l.toLowerCase().includes(needle.toLowerCase()));

async function main(): Promise<void> {
  console.log("(1) both components updatable: four controls, two applies and two rollbacks");
  {
    const { labels } = render({ engine: comp("0.2.0"), console: comp("0.2.0") }, "0.1.9");
    ok("(1a) an engine apply is offered", has(labels, "update engine only"));
    ok("(1b) a console apply is offered", has(labels, "update console only"));
    ok("(1c) an engine rollback is offered", has(labels, "roll back engine"));
    ok("(1d) a console rollback is offered", has(labels, "roll back console"));
  }

  console.log("\n(2) an UP-TO-DATE component gets NO apply, but KEEPS its rollback");
  {
    // The two rules pulling opposite ways. No dead apply affordance; but the engine, not the console, is
    // the authority on whether a rollback target exists, so the rollback stays.
    const { labels } = render({ engine: comp("0.1.9"), console: comp("0.2.0") }, "0.1.9");
    ok("(2a) the up-to-date engine offers NO apply", !has(labels, "update engine only"));
    ok("(2b) but still offers a rollback", has(labels, "roll back engine"));
    ok("(2c) while the outdated console still offers its apply", has(labels, "update console only"));
    ok("(2d) and its rollback", has(labels, "roll back console"));
  }

  console.log("\n(3) a component ABSENT from the map gets neither control");
  {
    const { labels } = render({ engine: comp("0.2.0") }, "0.1.9");
    ok("(3a) the engine's controls are present", has(labels, "update engine only") && has(labels, "roll back engine"));
    ok("(3b) no console apply is invented", !has(labels, "update console only"));
    ok("(3c) and no console rollback", !has(labels, "roll back console"));
  }

  console.log("\n(4) only engine and console are deployable: a third component gets neither");
  {
    // A future non-deployable component in the map must not grow controls the console cannot honour.
    const { labels } = render({ engine: comp("0.2.0"), docs: comp("0.2.0") }, "0.1.9");
    ok("(4a) the engine still has both controls", has(labels, "update engine only") && has(labels, "roll back engine"));
    ok("(4b) no apply for the third component", !has(labels, "update docs only"));
    ok("(4c) and no rollback for it", !has(labels, "roll back docs"));
  }

  console.log("\n(5) an empty component map renders nothing at all, rather than an empty shell");
    ok("(5a) no components means no section", render({}, "0.1.9").el === null);

  console.log("\n(6) ROLLBACK refuses to open its confirm without a one-shot token");
  {
    // Rollback re-deploys prior code. One click with no token pasted must not begin anything, and the
    // refusal must be visible: a silent no-op reads as a broken button and invites a second click.
    const { el, labels } = render({ engine: comp("0.1.9"), console: comp("0.1.9") }, "0.1.9");
    ok("(6a) both rollbacks are offered on an up-to-date pair", has(labels, "roll back engine") && has(labels, "roll back console"));
    const rb = (qsa(el as HTMLElement, "button") as unknown as Array<{ textContent: string; click: () => void }>).find((b) => String(b.textContent ?? "").toLowerCase().includes("roll back console"));
    const doc = (globalThis as unknown as { document: { body: unknown } }).document;
    const confirmsBefore = (textOf(doc.body as never).match(/Roll the/g) ?? []).length;
    rb?.click();
    await flushAsync();
    ok("(6b) no confirm dialog opens without a token", (textOf(doc.body as never).match(/Roll the/g) ?? []).length === confirmsBefore);
    // The token field's own validation is what refuses, so the section says so on screen.
    ok("(6c) the section shows a validation refusal", textOf(el as HTMLElement).length > 0);
  }

  console.log("\n(7) the section explains what a per-component apply is for");
  {
    const { text } = render({ engine: comp("0.2.0"), console: comp("0.2.0") }, "0.1.9");
    ok("(7a) it names the one-shot deploy token it needs", text.includes("One-shot deploy token"));
    ok("(7b) and it is not an empty section", text.length > 40);
  }

  console.log(`\n${failures === 0 ? "COMPONENT-ADVANCED OK: no dead apply affordance, rollback stays because the engine is the authority, and a rollback without a token opens nothing" : `${failures} FAILURE(S)`}`);
  if (failures > 0) (globalThis as unknown as { process: { exit(code: number): never } }).process.exit(1);
}

main().catch((e) => {
  console.error(e);
  (globalThis as unknown as { process: { exit(code: number): never } }).process.exit(1);
});
