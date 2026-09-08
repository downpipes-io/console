// The faked engine's write handlers, split out of the faked engine (see demo-seed.ts for the file layout).
//
// House rules: Australian English, precise claims (tamper-evident, post-quantum hybrid).

import { b64urlEncode, randomBytes } from "../../bytes.ts";
// restorePlanHash is the SINGLE source of truth for the dual-control binding key (the client mirror of
// the engine's plan-hash). The demo's restore request/approve/apply handlers reuse it verbatim so a
// minted approval's planHash is byte-identical to the value the restore screen computes from the same
// request, which is what arms the Apply gate. It is async (SHA-384), so the four restore-mutation route
// paths return a Promise<Response> while every read and the simple writes stay synchronous (the fetch
// shim's Promise.resolve flattens either return transparently).
import { restorePlanHash } from "../api/helpers.ts";
import type {
  AttestCapsule,
  AttestCapsulesResult,
  AttestSessionRun,
  AttestVerifyResult,
  AttestVerifyRunResult,
  BlindRestoreTest,
  ConfigChange,
  CreateAttestSessionResult,
  DestinationInput,
  DestinationStatus,
  DrillResult,
  KeylessAttestationResult,
  PendingChangeBody,
  PushDestinationInput,
  PushDestinationView,
  PushSink,
  RecoveryCodesResult,
  RestoreApproval,
  RestoreApprovalRequest,
  RestorePlan,
  RestoreRequest,
  RestoreResult,
  RunHistoryEntry,
} from "../api/types.ts";
import { noteDemoDrift } from "./demo-drift.ts";
import { writeAddDownpipe, writeAttachSources, writeDiscoveryToken } from "./demo-routes-write-firstrun.ts";
import { demoDigest, downpipeForRun, runById, selectorsOf, stampProven } from "./demo-routes-write-helpers.ts";
import { APPROVER_EMAIL, DAY, DEMO_ACCT_ID, HOUR, MIN, ORG_OWNER_EMAIL, REQUESTER_EMAIL } from "./demo-seed.ts";
import { benignWrite, demoEpoch, demoIso, demoProviderForEndpoint, json, notImplemented, queuedChange, readBody, setCurrentWritePath, world } from "./demo-world.ts";

// RESTORE_XACCT_DEMO_RUN_ID (COV.9 visual-baseline fixture) is a dedicated, non-narrative run id that
// exists ONLY to give a visual-regression pass a one-click path to a cross-account restore
// plan with an ALREADY-ARMED dual-control approval, so it can capture the type-to-confirm copy
// (confirm.ts confirmApply) without inventing a click sequence that also has to raise and sign a
// request. It carries no run-history ring entry, so runById/downpipeForRun see it as an unrecognised
// run (writeRestore below already degrades that gracefully, borrowing the seeded payments run's
// counts) and it cannot perturb any OTHER demo screen, run count or fixture-driven assertion.
const RESTORE_XACCT_DEMO_RUN_ID = "run-visual-xacct-demo";

// DEMO_RECOVERY_CODES is a FIXED set of 10 codes in the engine's real six-group human format
// (RECOVERY_CODE_GROUPS x RECOVERY_CODE_GROUP_LEN, engine/src/admin/recovery.ts), drawn from the same
// Crockford-base32-minus-I/L/O/U alphabet. Fixed rather than random, matching every other demo write: a
// scripted tour action produces the same result every time. These are demo-only strings; no real code, no
// real key material. POST /admin/auth/recovery-codes/regenerate used to have no case here and fell through
// to benignWrite's generic {ok:true} shape, which recoveryCodesPanel's regenerate-context caller then
// crashed on. Modelling it properly is the OTHER half of that fix: it not only stops the crash (the
// panel and its caller now both degrade honestly on an unusable response regardless), it makes Regenerate
// actually demonstrate the real feature to a visitor instead of ending in a "could not regenerate" toast.
const DEMO_RECOVERY_CODES: readonly string[] = [
  "7M6ET-ZWF05-7J6W0-ZMDSG-PPR4N-5JJX9",
  "K1QQX-V5SZ7-VZSGT-Y1E83-6VY9Y-E7XYG",
  "SKYSV-CJH02-9XZQC-GZXZV-2JMX6-WGWBV",
  "Y4HZQ-6CT9W-050W5-CF72H-P90MZ-8EY8J",
  "5TA8K-TR9CR-06R43-PP11Y-MKWM7-ZXA9D",
  "VNXE4-S2CB2-3WCY1-8D8AB-RHVT5-RKBPB",
  "GXZTJ-XBMYW-7H6DE-05XNT-B1PAP-D7HDJ",
  "H86G6-VA63P-B6MH4-JMAGG-40TGT-036F1",
  "K76PM-X2SMD-XV7QG-RJP3V-1JNJ7-KTM1N",
  "C37A7-728PK-1V8PT-RRFTE-8B1SG-9E11H",
];

// hexOf is a tiny local hex encoder (the demo has no other caller for one; keydecap.ts's own `hex` is not
// exported). Used only for the placeholder key-commitment/fingerprint strings below.
function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// DEMO_ATTEST_FINGERPRINT is a FIXED placeholder recipient fingerprint (the "dpr1:" + hex-sha384
// format identityFingerprint mints from a real identity.key, keydecap.ts) stamped on every demo capsule
// wrap below. It can never equal a real visitor's fingerprint (that would need a genuine SHA-384 preimage
// collision), so openCapsule's own wrap-matching loop always reports "no capsule wrap matches the held
// recipient" for it -- the honest, already-built failure attend.ts's loop already renders as "could not
// recover this run's key with the selected identity.key", not a crash and not a fabricated pass. See
// writeCreateAttestSession for why a demo cannot honestly do better than this: it holds no matching
// recovery keypair to check a real proof against, because the feature's whole guarantee is that nothing
// server-side can decrypt a run without the operator's own, never-uploaded key.
const DEMO_ATTEST_FINGERPRINT = `dpr1:${hexOf(randomBytes(48))}`;

// writeCreateAttestSession models POST /admin/attest/session/create for real: this route and its
// /prove, /capsules and /verify siblings had NO case here, so all four fell through to benignWrite's
// generic {ok:true,deleted:true,applied:true,status:"result",value:{ok:true}}, which carries none of the
// fields restore-flow/attend.ts's runner reads (`session.runs.length` is what actually crashed). Pins
// every downpipe with a completed ("ok") run, honouring an explicit scope, so the runner shows the
// estate's REAL runs and record counts instead of either a crash or a false "Nothing to verify yet".
//
// A visitor who supplies a syntactically valid identity.key can start a session and see it proved and
// pinned for real, but every run then reports "could not recover this run's key" at the capsule step (see
// DEMO_ATTEST_FINGERPRINT) -- the honest ceiling of a no-custody demo, which holds no recovery keypair of
// its own to hand out and check a real proof against.
function writeCreateAttestSession(init?: RequestInit): Response {
  const { scope, sampleRate: requestedRate } = readBody<{ scope?: string[]; sampleRate?: number }>(init);
  const scopeSet = Array.isArray(scope) && scope.length > 0 ? new Set(scope) : null;
  const runs: AttestSessionRun[] = [];
  let records = 0;
  for (const dp of world.downpipes) {
    const id = dp.config.id;
    if (scopeSet && !scopeSet.has(id)) continue;
    const ring = world.historyByDownpipe[id] ?? [];
    const lastOk = ring.find((r) => r.status === "ok");
    if (!lastOk) continue;
    const recordCount = lastOk.recordCount ?? 0;
    runs.push({ downpipeId: id, runId: lastOk.runId, name: dp.config.name || id, recordCount });
    records += recordCount;
  }
  const sampleRate = typeof requestedRate === "number" && Number.isFinite(requestedRate) && requestedRate >= 1 && requestedRate <= 100 ? Math.round(requestedRate) : 100;
  const sessionId = `attest-demo-${world.changeSeq++}`;
  world.attestSessions[sessionId] = { runs, sampleRate };
  const result: CreateAttestSessionResult = {
    sessionId,
    // 1600 bytes = ML-KEM-1024 ciphertext (1568) + X25519 (32), the shape decapsulateHybrid (keydecap.ts)
    // expects, so the browser's own deriveAttestProof runs its real decapsulation path rather than
    // throwing on a malformed length. It resolves to SOME shared secret regardless of whose key opens it
    // (ML-KEM's implicit-rejection design never throws on a ciphertext that was not really encapsulated to
    // this key), which is why the prove step can honestly accept it below without checking anything -- the
    // demo has no expected value to check it against in the first place.
    challenge: { ciphertextB64: b64urlEncode(randomBytes(1600)), nonceB64: b64urlEncode(randomBytes(32)) },
    runs,
    sampleRate,
    estimate: { runs: runs.length, records: Math.max(0, Math.round((records * sampleRate) / 100)) },
  };
  return json(result);
}

// writeProveAttestSession models POST /admin/attest/session/prove: an unconditional accept. The real engine
// checks the browser-derived proof against sha384(expectedProof), computed from the org's actual
// break-glass keypair; the demo holds no such keypair (see writeCreateAttestSession), so there is nothing
// genuine to check the proof against. This is the same coarse handshake-ack posture the demo already gives
// every ceremony probe it cannot truly evaluate (POST /admin/email/test, /admin/idp/test, /admin/canary/run
// all answer a clean pass unconditionally); it asserts nothing false, since no copy anywhere reads this
// response as "your key is verified" on its own -- the outcome that actually matters (can each run's key be
// recovered) is decided honestly, per run, by real client-side crypto against the capsules below.
function writeProveAttestSession(): Response {
  return json({ ok: true });
}

// writeAttestCapsules models POST /admin/attest/session/capsules: one wrap per requested run id (falling
// back to the session's own pinned runs when the caller omits runIds, and to every completed run when the
// session id is unrecognised -- e.g. a resumed session from before a reload re-seeded the world -- so this
// never answers an empty batch a recognisable session should not see). Every wrap carries
// DEMO_ATTEST_FINGERPRINT, so openCapsule's own matching loop (keydecap.ts) honestly reports "no capsule
// wrap matches the held recipient" for each one; see DEMO_ATTEST_FINGERPRINT for why that is the ceiling of
// what this demo can honestly demonstrate, not a shortcut.
function writeAttestCapsules(init?: RequestInit): Response {
  const { sessionId, runIds } = readBody<{ sessionId?: string; runIds?: string[] }>(init);
  const pinned = (typeof sessionId === "string" ? world.attestSessions[sessionId] : undefined)?.runs;
  const ids = Array.isArray(runIds) && runIds.length > 0
    ? runIds
    : (pinned ?? Object.values(world.attestSessions)[0]?.runs ?? []).map((r) => r.runId);
  const capsules: AttestCapsule[] = ids.map((runId) => ({
    runId,
    masterCapsule: [{ fingerprint: DEMO_ATTEST_FINGERPRINT, kemCiphertext: b64urlEncode(randomBytes(1600)), sealed: b64urlEncode(randomBytes(48)) }],
    keyCommitment: hexOf(randomBytes(32)),
    recordCount: pinned?.find((r) => r.runId === runId)?.recordCount ?? 0,
  }));
  const result: AttestCapsulesResult = { capsules };
  return json(result);
}

// writeAttestVerify models POST /admin/attest/session/verify. Unreachable in the demo's realistic click
// path (attend.ts only calls it when a batch of RECOVERED masters is non-empty, and every capsule from
// writeAttestCapsules fails to open first -- see DEMO_ATTEST_FINGERPRINT), but modelled for shape
// completeness rather than left on the benignWrite fallback: an engine that genuinely received this batch
// could not have opened those masters either, so every submitted run honestly reports failed, never a
// fabricated pass.
function writeAttestVerify(init?: RequestInit): Response {
  const { batch } = readBody<{ sessionId?: string; batch?: Array<{ runId: string }> }>(init);
  const items = Array.isArray(batch) ? batch : [];
  const results: AttestVerifyRunResult[] = items.map((b) => ({
    runId: b.runId, ok: false, recordsVerified: 0, recordsTotal: 0, failures: 0, isLatest: false,
  }));
  const result: AttestVerifyResult = { results, progress: { verified: 0, failed: results.length, pending: 0, total: results.length } };
  return json(result);
}

// writeRegenerateRecoveryCodes models POST /admin/auth/recovery-codes/regenerate (regenerateRecoveryCodes):
// the caller's own break-glass set is replaced. Unlike the other auth/passkey/SAML/OIDC ceremonies left to
// the default benignWrite fallback below (which the signed-OUT boot never reaches in a no-login tour), this
// one IS reachable: the demo boots as an already-verified owner, and Security centre's Regenerate button
// (security-centre/access.ts) is reachable from free roam. world.status.recoveryCodesRemaining is refreshed
// to match, so the count the screen re-reads on reload agrees with "a fresh set of 10 was just minted".
function writeRegenerateRecoveryCodes(): RecoveryCodesResult {
  world.status = { ...world.status, recoveryCodesRemaining: DEMO_RECOVERY_CODES.length };
  return { recoveryCodes: [...DEMO_RECOVERY_CODES] };
}

// ---------------------------------------------------------------------------------------------------
// The write handlers. Each parses the request body the console sent (the same JSON.stringify(body) the
// client method posts), mutates the world, and returns the applied/queued/pending wire shape. No write
// persists: the world is module-scoped and a reload re-seeds. The bodies carry names, counts, selectors
// and a coarse reason only (no value, no key); the handlers echo nothing a real engine would not.
// ---------------------------------------------------------------------------------------------------

// readBody (and the currentWritePath route marker its drift note names) lives in demo-world.ts now that
// two write-route modules parse bodies; see its header there for the G337 body-parse drift contract.

// routeWrite dispatches a POST to its handler. The exact-match table mirrors the read table; an unmodelled
// POST degrades to a benign applied/ok result (the default), never an engine error, so a click never fails
// loud on the publicly explorable tour. The restore dual-control writes are async (they await the plan hash
// to mint an approval whose binding matches the screen's), so they return a Promise<Response>; every other
// write returns a synchronous Response.
export function routeWrite(pathname: string, init?: RequestInit): Response | Promise<Response> {
  setCurrentWritePath(pathname);
  // Segment-keyed config-change approve/reject (/admin/config/changes/:id/approve|reject): the approver
  // signs (applies) or declines a queued config change. The demo flips the seeded pending change to the
  // matching terminal state and returns the ConfigChange the inbox renders (maker != checker is honoured:
  // the approver here is the distinct owner/second approver). An unknown id falls through to the seeded one.
  const chgMatch = /^\/admin\/config\/changes\/(.+)\/(approve|reject)$/.exec(pathname);
  if (chgMatch) {
    const id = decodeURIComponent(chgMatch[1] ?? "");
    const action = chgMatch[2];
    const change = world.configChanges.find((c) => c.id === id);
    // G337: an id the world does not hold is answered HONESTLY now that queued writes land in
    // world.configChanges (writeAddDownpipe unshifts the real pending change). The old fallback
    // substituted the seeded change, so approving your freshly queued change silently flipped a
    // DIFFERENT object than the one you acted on; the drift row remains so an unknown id is still
    // enumerable, but the response now says what happened instead of fabricating a success.
    if (change === undefined) {
      noteDemoDrift("unknown-id-fallback", pathname);
      return json({ error: "no queued change with that id" }, { status: 404 });
    }
    // An APPROVED change is "applied": those are the engine's real literals (pending, applied, rejected,
    // superseded). The demo used to seed "approved", which the engine never sends.
    const updated: ConfigChange = { ...change, status: action === "approve" ? "applied" : "rejected", approvedBy: APPROVER_EMAIL, approvedAt: demoIso(0) };
    const idx = world.configChanges.findIndex((c) => c.id === change.id);
    if (idx >= 0) world.configChanges[idx] = updated;
    return json(updated);
  }
  switch (pathname) {
    // The Require-Access lock-out pre-flight. A READ that happens to be a POST: it stores nothing, so it is
    // modelled here rather than mutating the world. The demo org is signed in through Access with an Owner
    // passkey enrolled, so the verdict is SAFE and the tour shows the closing steps. Left to benignWrite it
    // would answer { ok:true }, whose missing safeToDisableToken reads as "not safe" and would teach a
    // prospect the opposite of what the demo org's posture actually is.
    case "/admin/policy/require-access":
      return json({
        tokenFallbackDisabled: false,
        accessConfigured: true,
        enforced: false,
        callerMethod: "access",
        secondFactor: { passkeyOwnerEnrolled: true, accessConfigured: true, recoveryReady: true, secondOwner: false },
        secondFactorPresent: true,
        safeToDisableToken: true,
        lockoutWarning: null,
      });
    case "/admin/downpipes":
      return writeAddDownpipe(init);
    case "/admin/trigger":
      return writeTrigger(init);
    case "/admin/destinations":
      return writeAddDestination(init);
    case "/admin/drill":
      return writeDrill(init);
    case "/admin/restore/verify":
      return writeVerifyRestore(init);
    case "/admin/restore/attest":
      return writeAttestRestore(init);
    // The restore dual-control writes (request -> approve/reject -> apply). Async: they await the plan hash.
    case "/admin/restore/request":
      return writeRestoreRequest(init);
    case "/admin/restore/approve":
      return writeRestoreApprove(init);
    case "/admin/restore/reject":
      return writeRestoreReject(init);
    case "/admin/restore":
      return writeRestore(init);

    // ---- the remaining writes the explorable tour can trigger, returning the SPECIFIC shape each screen's
    // client method parses so the UI updates coherently (never a fabricated alarm; no world mutation beyond
    // what is needed to keep a click consistent within the session, and a reload re-seeds). ----

    // Canary: run the bird (it sings) / patch its config (returns the canary view applied).
    case "/admin/canary/run":
      return json({ ok: true, flying: true });
    case "/admin/canary/config":
      return json({ status: "applied", value: world.canary });
    // Config change-control: a manual snapshot de-dupes against the head (nothing changed) -> created:false.
    case "/admin/config/snapshot":
      return json({ created: false });
    // Setting the attended-verification interval. PERSISTED into the world for the session, like the
    // posture override below, so the control reads back what the visitor chose rather than snapping to
    // the seed. The engine bounds it to 0 or 1..3650 and this mirrors that bound, so the demo cannot
    // show a value the real engine would refuse.
    case "/admin/config/attended-cadence": {
      const days = Number(readBody<{ attendedCadenceDays?: unknown }>(init).attendedCadenceDays);
      if (!Number.isInteger(days) || days < 0 || days > 3650) {
        return json({ error: "attendedCadenceDays must be 0 (no cadence) or between 1 and 3650" }, { status: 400 });
      }
      world.attendedCadenceDays = days;
      return json({ attendedCadenceDays: days });
    }
    // Posture override / withdraw: applied (the gate is off for this in the demo) AND PERSISTED into
    // world.posture for the session (the check folds to the chosen kind, the override rides on it and
    // the score recomputes with the real weighting), so the Security centre reflects the action exactly
    // as the live engine would. A reload re-seeds, like every demo write.
    case "/admin/posture/accept":
      return writePostureOverride(init);
    case "/admin/posture/unaccept":
      return writePostureWithdraw(init);
    // Coverage inventory: the engine stored the submitted ids/labels; echo the per-type counts (no value).
    case "/admin/coverage/inventory":
      return writeCoverageInventory(init);
    // Destination verify: a live probe passed; the delete probe is denied on the WORM bucket (the expected
    // posture). No secret transits.
    case "/admin/destination/verify":
      return json({ ok: true, deleteProbe: "denied", ms: 220, source: "console" });
    // The email / notify / idp connection tests: a clean send / verdict so the test button resolves green.
    case "/admin/email/test":
      return json({ ok: true });
    case "/admin/notify/test": {
      // Mirror the engine: the outcome is also recorded on the history ring flagged test:true, so the
      // History tab demonstrates the durable verification trace.
      const body = readBody<{ channelId?: string }>(init);
      const ch = world.notifyChannels.find((c) => c.id === body.channelId);
      if (ch !== undefined) {
        const seq = Math.max(0, ...world.notifyHistory.map((e) => e.seq)) + 1;
        world.notifyHistory.unshift({
          seq, ts: demoIso(0), event: "backup-success", severity: "info", downpipeId: null,
          channelId: ch.id, channelKind: ch.kind, delivered: true,
          detail: "downpipe test notification (no action required)", test: true,
        });
      }
      return json({ ok: true });
    }
    case "/admin/idp/test-saved": {
      // The saved-connection re-verify probe: found -> the same clean checks as the pre-save test
      // (over the stored config); unknown -> the structured failed check the engine returns.
      const body = readBody<{ connId?: string }>(init);
      const conn = world.idpConnections.find((c) => c.id === body.connId);
      if (conn === undefined) {
        return json({ ok: false, checks: [{ name: "connection exists", status: "fail", detail: `no stored connection with id "${body.connId ?? ""}"` }] });
      }
      return json({ ok: true, checks: [
        { name: "Discovery document reachable", status: "pass", detail: "The issuer's metadata resolved from the stored configuration." },
        { name: "Endpoints consistent", status: "pass", detail: "The authorisation and token endpoints match the stored issuer." },
        { name: "Signing keys published", status: "pass", detail: "The provider's current signing keys are available." },
      ] });
    }
    case "/admin/idp/test":
      return json({ ok: true, checks: [
        { name: "Discovery document reachable", status: "pass", detail: "The issuer's metadata resolved." },
        { name: "Client credentials accepted", status: "pass", detail: "The client id and secret form a valid pair." },
        { name: "Scopes granted", status: "pass", detail: "openid, email and profile are available." },
      ] });
    // The source-discovery writes (set the read-only token / choose accounts): applied, returning the
    // presence-only status. No token is ever stored or echoed.
    case "/admin/sources/discovery-token":
      return writeDiscoveryToken(init);
    case "/admin/sources/discovery-accounts":
      return json({ present: true, setAt: demoEpoch(0), setBy: ORG_OWNER_EMAIL, accountsSeen: [{ id: DEMO_ACCT_ID, name: "Northwind Trading Co" }], selected: [DEMO_ACCT_ID], engineAccountId: DEMO_ACCT_ID });
    // The binding attach/detach write (changeBindings): the engine adds/removes the source binding stanzas
    // on itself with the one-shot deploy token and re-reads its bindings to prove the change landed. The
    // demo applies the same result to the world's bound tier, so a fresh attach shows up on the Sources
    // screen, in the create wizard, and in the derived setup-state fact on the next read. The token is
    // never inspected or stored (the real engine uses it once and discards it; the demo has no use for it).
    case "/admin/sources/attach":
      return writeAttachSources(init);
    // The guided first-run acknowledge (fetchSetupHealed's self-heal, client-keys.ts acknowledgeSetup).
    // The engine clears the first-run marker ONLY when it observes the keys present, so a premature call is
    // an honest ok:false no-op. Mirrored exactly: on the training-start world this refuses until the
    // learner's key install lands, which is what keeps the taught setup gate from dissolving. Left to
    // benignWrite this answered ok:true, and every Overview render on a gated world fired a redundant
    // acknowledge-refetch cycle against a world that had not changed.
    case "/admin/setup/acknowledge":
      return json({ ok: world.setupState.keysReady });
    // The key ceremony install (installKeys): the in-browser ceremony's output lands as the engine's own
    // worker secrets. The demo flips the stored setup facts the world cannot otherwise observe and answers
    // the engine's real result shape. No token or private byte is read, stored or echoed (the demo drops
    // the body's key fields unread, exactly as the engine never stores them).
    case "/admin/keys/install": {
      const body = readBody<{ operationalPublic?: string }>(init);
      const operational = typeof body.operationalPublic === "string" && body.operationalPublic !== "";
      world.setupState = { ...world.setupState, keysReady: true, signerConfigured: true, breakGlassConfigured: true };
      // The engine STATUS follows the install too (the deck's own probes re-read it): see
      // demo-state.ts trainingStartOverrides for why status carries the fresh-account key flags.
      world.status = {
        ...world.status,
        signerConfigured: true,
        breakGlassConfigured: true,
        operationalConfigured: { public: operational, private: operational },
        ready: world.status.destConfigured,
      };
      return json({ ok: true, signerPublic: "demo-signer-public-not-a-real-key", configured: { signer: true, breakGlass: true, operational } });
    }
    // The versioned key-posture acceptance record (acknowledgePosture): the engine recomputes the hash
    // over its own canonical statement text and records posture + version + hash in the audit log. The
    // demo answers the real shape with a demo placeholder hash; nothing is stored beyond the session.
    case "/admin/keys/posture-acknowledgement":
      return json({ ok: true, statementSha384: "demo-sha384-not-a-real-hash" });
    // Add / remove which token-authenticated source types (cf-config / workers / stream / images /
    // artifacts) are available to protect. SET semantics: the full desired list is filtered to the known
    // types and stored on the world, so the discover read + the create wizard reflect it on the next load.
    case "/admin/sources/enable": {
      const body = readBody<{ sources?: unknown[] }>(init);
      const allowed = new Set(["cf-config", "workers", "stream", "images", "artifacts"]);
      const next = [...new Set((Array.isArray(body.sources) ? body.sources : []).filter((x): x is string => typeof x === "string" && allowed.has(x)))];
      world.sourceDiscovery.addedSources = next;
      return json({ present: true, setAt: demoEpoch(0), setBy: ORG_OWNER_EMAIL, accountsSeen: [{ id: "demo-acct-northwind", name: "Northwind Trading Co" }], selected: ["demo-acct-northwind"], engineAccountId: "demo-acct-northwind", enabledSources: next });
    }
    // cf-config rediscover / mode: a clean re-probe / a mode set.
    case "/admin/downpipes/cf-config/rediscover":
      return json({ ok: true, discovery: { at: demoEpoch(0), present: ["dns_records", "page_rules", "workers_routes"], empty: ["page_rules_legacy"], gated: [], unavailable: [] } });
    case "/admin/downpipes/cf-config/mode":
      return json({ ok: true });
    // The safe-apply update writes: the engine is current, so apply/ramp report no-update, settle/rollback
    // report the calm already/no-target outcome. Structured, never a 500.
    case "/admin/update/apply":
      return json({ status: "result", value: { phase: "promote", outcome: "no-update", recommendedVersion: "1.0.0", steps: [] } });
    case "/admin/update/settle":
      return json({ phase: "settle", outcome: "applied", recommendedVersion: "1.0.0", fromVersion: "1.0.0", toVersion: "1.0.0", steps: [] });
    case "/admin/update/rollback":
      return json({ outcome: "already", toVersion: "1.0.0", steps: [] });
    case "/admin/update/ramp":
      return json({ status: "result", value: { outcome: "no-update", recommendedVersion: "1.0.0", steps: [] } });
    // Support: mint a per-scope ingest credential (the ONE place a secret appears, here a demo placeholder),
    // or delete one. The bundle download is handled as a benign no-op (the tour does not model the bytes).
    case "/admin/support/credentials":
      return json({ scope: "diagnostics", clientId: "demo-support-client-id", secret: "demo-support-secret-not-a-real-credential", bearer: "demo-support-client-id.demo-support-secret-not-a-real-credential", expiresAt: demoIso(7 * DAY), note: "This secret is shown once; the engine stores only its SHA-384." });
    // SIEM audit-log push destination: set/replace (mutates world.push for the session so a toggle,
    // replace or clear reads back coherently; a reload re-seeds), delete (clears it back to the
    // unconfigured state), and test (a clean synthetic send). No dual control in the demo (the gate is
    // off), matching the posture/canary writes above. The secret never round-trips: the demo never stores
    // authHeaderValue anywhere, exactly as the engine never returns it.
    case "/admin/push":
      return writeSetPush(init);
    case "/admin/push/delete":
      world.push = { present: false, trail: [] };
      return json({ ok: true });
    case "/admin/push/test":
      return json({ ok: true, httpStatus: 202, ms: 180 });
    // The caller's own recovery-code regenerate: see writeRegenerateRecoveryCodes and
    // DEMO_RECOVERY_CODES above for why this one auth/* write IS modelled unlike its ceremony siblings.
    case "/admin/auth/recovery-codes/regenerate":
      return json(writeRegenerateRecoveryCodes());

    // Attended verification: see writeCreateAttestSession and its siblings above for why these four
    // ARE modelled unlike their ceremony neighbours (the other auth/* writes left to benignWrite below).
    case "/admin/attest/session/create":
      return writeCreateAttestSession(init);
    case "/admin/attest/session/prove":
      return writeProveAttestSession();
    case "/admin/attest/session/capsules":
      return writeAttestCapsules(init);
    case "/admin/attest/session/verify":
      return writeAttestVerify(init);

    default:
      // Every other write (deletes, key ceremonies, session terminations, owner-action approvals, the
      // passkey / SAML / OIDC sign-in ceremonies the no-login demo never triggers since it boots already
      // signed in) degrades to a benign applied/ok result so a click never surfaces an engine error. No
      // world mutation; a reload re-seeds. G337: the pathname rides so the unmodelled write can be NAMED
      // (as a route pattern), not merely counted.
      return benignWrite(pathname);
  }
}

// writeCoverageInventory models POST /admin/coverage/inventory (setCoverageInventory): the engine stored the
// submitted reference ids/labels and echoes the per-type counts (no value is stored or echoed; an inventory
// carries only ids/labels). The demo reads the submitted groups' lengths so the confirm reflects what landed.
// writePostureOverride / writePostureWithdraw model the Security centre override writes. The demo org
// runs four-eyes / dual control ON, so a posture override is a config mutation and DEFERS exactly like a
// downpipe save: HTTP 202 { queued: true, id } queued for a second approver (the override modal already
// pre-warns and its primary reads "Submit for approval"). No world mutation (a deferred change is not
// applied until a second approver signs, which the demo does not model), so the honesty holds; the seeded
// posture already carries one example of every override state so each rendering is visible regardless.
// queuedChange (the ONE deferred-mutation 202 body minter, G301) lives in demo-world.ts now that two
// route modules defer config mutations; see its header there for why the body must be the engine's own.
function writePostureOverride(init?: RequestInit): Response {
  const { checkId, kind } = readBody<{ checkId?: string; kind?: string }>(init);
  const id = typeof checkId === "string" && checkId !== "" ? checkId : "check";
  void kind;
  const body: PendingChangeBody = queuedChange(`chg-posture-${id}-${world.changeSeq++}`);
  return json(body, { status: 202 });
}
function writePostureWithdraw(init?: RequestInit): Response {
  const { checkId } = readBody<{ checkId?: string }>(init);
  const id = typeof checkId === "string" && checkId !== "" ? checkId : "check";
  const body: PendingChangeBody = queuedChange(`chg-posture-withdraw-${id}-${world.changeSeq++}`);
  return json(body, { status: 202 });
}

function writeCoverageInventory(init?: RequestInit): Response {
  const body = readBody<{ kv?: unknown[]; r2?: unknown[]; d1?: unknown[]; secrets?: unknown[] }>(init);
  const len = (v: unknown): number => (Array.isArray(v) ? v.length : 0);
  return json({ stored: true, counts: { kv: len(body.kv), r2: len(body.r2), d1: len(body.d1), secrets: len(body.secrets) } });
}

// writeAddDownpipe lives in demo-routes-write-firstrun.ts with its guided-first-run siblings.

// writeTrigger models POST /admin/trigger (trigger). It mints a NEW in-flight run at the head of that
// downpipe's history ring and marks the downpipe in-flight, then returns { runId, index, prevRunId } the
// runs screen reflects. A missing/unknown id is the engine's honest { skipped } shape (no run is fabricated
// for a downpipe that does not exist). The run is in-flight (no recordCount/bytes yet); a reload re-seeds.
function writeTrigger(init?: RequestInit): Response {
  const { id } = readBody<{ id: string }>(init);
  if (typeof id !== "string" || id === "" || world.historyByDownpipe[id] === undefined) {
    return json({ skipped: "no such downpipe" });
  }
  const ring = world.historyByDownpipe[id];
  const prev = ring[0];
  const prevIndex = prev?.index ?? 0;
  const index = prevIndex + 1;
  const runId = `${id.replace(/^dp-/, "run-")}-${String(index).padStart(4, "0")}`;
  const started: RunHistoryEntry = { runId, index, startedAt: new Date(Date.now()).toISOString(), status: "in-flight" };
  ring.unshift(started);
  // Queue the read-driven settlement (demo-world.ts settleDueRuns): the run stays honestly in-flight for
  // a fixed number of history reads, then settles ok, so Running-then-ok replays identically every time.
  world.settleQueue[runId] = { downpipeId: id, readsRemaining: 2 };
  const dp = world.downpipes.find((d) => d.config.id === id);
  if (dp) {
    dp.inFlight = true;
    dp.lastRunId = runId;
  }
  const result: { runId: string; index: number; prevRunId?: string } = { runId, index };
  if (prev) result.prevRunId = prev.runId;
  return json(result);
}

// writeAddDestination models POST /admin/destinations (addDestination): ADD a new destination (no id) or
// EDIT one (id present). The demo does NOT run the owner-action dual-control gate (a SEPARATE toggle from
// the config gate), so the engine APPLIES it and answers the usual 2xx with the updated list
// (parseJsonOrOwnerAction -> { status: "result" }), which is what makes the add demonstrable in one step.
// A NEW destination is appended to the list; an EDIT replaces the matching one. The verified-at stamp is
// "now" (a fresh live probe passed); WORM/Object-Lock are carried from the submitted policy. Redaction-safe:
// the stored view keeps host/bucket/region/label only, NEVER the submitted accessKeyId/secretAccessKey (the
// engine verifies-before-store and returns the redaction-safe status; the demo mirrors that, dropping creds).
//
// AN IMMUTABILITY POLICY ON AN R2 DESTINATION IS REFUSED HERE, AND WAS ACCEPTED UNTIL. Any
// submitted policy used to be stamped objectLock "enforced" whatever the endpoint, so a learner who set a
// compliance lock on an R2 destination in the training course watched it save and read back as enforced.
// The real engine refuses that save with a 400: R2 over its S3 endpoint answers 501
// NotImplemented to x-amz-object-lock-mode, the probe reads that as a definite cannot-enforce
// (wormCannotBeEnforced, engine/src/admin/router-destinations.ts) and no R2 bucket can be created with
// Object Lock either. Teaching a success the product will not give is worse than teaching nothing: the
// learner leaves believing their R2 archives are immutable.
//
// ONLY R2 IS REFUSED, and the line is drawn where the demo can actually know the answer. R2's refusal is a
// STORE fact, true of every R2 bucket, so it holds with no bucket to probe. For Amazon S3, Google Cloud and
// Azure the answer belongs to the individual bucket or container (created with Object Lock, with
// per-object retention, or with version-level immutability), which the demo has no way to observe, and
// refusing them all would teach a second falsehood in the opposite direction.
function writeAddDestination(init?: RequestInit): Response {
  const body = readBody<{ id?: string; label: string; config: DestinationInput }>(init);
  const cfg = body.config ?? ({} as Partial<DestinationInput>);
  const label = typeof body.label === "string" && body.label !== "" ? body.label : "New destination";
  if (cfg.worm && demoProviderForEndpoint(cfg.endpoint) === "r2") {
    // The engine's own sentence, verbatim, so the demo refuses in the product's words rather than in its
    // own. Nothing is written to the world: a refused save leaves no destination behind, exactly as a
    // refused save does against a real engine.
    return json(
      {
        error:
          "this bucket cannot enforce an immutability policy, so every backup written to it would be refused by the store and nothing would be archived there. Object Lock has to be enabled when a bucket is created and cannot be turned on afterwards, so create a new bucket with Object Lock enabled and point the destination at that, or remove the immutability policy to use this bucket without it.",
      },
      { status: 400 },
    );
  }
  // Minted AFTER the refusal, so a refused save does not consume a change sequence number: the world is
  // untouched by a save the engine would never have applied.
  const id = typeof body.id === "string" && body.id !== "" ? body.id : `dest-${world.changeSeq++}`;
  // Build the redaction-safe stored view from the submitted config. The creds (accessKeyId / secretAccessKey)
  // are deliberately NOT read onto the status: a destination view never carries a secret (no-custody).
  const status: DestinationStatus = {
    present: true,
    id,
    label,
    isDefault: false,
    endpointHost: typeof cfg.endpoint === "string" ? cfg.endpoint.replace(/^https?:\/\//, "") : "s3.amazonaws.com",
    bucket: typeof cfg.bucket === "string" ? cfg.bucket : "bucket",
    region: typeof cfg.region === "string" ? cfg.region : "us-east-1",
    setAt: Date.now(),
    setBy: ORG_OWNER_EMAIL,
    verifiedAt: Date.now(),
    deleteProbe: cfg.worm ? "denied" : "ok",
    ...(cfg.worm ? { worm: cfg.worm, objectLock: "enforced" as const } : { objectLock: "not-enforced" as const }),
    // MIRRORS engine/src/sched/scheduler-do-dest-config.ts, including its precedence. This read
    // `cfg.assumeRole ? "sts": "keys"` until, so a learner who configured a Microsoft Entra
    // service principal in the training replica was told the destination authenticates with a storage
    // account key, and the card showed no Authentication row at all. A teaching surface that contradicts
    // the product teaches the contradiction.
    authMode: cfg.azureEntra ? "entra" : cfg.assumeRole ? "sts" : "keys",
    ...(cfg.assumeRole ? { assumeRoleArn: cfg.assumeRole.roleArn } : {}),
    ...(cfg.azureEntra ? { azureEntra: cfg.azureEntra } : {}),
    addressing: cfg.addressing === "path" ? "path" : "vhost",
    ...(cfg.storageClass ? { storageClass: cfg.storageClass } : {}),
    source: "console",
  };
  const existing = world.destinations.destinations.findIndex((d) => d.id === id);
  if (existing >= 0) world.destinations.destinations[existing] = { ...status, isDefault: world.destinations.destinations[existing]!.isDefault ?? false };
  else world.destinations.destinations.push(status);
  // The FIRST destination becomes the default, as the engine does: a fleet with destinations but no
  // default would leave a fan-out-less downpipe with nowhere to seal (and the training world's settled
  // runs with no destination to stamp).
  if (world.destinations.defaultId === null || world.destinations.defaultId === undefined) {
    world.destinations.defaultId = id;
    const added = world.destinations.destinations.find((d) => d.id === id);
    if (added) added.isDefault = true;
  }
  // The engine STATUS follows the write (the fresh training account starts destConfigured false).
  world.status = {
    ...world.status,
    destConfigured: true,
    // FOUR-WAY, mirroring the engine (demoProviderForEndpoint in demo-world.ts). It read
    // `includes("r2.cloudflarestorage.com") ? "r2": "s3"` until, which reported a learner's own
    // Google Cloud or Azure destination back to them as S3 on the residency panel, the topology map and the
    // downpipe drawer alike.
    destKind: demoProviderForEndpoint(status.endpointHost),
    ready: world.status.signerConfigured && world.status.breakGlassConfigured,
  };
  return json(world.destinations);
}

// writeSetPush models POST /admin/push (setPush): configures, replaces, or enables/disables the push
// destination across all three sinks (http / s3 / syslog-tls). It builds the REDACTION-SAFE stored view from
// the submitted input, mirroring the engine's getSiemPushView: the http auth header value, the s3 access key
// id and the s3 secret access key are ALL deliberately NEVER read onto the view (no-custody: the demo never
// stores or echoes a credential, exactly as the engine never returns one). Only the active sink's
// redaction-safe location rides (http endpoint/header name; s3 endpoint/bucket/region/prefix; syslog
// host/port). setBy/setAt stamp the seeded owner and now; the cursor and trail are untouched by a config
// change.
function writeSetPush(init?: RequestInit): Response {
  const body = readBody<PushDestinationInput>(init);
  const current = world.push;
  const sink: PushSink = body.sink ?? current.sink ?? "http";
  const base: PushDestinationView = {
    present: true,
    sink,
    format: body.format ?? current.format ?? "ndjson",
    enabled: typeof body.enabled === "boolean" ? body.enabled : (current.enabled ?? true),
    setBy: ORG_OWNER_EMAIL,
    setAt: demoIso(0),
    ...(current.lastPushedSeq !== undefined ? { lastPushedSeq: current.lastPushedSeq } : {}),
    ...(current.headSeq !== undefined ? { headSeq: current.headSeq } : {}),
    trail: current.trail,
  };
  if (sink === "s3") {
    const t = body.s3Target;
    const cur = current.s3;
    const prefix = (typeof t?.prefix === "string" && t.prefix.trim() !== "" ? t.prefix.trim() : cur?.prefix) ?? "";
    world.push = {
      ...base,
      s3: {
        endpoint: (typeof t?.endpoint === "string" && t.endpoint.trim() !== "" ? t.endpoint.trim() : cur?.endpoint) ?? "",
        bucket: (typeof t?.bucket === "string" && t.bucket.trim() !== "" ? t.bucket.trim() : cur?.bucket) ?? "",
        region: (typeof t?.region === "string" && t.region.trim() !== "" ? t.region.trim() : cur?.region) ?? "",
        ...(prefix !== "" ? { prefix } : {}),
      },
    };
    return json(world.push);
  }
  if (sink === "syslog-tls") {
    const t = body.syslog;
    const cur = current.syslog;
    world.push = {
      ...base,
      syslog: {
        host: (typeof t?.host === "string" && t.host.trim() !== "" ? t.host.trim() : cur?.host) ?? "",
        port: typeof t?.port === "number" ? t.port : (cur?.port ?? 6514),
      },
    };
    return json(world.push);
  }
  world.push = {
    ...base,
    endpoint: typeof body.endpoint === "string" && body.endpoint !== "" ? body.endpoint : (current.endpoint ?? ""),
    authHeaderName: typeof body.authHeaderName === "string" && body.authHeaderName !== "" ? body.authHeaderName : (current.authHeaderName ?? "Authorization"),
    ...(body.authInUrl === true ? { authInUrl: true } : {}),
  };
  return json(world.push);
}

// writeDrill models POST /admin/drill (drill): the secondary recoverability verb (restore one sample record
// into a verification path). It returns a passing DrillResult and STAMPS the downpipe's "offline
// restorability last proven" record (proof.ts refreshes the proven line on a pass) plus appends dated drill
// evidence, so the assurance trail grows live. No plaintext is returned (counts only); a reload re-seeds.
function writeDrill(init?: RequestInit): Response {
  const { runId } = readBody<{ runId: string }>(init);
  const id = typeof runId === "string" ? runId : "";
  const dp = downpipeForRun(id);
  // G337: the drill PASSES for a run the seeded world does not hold. It reports recordsVerified:1 and
  // sampleRestored:true without having looked at anything, which is a fabricated recoverability proof on the one
  // surface whose whole job is honesty. Recorded, and still answered (the tour must not fail loud at a prospect).
  if (!dp) noteDemoDrift("proof-for-unknown-run", "/admin/drill");
  const result: DrillResult = { ok: true, runId: id, recordsVerified: 1, sampleRestored: true, isLatest: dp ? dp.lastRunId === id : false };
  if (dp) stampProven(dp, id);
  return json(result);
}

// writeVerifyRestore models POST /admin/restore/verify (verifyRestore): the PRIMARY recoverability proof, the
// BLIND restore test. The engine decrypts EVERY in-scope record to a discard sink, hash-checks each against
// the signed recordHash and returns counts + a restoreDigest, NEVER a byte of plaintext. The demo returns a
// clean pass over the run's record count with a deterministic digest, and stamps the proven record (a clean
// pass is the durable recoverability proof). recordsVerified/bytesVerified are the run's own counts.
function writeVerifyRestore(init?: RequestInit): Response {
  const { runId } = readBody<{ runId: string }>(init);
  const id = typeof runId === "string" ? runId : "";
  const run = runById(id);
  const dp = downpipeForRun(id);
  // G337: a CLEAN blind restore test (ok:true, failures:[]) over a run that does not exist. recordsVerified
  // falls to 0 and the pass still reads as a pass.
  if (!run) noteDemoDrift("proof-for-unknown-run", "/admin/restore/verify");
  const result: BlindRestoreTest = {
    ok: true,
    runId: id,
    recordsVerified: run?.recordCount ?? 0,
    bytesVerified: run?.bytes ?? 0,
    failures: [],
    restoreDigest: `sha384:demo-restore-digest-${id}`,
    isLatest: dp ? dp.lastRunId === id : false,
    ...(dp ? { downpipeId: dp.config.id } : {}),
  };
  if (dp) stampProven(dp, id);
  return json(result);
}

// writeAttestRestore models POST /admin/restore/attest (attestRestore): the Tier 0 KEYLESS integrity
// attestation (signature + completeness + anti-rollback, NO decryption key and NO data). It runs even in
// the break-glass-only posture. The demo returns a clean attestation over the run and stamps the proven
// record on the pass. No key and no value transit this shape.
function writeAttestRestore(init?: RequestInit): Response {
  const { runId } = readBody<{ runId: string }>(init);
  const id = typeof runId === "string" ? runId : "";
  const dp = downpipeForRun(id);
  // G337: signatureValid / complete / notRolledBack, all true, for a run the world does not hold.
  if (!dp) noteDemoDrift("proof-for-unknown-run", "/admin/restore/attest");
  const result: KeylessAttestationResult = {
    ok: true,
    runId: id,
    signatureValid: true,
    complete: true,
    notRolledBack: true,
    ...(dp ? { downpipeId: dp.config.id } : {}),
  };
  if (dp) stampProven(dp, id);
  return json(result);
}

// writeRestoreRequest models POST /admin/restore/request (requestRestore): raise a dual-control restore
// approval. It computes the plan hash from the request the SAME way the restore screen does (restorePlanHash,
// the single source of truth), so the minted approval's planHash is byte-identical to the value the confirm
// gate compares against (which is what later arms Apply). The approval is REQUESTED (pending) by a DISTINCT
// identity from the owner (so the owner can approve it; the engine refuses a self-approval). Returns the
// RestoreApproval record. Async (the plan hash is SHA-384).
async function writeRestoreRequest(init?: RequestInit): Promise<Response> {
  const req = readBody<RestoreApprovalRequest>(init);
  const runId = typeof req.runId === "string" ? req.runId : "";
  const planHash = await restorePlanHash({ runId, ...selectorsOf(req) });
  const approval: RestoreApproval = {
    planHash,
    runId,
    isLatest: req.isLatest ?? true,
    plannedWrites: req.plannedWrites ?? 0,
    bytes: req.bytes ?? 0,
    redirectBinding: req.target?.binding ?? null,
    requestedBy: REQUESTER_EMAIL,
    requestedAt: new Date(Date.now()).toISOString(),
    reason: typeof req.reason === "string" ? req.reason : "Recovery rehearsal.",
    status: "requested",
    expiresAt: new Date(Date.now() + 23 * HOUR).toISOString(),
  };
  // Replace any prior request for this exact plan (a re-request re-arms), else append.
  const idx = world.approvals.findIndex((a) => a.planHash === planHash);
  if (idx >= 0) world.approvals[idx] = approval;
  else world.approvals.push(approval);
  return json(approval);
}

// writeRestoreApprove models POST /admin/restore/approve (approveRestore): a DISTINCT approver (the seeded
// second approver, maker != checker) signs the pending request bound to this plan hash. It flips the approval
// to "approved" and records approvedBy as that second approver, who is DISTINCT from BOTH the maker (so
// approvedBy != requestedBy, the engine's real maker != checker invariant) AND the signed-in owner (so the
// confirm screen's pre-flight, which arms Apply only when the approver differs from the LIVE caller, can
// light Apply for the owner driving the apply). Seeding the owner here left Apply permanently gated in
// free-explore (caller == approver). The body carries the planHash directly. Async only to share the table's
// Promise return; no hashing is needed here.
async function writeRestoreApprove(init?: RequestInit): Promise<Response> {
  const { planHash } = readBody<{ planHash: string }>(init);
  const approval = world.approvals.find((a) => a.planHash === planHash);
  if (!approval) return notImplemented("POST", "/admin/restore/approve", "approval-hash-miss");
  approval.status = "approved";
  approval.approvedBy = APPROVER_EMAIL;
  approval.approvedAt = new Date(Date.now()).toISOString();
  return json(approval);
}

// writeRestoreReject models POST /admin/restore/reject (rejectRestore): decline the pending request. It flips
// the approval to "rejected" so the inbox shows the declined state, recording the distinct second approver as
// the actor who declined (not the signed-in owner). Async only for the shared Promise return.
async function writeRestoreReject(init?: RequestInit): Promise<Response> {
  const { planHash } = readBody<{ planHash: string }>(init);
  const approval = world.approvals.find((a) => a.planHash === planHash);
  if (!approval) return notImplemented("POST", "/admin/restore/reject", "approval-hash-miss");
  approval.status = "rejected";
  approval.approvedBy = APPROVER_EMAIL;
  approval.approvedAt = new Date(Date.now()).toISOString();
  return json(approval);
}

// writeRestore models POST /admin/restore (restore): the dry-run-by-default recovery action. With confirm
// omitted/false it returns a dry-run RestorePlan (the read-only preview; flow.ts reads it). With confirm:true
// it is an APPLY over live data, which the engine GATES on a usable dual-control approval bound to this exact
// plan hash with a distinct approver (maker != checker): the demo recomputes the plan hash and, finding an
// "approved" approval, returns the applied RestoreResult receipt; with NO usable approval it returns the
// engine's honest 403 { error: "restore not approved", planHash } (confirm.ts maps it to the inline
// "Awaiting approval" verdict, never a false receipt). On a confirmed apply the approval is consumed (single
// use) and the proven record is stamped. Async (the plan hash is SHA-384). No plaintext transits.
async function writeRestore(init?: RequestInit): Promise<Response> {
  const req = readBody<RestoreRequest>(init);
  const runId = typeof req.runId === "string" ? req.runId : "";
  const run = runById(runId);
  // G337: the restore plan for an unknown run borrows the SEEDED plan's counts below (recordsVerified,
  // bytes), so the tour plans a restore of tens of thousands of records that belong to a different run.
  if (!run) noteDemoDrift("proof-for-unknown-run", "/admin/restore");
  const records = run?.recordCount ?? world.restorePlan.recordsVerified;
  const bytes = run?.bytes ?? world.restorePlan.bytes;
  const dp = downpipeForRun(runId);
  const isLatest = dp ? dp.lastRunId === runId : world.restorePlan.isLatest;

  if (req.confirm !== true) {
    // Dry-run: the read-only plan. It verifies a sample WITHOUT exposing a byte of plaintext (the sample
    // carries names + sizes only). planHash binds the dual-control. Reuse the seeded sample when the run is
    // the seeded payments run; otherwise a coarse single-sample plan keyed to the run.
    const planHash = await restorePlanHash({ runId, ...selectorsOf(req) });
    const seeded = runId === world.restorePlan.runId;
    const isXacctDemo = runId === RESTORE_XACCT_DEMO_RUN_ID;
    if (isXacctDemo) {
      // Auto-arm a dual-control approval for THIS exact freshly-computed plan hash, from a distinct
      // approver, so the visual-baselines pass's single prefilled-run dry-run already has an armed
      // Apply gate to open the cross-account type-to-confirm modal from -- no second fixture has to
      // separately reproduce restorePlanHash's own computation to stay in sync with it. Scoped to this
      // one dedicated run id; the seeded payments-run approval (run-payments-0041, deliberately left
      // "requested") is untouched. Idempotent: a repeat dry-run within the same session (a reload, a
      // re-click of "Build the restore plan") does not accumulate duplicate approvals.
      if (!world.approvals.some((a) => a.runId === RESTORE_XACCT_DEMO_RUN_ID && a.planHash === planHash)) {
        world.approvals.push({
          planHash,
          runId: RESTORE_XACCT_DEMO_RUN_ID,
          isLatest: false,
          plannedWrites: records,
          bytes,
          redirectBinding: null,
          requestedBy: REQUESTER_EMAIL,
          requestedAt: demoIso(-30 * MIN),
          reason: "Visual-baseline fixture: a cross-account restore drill.",
          status: "approved",
          approvedBy: APPROVER_EMAIL,
          expiresAt: demoIso(23 * HOUR),
        });
      }
    }
    const plan: RestorePlan = {
      ok: true,
      runId,
      mode: "dry-run",
      recordsVerified: records,
      isLatest,
      plannedWrites: records,
      bytes,
      sample: seeded ? world.restorePlan.sample : [{ name: `${runId}/sample-0001`, sourceType: "kv", binding: "DEMO", plaintextSize: 256 }],
      skipped: [],
      planHash,
      // crossAccountWarnings (COV.9 visual-baseline fixture): the ONLY thing that makes
      // renderConfirm's flags.isCrossAccount true, which is what the visual baseline exists to render.
      ...(isXacctDemo ? { crossAccountWarnings: [{ leg: "cf-config" as const, originAccount: "acct-northwind-prod", targetAccount: "acct-northwind-dr" }] } : {}),
    };
    return json(plan);
  }

  // Apply: gate on a usable approval (approved + a distinct approver). The demo recomputes the plan hash and
  // finds the approval the same way the engine does (isUsableApproval): an "approved" record bound to this
  // plan whose approver DIFFERS from the requester (maker != checker; the wire shape projects subjects as
  // emails, so the demo mirrors approvedBy != requestedBy). An apply after the seeded/raised request + the
  // second approver's approval succeeds, and an un-approved apply is the honest 403.
  const planHash = await restorePlanHash({ runId, ...selectorsOf(req) });
  const approval = world.approvals.find((a) => a.planHash === planHash && a.status === "approved" && !!a.approvedBy && a.approvedBy !== a.requestedBy);
  if (!approval) {
    return json({ error: "restore not approved", planHash }, { status: 403 });
  }
  // Consume the single-use approval and stamp the proven record (a successful apply proves recoverability).
  approval.status = "consumed";
  if (dp) stampProven(dp, runId);
  // The RECEIPT. An applied restore always carries one from the engine (it is absent only on a dry run),
  // and the receipt screen offers it as a download. Returning none here meant the tour showed an applied
  // restore with no way to take the attestation away, so the one artefact a customer would hand an auditor
  // was the one thing the demo could not demonstrate.
  //
  // It is AUDIT-ANCHORED, not key-signed: the demo has no signer key, and the engine's own shape makes
  // `signature` present only when a signer was reachable. Fabricating a signature here would put a
  // plausible-looking one in front of customers on the tour, which is worse than showing the honest
  // unsigned case, and the receipt's own copy does not claim any tool verifies it.
  const receipt = {
    runId,
    restoredAt: new Date(Date.now()).toISOString(),
    isLatest,
    // Names and hashes only, matching the engine's redaction-safe shape. These are the records the plan
    // already showed, so the receipt attests to what the customer has just seen rather than inventing others.
    records: (runId === world.restorePlan.runId ? world.restorePlan.sample : []).map((s) => ({
      name: s.name,
      sourceType: s.sourceType,
      expectedSha384: demoDigest(s.name),
      verifiedSha384: demoDigest(s.name),
      verified: true,
      via: "streamed-readback" as const,
    })),
    summary: { recordsRestored: records, bytesRestored: bytes, allVerified: true },
    receiptSha384: demoDigest(`receipt:${runId}`),
  };
  const result: RestoreResult = {
    ok: true,
    runId,
    mode: "applied",
    recordsVerified: records,
    recordsRestored: records,
    bytesRestored: bytes,
    isLatest,
    failures: [],
    complete: true,
    receipt,
  };
  return json(result);
}
