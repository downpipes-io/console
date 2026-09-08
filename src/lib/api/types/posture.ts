// Security-centre / posture mirror types, split out of ../types.ts (move-only). See ../types.ts for the barrel.

// Security centre / posture, mirrored byte-for-byte. A posture report is
// a pure computation over the account's own observable state; no I/O, no secret.

// PostureSeverity weights a check's contribution to the score (critical 5, high 3, medium 2, low 1).
export type PostureSeverity = "critical" | "high" | "medium" | "low";

// PostureStatus is a check's EFFECTIVE outcome after the owner-override fold:
//   pass                 : platform-observed satisfied.
//   fail                 : platform-observed not satisfied, no override recorded.
//   unattested           : the platform CANNOT observe this control and no attestation is recorded yet
//                          ("needs attestation" -- score-negative but never presented as a red failure
//                          the operator has no automatic way to clear).
//   risk-accepted        : an Owner deliberately accepted the risk (counts as pass for the score, always
//                          listed as an accepted risk, never presented as a pass).
//   attested-pass        : an Owner attested the control IS satisfied by means the platform cannot
//                          observe (reason recorded). Presented as "pass (attested)".
//   compensating-control : an Owner recorded a compensating control satisfying the intent. Presented as
//                          "pass (compensating control)".
//   not-applicable       : an Owner determined the control does not apply. Excluded from the score
//                          entirely; shown as N/A.
//   resolved-alternative : reserved (platform-observed alternative), kept so older signed reports render.
export type PostureStatus =
  | "pass"
  | "fail"
  | "unattested"
  | "risk-accepted"
  | "attested-pass"
  | "compensating-control"
  | "not-applicable"
  | "resolved-alternative";

// PostureAutoStatus is the AUTOMATIC outcome before any override fold. "cannot-verify" marks a control
// the platform genuinely cannot observe (it is satisfied by attestation, never by fabrication).
export type PostureAutoStatus = "pass" | "fail" | "cannot-verify";

// PostureOverrideKind is the closed set of owner-set override kinds (the customer's own grading).
export type PostureOverrideKind = "risk-accepted" | "attested-pass" | "compensating-control" | "not-applicable";

// PostureCheckOverride is the override as it appears ON a check: the kind, the owner's reason, who set
// it and when. Present even when DORMANT (the automatic outcome passes on its own), so the console can
// state it and offer a withdraw.
export interface PostureCheckOverride {
  kind: PostureOverrideKind;
  reason: string;
  setBy: string | null;
  setAt: string;
}

// PostureCheck is one graded control. id is a stable id (e.g. "restore-test-recency"); control is
// the named standard (e.g. "CIS 11.5", "Essential Eight ML2"); detail is what was observed;
// remediation is how to fix it; how states how the determination is made (plain language); autoStatus
// is the automatic outcome before the override fold. All redaction-safe; the console escapes the
// strings on render.
export interface PostureCheck {
  id: string;
  title: string;
  severity: PostureSeverity;
  status: PostureStatus;
  autoStatus: PostureAutoStatus;
  control: string;
  detail: string;
  remediation: string;
  how: string;
  override?: PostureCheckOverride;
}

// PostureReport is the GET /admin/posture body: a 0..100 score (weighted pass fraction over the
// enabled, applicable checks; a not-applicable check is excluded from both sides) plus the
// severity-ranked checks. generatedAt is RFC-3339.
export interface PostureReport {
  score: number;
  generatedAt: string;
  checks: PostureCheck[];
}
