// The Focus Flow question registry: each question's URL step, the plan line its marker sits on, and its view.

import { Q_ROUTE } from "./flow.ts";
import { apply, manual, revoke } from "./q-apply.ts";
import { backup, run } from "./q-backup.ts";
import { bucket, credentials, lock, pricing, provider } from "./q-destination.ts";
import { approval, check, finish, hardening, team } from "./q-finish.ts";
import { custody, generate, savedKeys } from "./q-keys.ts";
import { posture } from "./q-posture.ts";
import { protect } from "./q-protect.ts";
import { connect, welcome } from "./q-start.ts";
import type { QDef, QId } from "./types.ts";

const def = (id: QId, line: QDef["line"], render: QDef["render"]): QDef => ({ id, step: Q_ROUTE[id].step, sub: Q_ROUTE[id].sub, line, render });

export const QUESTIONS: Record<QId, QDef> = {
  welcome: def("welcome", null, welcome),
  connect: def("connect", "token", connect),
  provider: def("provider", "provider", provider),
  bucket: def("bucket", "bucket", bucket),
  lock: def("lock", "lock", lock),
  credentials: def("credentials", "accessKey", credentials),
  pricing: def("pricing", "prices", pricing),
  protect: def("protect", "sources", protect),
  posture: def("posture", "posture", posture),
  custody: def("custody", "custody", custody),
  generate: def("generate", "files", generate),
  saved: def("saved", "saved", savedKeys),
  apply: def("apply", "installed", apply),
  manual: def("manual", "installed", manual),
  revoke: def("revoke", "revoked", revoke),
  backup: def("backup", "downpipes", backup),
  run: def("run", "downpipes", run),
  finish: def("finish", null, finish),
  hardening: def("hardening", null, hardening),
  check: def("check", null, check),
  team: def("team", null, team),
  approval: def("approval", null, approval),
};
