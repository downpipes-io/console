// ---- personas (contract section 1) ------------------------------------------------------------
// A persona maps a job title the operator recognises to the role the product recommends, with a
// short, honest blurb. The console uses these in the role-assignment UX to suggest a starting role;
// the chosen role is still the engine-enforced authority. Mirrored from the contract's persona list.

import type { Role } from "./identity-model.ts";

export interface Persona {
  id: string;
  label: string;
  recommendedRole: Role;
  blurb: string;
}

// PERSONAS is the recommended-role suggestion set. CISO -> access-admin (or viewer as an auditor);
// CTO -> owner; Security Engineer -> access-admin (or viewer); Systems Engineer/SRE -> operator;
// DR responder -> restore-operator. The blurbs are redaction-safe product copy, no secret, no value.
export const PERSONAS: Persona[] = [
  {
    id: "cto",
    label: "CTO / Head of Engineering",
    recommendedRole: "owner",
    blurb: "Full authority including the key ceremony and risk acceptance. Keep at least two Owners for availability.",
  },
  {
    id: "ciso",
    label: "CISO / Head of Security",
    recommendedRole: "access-admin",
    blurb: "Manages people and the access policy without touching data or recovery. Choose Viewer instead for an audit-only seat.",
  },
  {
    id: "security-engineer",
    label: "Security Engineer",
    recommendedRole: "access-admin",
    blurb: "Administers roles and access policy. Choose Viewer for read-only review of posture and the audit trail.",
  },
  {
    id: "sre",
    label: "Systems Engineer / SRE",
    recommendedRole: "operator",
    blurb: "Day-to-day data operations: create and run downpipes, configure alerts, raise a restore request.",
  },
  {
    id: "dr-responder",
    label: "DR responder",
    recommendedRole: "restore-operator",
    blurb: "Recovery only: request, approve and apply restores and run drills. Cannot change downpipes, people or keys.",
  },
];
