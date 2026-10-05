// The Finish step's DATA: the decision receipt (CONTRACT requirement 14) and the optional next steps, each
// with its skip default. Pure functions of a snapshot; a UI lays them out (and can print them).

import { schemeLabel } from "../custody.ts";
import { effectivePosture, firstRunSealed } from "./steps.ts";
import { pickedResources } from "./model.ts";
import { customRetentionLabel, POSTURES, PROVIDERS_INFO, restoreTestChoices, retentionChoices, SCHEDULES } from "./inventory.ts";
import type { SetupSnapshot } from "./types.ts";

export interface ReceiptLine {
  label: string;
  value: string;
}

export interface Receipt {
  posture: ReceiptLine[];
  custody: ReceiptLine[];
  destination: ReceiptLine[];
  sources: Array<{ name: string; type: string; binding: string | null }>;
  schedule: ReceiptLine[];
  tokens: Array<{ name: string; status: string }>;
  firstRun: ReceiptLine[];
}

const KIND_LABEL: Record<string, string> = {
  kv: "KV namespace",
  r2: "R2 bucket",
  d1: "D1 database",
  secrets: "Secrets Store secret",
  "cf-config": "Cloudflare configuration",
  workers: "Workers",
  stream: "Stream",
  images: "Images",
};

// buildReceipt names every decision the setup made. A fact the engine did not report reads as "Not
// reported", never as a guess.
export function buildReceipt(s: SetupSnapshot): Receipt {
  const d = s.draft;
  const f = s.facts;
  // The posture this setup confirmed, or the one keys already on the engine set (deploy.sh makes keys before the
  // console first loads). Only a posture confirmed here has a statement this setup recorded.
  const effective = effectivePosture(f, d);
  const posture = POSTURES.find((p) => p.id === effective);
  // Confirmed here only when the posture in force is the one this tab's setup confirmed.
  const confirmedHere = d.posture !== null && d.posture === effective;
  const dest = f.destinations[0];
  const provider = PROVIDERS_INFO.find((p) => p.id === (f.setup?.destination.kind ?? d.provider));
  const custodians = d.custody === "mofn-split" ? `${d.splitShares} (any ${d.splitThreshold} recover)` : d.custody === null ? "Not chosen" : "1";
  const accountLine = d.provider === "r2"
    ? d.otherAccount ? `Cloudflare account ${d.r2AccountId}` : `The engine's account${f.engineAccountId ? ` (${f.engineAccountId})` : ""}`
    : "Outside Cloudflare";
  const worm = dest?.worm;
  const immut = worm ? `${worm.mode === "compliance" ? "Compliance" : "Governance"}, ${worm.retentionDays} days (${dest?.objectLock === "enforced" ? "enforced" : "not verified as enforced"})` : "Off";
  const sched = SCHEDULES.find((x) => x.id === d.schedule);
  const ret = retentionChoices(effective).find((x) => x.id === d.retention);
  const rt = restoreTestChoices(effective).find((x) => x.id === (d.restoreTest ?? (effective === "operational" ? "weekly" : "off")));
  const run = d.firstRun;
  const ring = run ? f.runs[run.downpipeId] ?? [] : [];
  const entry = run ? ring.find((e) => e.runId === run.runId) : undefined;
  return {
    posture: [
      { label: "Key posture", value: posture !== undefined ? `${posture.label}${confirmedHere ? "" : ", set in another tab or before this setup"}` : f.keysReady ? "Set in another tab or before this setup" : "Not chosen" },
      { label: "Statement", value: posture !== undefined && confirmedHere ? `${posture.statement.version}, hash ${d.postureHashPrefix ?? "not computed"}` : "Not recorded here" },
      { label: "Recorded by the engine", value: d.postureRecorded === null ? "Not reported" : d.postureRecorded ? "Yes" : `No${d.postureRefusal !== null ? ` (${d.postureRefusal})` : ""}. Record it again at Finish, or re-affirm it on the Keys screen.` },
    ],
    custody: [
      { label: "Custody scheme", value: d.custody === null ? "Not chosen" : schemeLabel(d.custody) },
      { label: "Custodians", value: custodians },
      { label: "Key possession checked", value: d.possession === "match" ? "Yes, the saved file matches" : d.possession === "mismatch" ? "No, the file did not match" : "Not checked" },
    ],
    destination: [
      { label: "Provider", value: provider?.label ?? "Not reported" },
      { label: "Bucket", value: dest?.bucket ?? f.setup?.destination.bucket ?? d.bucket },
      { label: "Endpoint", value: dest?.endpointHost ?? f.setup?.destination.endpointHost ?? "Not reported" },
      { label: "Account", value: accountLine },
      { label: "Immutability", value: immut },
    ],
    sources: pickedResources(s).map((r) => ({ name: r.name, type: KIND_LABEL[r.kind] ?? r.kind, binding: r.binding ?? null })),
    schedule: [
      { label: "Schedule", value: sched?.label ?? "Not chosen" },
      { label: "Retention", value: d.retentionCustom !== null ? customRetentionLabel(d.retentionCustom) : ret?.label ?? "Not chosen" },
      { label: "Restore test", value: rt?.label ?? "Not chosen" },
    ],
    tokens: [
      { name: "Read-only discovery token", status: f.tokenPresent ? "Stored in your engine. It can only read." : "Not stored" },
      { name: "Destination credential", status: f.setup?.destination.configured ? "Stored in your engine" : "Not stored" },
      {
        name: "Deploy token",
        status: d.applyRoute === "self-deploy" && !d.deployTokenUsed ? "Not used: you deployed yourself"
          : !d.deployTokenUsed ? "Not used"
          : d.deployTokenUses > 1
            ? d.deployTokenRevoked ? `Pasted ${d.deployTokenUses} times. You confirmed you revoked each token.` : `Pasted ${d.deployTokenUses} times. NOT confirmed revoked. Revoke each token in the Cloudflare dashboard.`
            : d.deployTokenRevoked ? "Used once. You confirmed you revoked it." : "Used once. NOT confirmed revoked. Revoke it in the Cloudflare dashboard.",
      },
    ],
    firstRun: [
      { label: "Run", value: run ? run.runId : "Not started" },
      { label: "Result", value: entry === undefined ? "Not reported" : entry.status === "ok" && entry.sealVerification?.status === "verified" ? "Sealed and verified" : entry.status === "ok" && entry.sealVerification === undefined ? "Sealed, seal not verified" : entry.status },
      ...(entry?.recordCount !== undefined ? [{ label: "Records", value: String(entry.recordCount) }] : []),
    ],
  };
}

export interface NextStep {
  id: "team" | "approval" | "hardening";
  label: string;
  // The one line that says what happens when the user skips it.
  skipDefault: string;
  items?: string[];
}

// hardeningSuggestions are fact-based: each names a change the user can make, and only when it applies.
export function hardeningSuggestions(s: SetupSnapshot): string[] {
  const d = s.draft;
  const out: string[] = [];
  if (d.provider === "r2" && !d.otherAccount) out.push("Add a second destination outside this Cloudflare account, so one compromised account cannot reach every copy.");
  if (d.immutability === "off") out.push("Add a destination with Object Lock (S3, Google Cloud or Azure) so archives cannot be deleted.");
  if (effectivePosture(s.facts, d) !== "operational") out.push("Book an attended verification to prove past runs restorable with your offline key.");
  if (d.deployTokenUsed && !d.deployTokenRevoked) out.push(d.deployTokenUses > 1 ? "Revoke each deploy token you pasted, in the Cloudflare dashboard." : "Revoke the deploy token in the Cloudflare dashboard.");
  return out;
}

export function finishNextSteps(s: SetupSnapshot): NextStep[] {
  return [
    { id: "team", label: "Invite your team", skipDefault: "Skip it and only you can sign in. Add people later under Access." },
    { id: "approval", label: "Restore approval", skipDefault: "Skip it and you restore on your own, the engine default. Change it later in Security Centre." },
    { id: "hardening", label: "Hardening suggestions", skipDefault: "Skip them and nothing changes. Security Centre lists them later.", items: hardeningSuggestions(s) },
  ];
}

// canSayProtected is the one test a UI uses before any "protected", "complete", "ready" or "all set" copy.
export function canSayProtected(s: SetupSnapshot): boolean {
  return firstRunSealed(s.facts, s.draft);
}
