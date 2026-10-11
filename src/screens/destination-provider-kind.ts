// providerKind (and the host derivation it is built from) names the storage provider behind a
// destination, for every screen that needs the same reading: the Destinations badge (destination-
// cards.ts), the Map's destination index (screens/map/data.ts) and the Replace prefill
// (destination-cards-actions.ts buildReplaceOpts).
//
// ITS OWN LEAF MODULE, rather than a member of destination-cards.ts or destination-form-fields.ts.
// destination-cards.ts imports FROM destination-cards-actions.ts (renderConsoleLevers and the rest of the
// lever wiring), and destination-cards-actions.ts needs this derivation too, so putting it in either
// screen file would make the other side of that import a cycle. A leaf both files can import from avoids
// one.
import type { DestinationStatus, Provider } from "../lib/api/types/destinations.ts";

// AZURE_STORAGE_SUFFIXES mirrors the engine's closed list of Azure Storage endpoint suffixes, one per
// Azure cloud (AZURE_STORAGE_SUFFIXES in engine/src/dest/provider.ts):
//
//   core.windows.net        the commercial cloud
//   core.usgovcloudapi.net  Azure US Government
//   core.chinacloudapi.cn   Azure China, operated by 21Vianet
//
// ALL THREE MATTER, not only the commercial cloud: an Azure destination the engine routes to its Azure
// client and its Shared Key signer must be badged by the vendor it actually uses, and for a US Government
// or China-cloud account, matching by suffix rather than by the commercial host alone is what makes that
// possible. The list is written out here rather than matched loosely for the same reason the engine writes
// it out: a nearly-right suffix is a host that never resolves, and the closed clouds absent from the
// engine's list (Microsoft Cloud Germany and the US air-gapped clouds) are absent from this one too, so the
// two agree by construction.
export const AZURE_STORAGE_SUFFIXES: readonly string[] = ["core.windows.net", "core.usgovcloudapi.net", "core.chinacloudapi.cn"];

// AZURE_BLOB_HOST is built from that list the way the engine builds its own, so a cloud added to the list
// is admitted by the matcher in the same edit. The leading "\." is what makes it a match on the ACCOUNT
// LABEL rather than on a bare string ending: without it "notablob.core.windows.net" would read as an Azure
// host, and the "$" is what stops "acct.blob.core.windows.net.evil.example" reading as one. Every dot in a
// suffix is escaped, so a suffix cannot smuggle a regex metacharacter into the pattern.
const AZURE_BLOB_HOST = new RegExp(`\\.blob\\.(?:${AZURE_STORAGE_SUFFIXES.map((sfx) => sfx.replace(/\./g, "\\.")).join("|")})$`, "i");

// providerForEndpointHost names the store behind a destination endpoint host. It MIRRORS the engine's own
// providerForEndpoint (engine/src/dest/provider.ts), which is the authority: the console cannot import it
// across the repo boundary, so the shape is kept deliberately identical, including the difference between
// the two matches: a WHOLE-HOST match for GCS, so a look-alike domain ("storage.googleapis.com.evil.example")
// is not labelled Google, and a SUFFIX match for Azure, because Azure's blob endpoint carries the storage
// account as its first label and so is a different host for every account. "s3" is the residual and stays
// the residual on purpose: any S3-compatible store this does not recognise by host (Wasabi, Backblaze B2,
// MinIO, a private endpoint fronting AWS, or AWS S3 itself, which has no host this module treats specially)
// reads as "s3", the form's generic S3-compatible choice, never a named vendor this cannot confirm.
//
// Exported (rather than kept inside providerKind below) because the destination Replace prefill needs the
// identical host-to-provider hop providerKind uses, so both call this one function instead of keeping two
// copies that could drift apart.
export function providerForEndpointHost(hostOrUrl: string | undefined): Provider {
  const host = (hostOrUrl ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//i, "")
    .replace(/[/?#].*$/, "")
    .replace(/^.*@/, "")
    .replace(/:\d+$/, "");
  if (host === "") return "s3";
  if (/(^|\.)r2\.cloudflarestorage\.com$/.test(host)) return "r2";
  if (host === "storage.googleapis.com") return "gcs";
  if (AZURE_BLOB_HOST.test(host)) return "azure";
  return "s3";
}

// providerKind derives the storage provider from the redaction-safe status: an R2 endpoint host (the
// Cloudflare S3-compatible endpoint) reads as R2; Google Cloud Storage's single S3-interop host reads as
// GCS; an Azure Blob endpoint in any Azure cloud reads as Azure; the deploy-time envKind is the fallback
// for an env record without an endpoint host (providerForEndpointHost's own residual "s3" only defers to
// it when the host itself named nothing); everything else is an S3-compatible store.
//
// Exported so every screen that needs this (the Destinations badge, the Map's destination index, and the
// Replace prefill) reads the SAME derivation rather than a second copy of the host tests.
export function providerKind(st: DestinationStatus): Provider {
  const derived = providerForEndpointHost(st.endpointHost);
  if (derived !== "s3") return derived;
  if (st.envKind) return st.envKind;
  return "s3";
}
