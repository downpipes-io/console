// Change management (OWNER OPT-IN "Require Change Number"): the console mirror of the engine's change-ref.ts.
// A CHANGE REFERENCE is what the operator attaches to a CAB-worthy change when the policy is on: a change
// number (a normal CAB change) OR an Emergency Change (a deliberate bypass of the number requirement) with a
// justification. It is non-authority operator metadata, recorded by the engine as a change-recorded audit
// event; the console sends it as the X-Downpipes-Change header (base64url JSON) the engine decodes. This is a
// dependency-free leaf so the transport and the requireChange component can import it without a cycle.

// ChangeRef mirrors the engine's ChangeRef shape exactly (so the engine decodes it byte-for-byte): the change
// number (null only for an emergency raised without one), the emergency flag, and the emergency justification.
export interface ChangeRef {
  number: string | null;
  emergency: boolean;
  reason: string | null;
}

// CHANGE_NUMBER_MAX / CHANGE_REASON_MAX bound the operator free text, mirroring the engine's bounds so a value
// the console accepts is never silently truncated by the engine. Used as the input maxlength in the modal.
export const CHANGE_NUMBER_MAX = 64;
export const CHANGE_REASON_MAX = 500;

// encodeChangeHeader serialises a ChangeRef to the X-Downpipes-Change request header value the engine decodes:
// base64url(JSON), the SAME transport encoding the caller header uses (UTF-8 bytes -> btoa -> url-safe), so a
// non-ASCII change number / reason round-trips. btoa exists in both the browser and the validator runtime.
export function encodeChangeHeader(change: ChangeRef): string {
  const json = JSON.stringify(change);
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
