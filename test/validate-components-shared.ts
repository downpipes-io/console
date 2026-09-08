// Shared helpers for the validate-components suite. The suite is split into
// area modules (data-table, sparkline/status, trust, modal/drawer,
// access-security); each module receives an `ok` assertion function bound to a
// single shared failure counter so the orchestrator can report one summary.
//
// This module owns no assertions of its own; it only provides the `ok` helper
// and the minimal Caller builder used by several area modules.

import type { Caller } from "../src/api.ts";

// A mutable counter shared across every area module so failures aggregate into
// one total. The orchestrator reads `failures` after every group has run.
export interface SuiteState {
  failures: number;
}

// Build an `ok` assertion bound to a shared state object. Behaviour is
// identical to the previous inline `ok`: it logs an ok/FAIL line and bumps the
// shared failure counter when the condition is false.
export function makeOk(state: SuiteState): (label: string, cond: boolean) => void {
  return function ok(label: string, cond: boolean): void {
    console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
    if (!cond) state.failures++;
  };
}

// Build a minimal Caller without going through the full API client. Several
// trust-chip cases need this, so it lives in the shared module.
export function makeCaller(
  method: "access" | "token",
  email?: string,
  identityProvider?: string,
): Caller {
  return {
    method,
    email: email ?? null,
    ...(identityProvider !== undefined ? { identityProvider } : {}),
  } as unknown as Caller;
}
