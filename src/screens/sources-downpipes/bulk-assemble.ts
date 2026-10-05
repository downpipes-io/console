// assembleBulkDownpipes turns a ticked selection of BINDING-BACKED sources into the wire Downpipe
// list a bulk create sends, ONE place, so the create wizard's multi-source step and the Sources
// bulk-protect tier cannot drift on naming, ids, fan-out or the secrets rule. The rules:
//   - each kv / r2 / d1 binding becomes ITS OWN downpipe (per-resource history, restore and drift
//     stay per binding), named with the shared friendlyName derivation and a slug id;
//   - the SECRETS bindings in the selection bundle into ONE downpipe of type "secrets" (the product
//     model: a Secrets downpipe reads a set of named secrets through their own bindings). Each row
//     carries the Secrets Store secret NAME and store id discovered for its binding, because the
//     engine keys a secret's wiring on the store's secret_name, not on a display label;
//   - the shared cadence and the ordered destination fan-out (first = primary) apply to every
//     downpipe in the batch; an empty fan-out follows the default destination, exactly like a
//     single create.
// Pure (no DOM, no client), exported for the validator.

import type { Downpipe, SourceDiscovery } from "../../api.ts";
import type { ProtectType } from "../sources/shared.ts";
import { slugId, sourceBindingFor } from "../sources/shared.ts";
import { friendlyName } from "./helpers.ts";

// One prepared create, labelled for failure reporting (the binding for a store downpipe; the
// bundle's name for the secrets downpipe, since it covers several bindings).
export interface AssembledCreate {
  dp: Downpipe;
  label: string;
}

export const SECRETS_BUNDLE_NAME = "Secrets Store";

// SecretRef is what the discovery knows about the Secrets Store secret behind one bound binding.
export interface SecretRef {
  name: string;
  storeId: string;
}

// secretRefsFromDiscovery maps each Secrets Store secret in the ENGINE'S OWN account to the binding the Sources
// attach flow gives it (sourceBindingFor with the SRC_SEC_ prefix), so a bound binding resolves back to the
// secret name and store id the engine's wiring read keys on. Only the engine's account is read, because a
// binding attaches only there. Two secrets that derive the same binding (the same name in two stores) are both
// dropped: the console cannot say which one the binding reads, and a wrong store id is worse than none.
export function secretRefsFromDiscovery(found: SourceDiscovery | null | undefined): Map<string, SecretRef> {
  const out = new Map<string, SecretRef>();
  const clash = new Set<string>();
  const acct = (found?.accounts ?? []).find((a) => found?.engineAccountId != null && a.accountId === found.engineAccountId);
  for (const sec of acct?.secrets ?? []) {
    const binding = sourceBindingFor("SRC_SEC_", sec.name);
    if (out.has(binding)) clash.add(binding);
    else out.set(binding, { name: sec.name, storeId: sec.storeId });
  }
  for (const b of clash) out.delete(b);
  return out;
}

// secretNameFor is the Secrets Store secret name a bundled row records. The discovered name wins. With no
// discovered record (the account tier is off, or the binding was attached by hand), the name is the binding
// with the attach flow's SRC_SEC_ prefix removed, which is the secret's own name whenever that name holds only
// letters, digits and underscores. It is never the display label: "Src Sec Api Key" is not a name the store
// holds, so the engine's wiring read could never match it.
function secretNameFor(binding: string, ref: SecretRef | undefined): string {
  if (ref) return ref.name;
  return binding.startsWith("SRC_SEC_") && binding.length > "SRC_SEC_".length ? binding.slice("SRC_SEC_".length) : binding;
}

export function assembleBulkDownpipes(
  entries: Array<[string, ProtectType]>,
  cadenceSeconds: number,
  destinationIds: string[],
  secretRefs: ReadonlyMap<string, SecretRef> = new Map(),
): AssembledCreate[] {
  const fanOut = destinationIds.length > 0 ? { destinationIds: [...destinationIds] } : {};
  const out: AssembledCreate[] = [];
  const secretBindings: string[] = [];
  for (const [binding, type] of entries) {
    if (type === "secrets") {
      secretBindings.push(binding);
      continue;
    }
    out.push({
      label: binding,
      dp: {
        id: slugId(binding),
        name: friendlyName(binding),
        cadenceSeconds,
        enabled: true,
        source: { type, binding, include: [], exclude: [] },
        ...fanOut,
      },
    });
  }
  if (secretBindings.length > 0) {
    out.push({
      label: SECRETS_BUNDLE_NAME,
      dp: {
        id: slugId(SECRETS_BUNDLE_NAME),
        name: SECRETS_BUNDLE_NAME,
        cadenceSeconds,
        enabled: true,
        source: {
          type: "secrets",
          secrets: secretBindings.map((binding) => {
            const ref = secretRefs.get(binding);
            return { name: secretNameFor(binding, ref), binding, ...(ref ? { storeId: ref.storeId } : {}) };
          }),
          include: [],
          exclude: [],
        },
        ...fanOut,
      },
    });
  }
  return out;
}

// ---- cf-config multi-zone bulk -----------------------
//
// A zone-scoped cf-config source's applicable() also returns every account-wide surface (~195 of
// them), so N zones picked one at a time each duplicate the account config into their own
// downpipe: N x waste, plus restore ambiguity about which copy is canonical. CfScopePreset is the
// operator's explicit choice of what a ticked zone's downpipe captures; assembleCfConfigBulk turns
// the ticked zones + accounts into the wire Downpipe list, mirroring assembleBulkDownpipes's shape
// (AssembledCreate[]) so the wizard's shared bulk-create loop and per-item failure reporting need
// no branching between the two source families.

// CfScopePreset drives the cf-config source step's selector:
//   "account-only"    -> a source with NO zoneId (the engine yields only the ~195 account
//                        surfaces): the ONE canonical account-config downpipe.
//   "zone-only"       -> a source WITH zoneId, include restricted to the zone-scoped surface ids
//                        only, so it never re-captures the account surfaces a zone's applicable()
//                        also returns.
//   "account-and-zone"-> the original behaviour: zoneId set, include:[] (every surface, account
//                        ones included). Kept as an option (an operator may want each zone
//                        downpipe self-contained) but is not the default once 2+ zones are ticked.
export type CfScopePreset = "account-only" | "zone-only" | "account-and-zone";

// defaultCfScopePreset picks the preset's starting value before the operator has touched the
// control: a single zone (or none yet discovered) defaults to "account-and-zone", today's exact
// single-zone behaviour, so a one-zone customer sees no change at all. Two or more zones default
// to "zone-only", the audit's fix, so the wasteful default only changes once it would actually be
// wasteful. Pure, exported for the validator.
export function defaultCfScopePreset(totalZones: number): CfScopePreset {
  return totalZones > 1 ? "zone-only" : "account-and-zone";
}

// A ticked zone: its own downpipe, surfaces per the preset.
export interface CfConfigZoneTick {
  zoneId: string;
  zoneName: string;
  accountId: string;
}

// A ticked account: its own account-wide downpipe (no zoneId, every account surface). multiAccount
// says whether more than one Cloudflare account was DISCOVERED (not ticked), so the name matches
// the row's own label exactly ("Account-wide configuration" when there is only ever one account to
// disambiguate; "<account name> configuration" when several accounts are in play).
export interface CfConfigAccountTick {
  accountId: string;
  accountName: string;
  multiAccount: boolean;
}

// assembleCfConfigBulk turns the ticked zone + account selection into the wire Downpipe list a
// bulk create sends: one downpipe per ticked zone (its surfaces per `preset`) plus one downpipe
// per ticked account (always every account surface, an account-wide downpipe has no other scope to
// restrict). zoneSurfaceIds is the "zone-only" preset's include list, the surface ids the engine
// catalogue tags scope:"zone" (DNS, WAF, zone settings, ...); computed by the caller from the live
// discovery catalogue so this function stays free of any catalogue-shape assumption. Pure, exported
// for the validator.
export function assembleCfConfigBulk(
  zones: CfConfigZoneTick[],
  accounts: CfConfigAccountTick[],
  preset: CfScopePreset,
  zoneSurfaceIds: string[],
  cadenceSeconds: number,
  destinationIds: string[],
): AssembledCreate[] {
  const fanOut = destinationIds.length > 0 ? { destinationIds: [...destinationIds] } : {};
  const zoneOnly = preset === "zone-only";
  const out: AssembledCreate[] = [];
  for (const z of zones) {
    out.push({
      label: z.zoneName,
      dp: {
        id: slugId(z.zoneName),
        name: friendlyName(z.zoneName),
        cadenceSeconds,
        enabled: true,
        source: {
          type: "cf-config",
          zoneId: z.zoneId,
          accountId: z.accountId,
          // zone-only: exactly the zone-scoped ids, never the account ones a zone's applicable()
          // also returns. account-and-zone (and the moot account-only, which never ticks a zone):
          // include:[] = every surface, the compact "all" wire form, matching a single manual pick.
          include: zoneOnly ? [...zoneSurfaceIds] : [],
          exclude: [],
          cfConfigMode: zoneOnly ? "manual" : "auto",
        },
        ...fanOut,
      },
    });
  }
  for (const a of accounts) {
    const label = a.multiAccount ? `${a.accountName} configuration` : "Account-wide configuration";
    out.push({
      label,
      dp: {
        id: slugId(label),
        name: label,
        cadenceSeconds,
        enabled: true,
        source: { type: "cf-config", accountId: a.accountId, include: [], exclude: [], cfConfigMode: "auto" },
        ...fanOut,
      },
    });
  }
  return out;
}
