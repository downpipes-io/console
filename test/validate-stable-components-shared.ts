// Shared harness + DOM-shim node helpers + the component-module loader for the
// validate-stable-components suite.
//
// validate-stable-components.ts was split into cohesive groups (the preference libs, the
// table, the overlay family, the confirm/modal dialogs, and the display primitives). This
// module holds exactly what more than one group needs: the assertion harness (so the
// failure count is shared across every group), the small node helpers that read shim nodes
// returned by the REAL render, and a single loader that dynamically imports every component
// module AFTER the shim is installed and hands them back as one context object.
//
// It exists ONLY to RUN the production code; it never re-implements anything under test.

import {
  qsa,
  textOf,
  keydown,
  type ShimNode,
  type ShimEvent,
} from "./dom-shim.ts";

// ==========================================================================
// Assertion harness. The orchestrator constructs one Harness and threads it
// into every group so a single failure count spans the whole suite, exactly as
// the original single-file run did.
// ==========================================================================
export class Harness {
  failures = 0;

  ok(label: string, cond: boolean): void {
    console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
    if (!cond) this.failures++;
  }

  eq(a: unknown, b: unknown, label: string): void {
    const cond = a === b;
    console.log(cond ? `  ok   ${label}` : `  FAIL ${label}  got=${JSON.stringify(a)} want=${JSON.stringify(b)}`);
    if (!cond) this.failures++;
  }
}

// ==========================================================================
// Helpers to read shim nodes returned by the real render (HTMLElement at the
// type level). These are the same byte-identical helpers the single file used.
// ==========================================================================
export const SN = (n: unknown): ShimNode => n as unknown as ShimNode;
export const attr = (n: unknown, k: string): string | null => SN(n).getAttribute(k);
export const click = (n: unknown): void => SN(n).click();
export const fireKeydown = (n: unknown, key: string): boolean => {
  const ev = keydown({ key });
  return SN(n).dispatchEvent(ev as ShimEvent);
};

export function findButtonByText(root: unknown, text: string): ShimNode | undefined {
  return qsa(root, "button").find((b) => textOf(b).includes(text));
}

// ==========================================================================
// The component context: the real modules MORE THAN ONE group needs (or that
// the orchestrator must load once), loaded once. The single-consumer libs
// (lib/theme.ts + lib/aurora-pref.ts) are loaded by the prefs group itself via
// a direct dynamic import so knip can resolve their test usage; they are not on
// this context. The loader is async because every module is imported AFTER
// installDomShim() has run (the orchestrator installs the shim before calling
// loadComponents), so the static-import hoisting can never run a module that
// touches document at load time before the shim exists.
// ==========================================================================
export interface Ctx {
  h: typeof import("../src/lib/dom.ts").h;
  table: typeof import("../src/components/table.ts").table;
  dataTable: typeof import("../src/components/data-table.ts").dataTable;
  dialog: typeof import("../src/components/dialog.ts");
  openDrawer: typeof import("../src/components/drawer.ts").openDrawer;
  drawerSection: typeof import("../src/components/drawer.ts").drawerSection;
  detailDrawer: typeof import("../src/components/detail-drawer.ts");
  typeToConfirm: typeof import("../src/components/confirm.ts").typeToConfirm;
  openModal: typeof import("../src/components/modal.ts").openModal;
  confirmModal: typeof import("../src/components/modal.ts").confirmModal;
  codeBlock: typeof import("../src/components/code-block.ts").codeBlock;
  keyField: typeof import("../src/components/code-block.ts").keyField;
  copyButton: typeof import("../src/components/code-block.ts").copyButton;
  sparkline: typeof import("../src/components/sparkline.ts").sparkline;
  miniBars: typeof import("../src/components/sparkline.ts").miniBars;
  stepper: typeof import("../src/components/wizard.ts").stepper;
  errorView: typeof import("../src/components/error-view.ts");
}

export async function loadComponents(): Promise<Ctx> {
  const { h } = await import("../src/lib/dom.ts");
  const { table } = await import("../src/components/table.ts");
  const { dataTable } = await import("../src/components/data-table.ts");
  const dialog = await import("../src/components/dialog.ts");
  const { openDrawer, drawerSection } = await import("../src/components/drawer.ts");
  const detailDrawer = await import("../src/components/detail-drawer.ts");
  const { typeToConfirm } = await import("../src/components/confirm.ts");
  const { openModal, confirmModal } = await import("../src/components/modal.ts");
  const { codeBlock, keyField, copyButton } = await import("../src/components/code-block.ts");
  const { sparkline, miniBars } = await import("../src/components/sparkline.ts");
  const { stepper } = await import("../src/components/wizard.ts");
  const errorView = await import("../src/components/error-view.ts");
  return {
    h, table, dataTable, dialog, openDrawer, drawerSection, detailDrawer,
    typeToConfirm, openModal, confirmModal, codeBlock, keyField, copyButton,
    sparkline, miniBars, stepper, errorView,
  };
}
