// SourceSpec assembly for the upsert editor submit path, split out of ./editor-upsert.ts
// (move-only). See ./editor.ts for the barrel.

import { isWorkersDevHost } from "./helpers.ts";
import type { SourceType } from "./helpers.ts";
import type { SourceSpec } from "../../api.ts";

// Inputs the submit path has already gathered: the current type, the include/exclude prefixes, the
// token/media account (fixed when editing, from the hand-off prefill on a create), the cf-config
// identity + selection, the media includeContent flag, the secrets rows and the binding / override
// field values. Kept as plain accessors so this stays a move of the original branch logic.
export interface SourceSpecInputs {
  currentType: SourceType;
  include: string[];
  exclude: string[];
  handoffAccountId: string | null;
  cfAccountId: string | null;
  cfZoneId: string | null;
  cfMode: "auto" | "manual";
  cfInclude: string[];
  includeContent: boolean;
  getSecrets: () => Array<{ name: string; binding: string; storeId?: string }>;
  bindingValue: string;
  nsValue: string;
  bucketValue: string;
  d1IdValue: string;
}

// buildSourceSpec assembles the wire SourceSpec for the chosen source type, or returns a blocking
// inline error (with an optional field to focus / a flag for the form-level error). The branch
// logic is identical to the editor's previous inline assembly; only the error surfacing is lifted
// to a return value so the caller keeps owning the DOM error elements.
export function buildSourceSpec(
  input: SourceSpecInputs,
): { source: SourceSpec } | { error: "secrets-empty" } | { error: "binding-required" } | { error: "binding-host" } {
  const {
    currentType,
    include,
    exclude,
    handoffAccountId,
    cfAccountId,
    cfZoneId,
    cfMode,
    cfInclude,
    includeContent,
  } = input;

  if (currentType === "cf-config") {
    // Identity (account/zone) is fixed for the downpipe's life; only the surface selection is editable.
    return {
      source: {
        type: "cf-config",
        ...(cfZoneId !== null ? { zoneId: cfZoneId } : {}),
        ...(cfAccountId !== null ? { accountId: cfAccountId } : {}),
        cfConfigMode: cfMode,
        include: cfInclude,
        exclude: [],
      },
    };
  }
  if (currentType === "workers") {
    // The account is fixed for the downpipe's life (read with the discovery token, like cf-config). It
    // backs up every Worker in the account: there is no script-name filter.
    return {
      source: {
        type: "workers",
        ...(handoffAccountId !== null ? { accountId: handoffAccountId } : {}),
        include: [],
        exclude: [],
      },
    };
  }
  if (currentType === "stream") {
    // The account is fixed for the downpipe's life (read with the discovery token, like cf-config /
    // workers); the inventory is always captured, the video bytes + captions only when content is on.
    return {
      source: {
        type: "stream",
        ...(handoffAccountId !== null ? { accountId: handoffAccountId } : {}),
        ...(includeContent ? { includeContent: true } : {}),
        include: [],
        exclude: [],
      },
    };
  }
  if (currentType === "images") {
    // Account is fixed for the downpipe's life (read with the discovery token); the inventory + variant
    // config are always captured, the image bytes only when content is on.
    return {
      source: {
        type: "images",
        ...(handoffAccountId !== null ? { accountId: handoffAccountId } : {}),
        ...(includeContent ? { includeContent: true } : {}),
        include: [],
        exclude: [],
      },
    };
  }
  if (currentType === "artifacts") {
    // Account is fixed for the downpipe's life (read with the discovery token); the namespace/repo
    // inventory is always captured, the repo blob contents only when content is on.
    return {
      source: {
        type: "artifacts",
        ...(handoffAccountId !== null ? { accountId: handoffAccountId } : {}),
        ...(includeContent ? { includeContent: true } : {}),
        include: [],
        exclude: [],
      },
    };
  }
  if (currentType === "secrets") {
    const secrets = input.getSecrets();
    if (secrets.length === 0) return { error: "secrets-empty" };
    return { source: { type: "secrets", secrets, include, exclude } };
  }
  const binding = input.bindingValue.trim();
  if (binding === "") return { error: "binding-required" };
  if (isWorkersDevHost(binding)) return { error: "binding-host" };
  const ns = input.nsValue;
  const bucket = input.bucketValue;
  const d1Id = input.d1IdValue;
  return {
    source: {
      type: currentType,
      binding,
      include,
      exclude,
      ...(currentType === "kv" && ns !== "" ? { namespaceId: ns } : {}),
      ...(currentType === "r2" && bucket !== "" ? { bucketName: bucket } : {}),
      // d1 records its native database id (when supplied) so a roster re-attach can rebuild the binding,
      // the same way kv/r2 record namespaceId/bucketName above.
      ...(currentType === "d1" && d1Id !== "" ? { databaseId: d1Id } : {}),
    },
  };
}
