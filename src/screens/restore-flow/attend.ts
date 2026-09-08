// Attended verification: the offline-key-only posture's IN-PLATFORM proof path. The
// CLIENT drives the loop. The operator selects their break-glass identity.key (read in this browser with a
// FileReader, NEVER uploaded), the engine issues a live-possession challenge and pins the runs to verify, the
// browser proves it holds the recovery key, then for each run the browser recovers that run's per-archive
// master locally (openCapsule) and hands ONLY that single-run key to its OWN engine for a keyed sample verify
// to a discard sink. No break-glass private and no plaintext ever transits; the run keys are used per request
// and forgotten. This is the honest, no-CLI replacement for the old "rehearse offline with the CLI" dead-end
// that a break-glass-only posture used to land on. House rules: Australian English, no em dashes, no
// rule-of-three, precise claims.

import type { AttestSessionRecord, AttestSessionRun, AttestSessionRunStatus, CreateAttestSessionResult, DownpipeState, EngineClient } from "../../api.ts";
import { isAttestSessionRecord, isCreateAttestSessionResult } from "../../api.ts";
import { b64urlEncode } from "../../bytes.ts";
import { blockError, inlineOutcome, sessionEnded } from "../../components/error-view.ts";
import { field } from "../../components/field.ts";
import { badge } from "../../components/status.ts";
import { toast } from "../../components/toast.ts";
import { h, svgIcon } from "../../lib/dom.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { groupNumber, relativeTime, titleCase } from "../../lib/format.ts";
import { ICON_CHEVRON_RIGHT, ICON_LOCK, ICON_PLAY, ICON_SHIELD_CHECK } from "../../lib/icons.ts";
import { deriveAttestProof, type HybridRecipientPrivate, openCapsule, parseIdentityFile } from "../../lib/keydecap.ts";
import { goSignedOut, navigate } from "../../lib/nav.ts";
import { capabilityPhrase } from "../capability-copy.ts";
import { canCap, canDo, capGateReason, collapsedSection } from "../common.ts";
import { type AttendProgressPanel, BATCH_SIZE, buildProgressPanel, chunk, renderAttendSummary } from "./attend-loop.ts";
import { type ReassemblyCard, renderReassemblyCard, wipeOnDisconnect } from "./reassembly.ts";

// The reminder cadence + toggle are CLIENT-SIDE preferences (there is no engine reminder route): they drive
// only the "due" nudge on the entry card, persisted in localStorage so they survive a reload. Reading/writing
// is wrapped so a privacy-mode browser that throws on localStorage degrades to "off" rather than erroring.
const REMINDERS_KEY = "downpipes.attend.reminders";
const CADENCE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "0", label: "Not stated" },
  { value: "30", label: "Monthly" },
  { value: "91", label: "Quarterly" },
  { value: "182", label: "Every six months" },
  { value: "365", label: "Yearly" },
];

function readLocal(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function writeLocal(key: string, value: string): void {
  try { window.localStorage.setItem(key, value); } catch { /* privacy mode: the preference is best-effort */ }
}
function remindersOn(): boolean {
  return readLocal(REMINDERS_KEY) === "on";
}

// SESSION_RESUME_KEY persists the ACTIVE session id + sample rate (never a key) so a reopened tab can offer
// to resume from the engine's status, re-selecting the identity.key. It carries no secret.
const SESSION_RESUME_KEY = "downpipes.attend.session";
function persistResume(sessionId: string, sampleRate: number): void {
  writeLocal(SESSION_RESUME_KEY, JSON.stringify({ sessionId, sampleRate }));
}
function readResume(): { sessionId: string; sampleRate: number } | null {
  const raw = readLocal(SESSION_RESUME_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { sessionId?: unknown; sampleRate?: unknown };
    if (typeof v.sessionId === "string" && v.sessionId !== "") return { sessionId: v.sessionId, sampleRate: typeof v.sampleRate === "number" ? v.sampleRate : 100 };
  } catch { /* malformed: no resume */ }
  return null;
}
function clearResume(): void {
  try { window.localStorage.removeItem(SESSION_RESUME_KEY); } catch { /* best-effort */ }
}

// readIdentityFile reads a selected identity.key in the browser (FileReader.readAsText) and parses it to the
// hybrid private parts. It NEVER uploads: the bytes are read locally and the parsed identity is held only in
// the caller's local variable for the session. A file that is not a valid identity.key rejects with a clear
// reason. Exported so the in-console break-glass restore panel (break-glass.ts) reuses the exact
// same local-only read + parse for its identity.key key-supply path, rather than re-implementing it.
export function readIdentityFile(file: File): Promise<HybridRecipientPrivate> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        resolve(parseIdentityFile(typeof reader.result === "string" ? reader.result : ""));
      } catch (e) {
        reject(e instanceof Error ? e : new Error("that file is not a valid identity.key"));
      }
    };
    reader.onerror = () => reject(new Error("could not read that file"));
    reader.readAsText(file);
  });
}

// keyHandlingNote is the standing honesty block, stated the same way everywhere the runner shows it: the key
// is read here and never uploaded; only single-archive run keys reach the operator's OWN engine, held in
// memory for the run and forgotten. It never says the key or the run keys are sent to us.
function keyHandlingNote(): HTMLElement {
  return h(
    "p",
    { class: "field__hint measure", style: "display:flex;gap:var(--space-2);align-items:flex-start" },
    h("span", { style: "flex:none;margin-top:1px;color:var(--trust)" }, svgIcon(ICON_LOCK, { size: 14 })),
    h("span",
      "Your break-glass key is read here in your browser and never uploaded. To verify a run, only that run's single-archive key is recovered here and sent to your own engine, held in memory for the run, then forgotten. We never receive your break-glass key or the recovered run keys. ",
      // The honesty ceiling, stated rather than implied. This page overwrites the key bytes it holds when
      // the session ends or you navigate away, but the file text a FileReader produced is an immutable JS
      // string that cannot be overwritten, and copies the browser made while reading the file are outside
      // this page's control. Promising "no trace" would be promising more than any surface here delivers.
      h("strong", "When the session finishes, or you leave this page, the key bytes held here are overwritten and dropped."),
      " Copies your browser made while reading the file cannot be overwritten, and are left for it to reclaim."),
  );
}

// renderAttendRunner is the /restore/attend screen: the full attended-verification runner. It gates on
// drill.run (the capability the engine enforces on the attest-session endpoints; the engine is the control
// and this mirrors it as UX), reads the identity.key locally, lets the operator choose scope + a sample
// percentage, and drives the create -> prove -> verify loop with a live progress panel, an abort control
// and a resume path.
export function renderAttendRunner(engine: EngineClient): HTMLElement {
  const root = h("div", { class: "stack", style: "display:grid;gap:var(--space-4);max-width:52rem" });
  root.appendChild(h("h2", { style: "margin:0;font-size:var(--text-lg)" }, "Attended verification"));
  root.appendChild(
    h("p", { class: "field__hint measure", style: "margin:0" }, "Your engine already checks every run as it seals it, and proves its write-and-restore path hourly against its own test data. What it cannot do without you is reopen a run it sealed earlier. That is what this is for: supply your break-glass key here and the engine verifies a sample of each past run against the key you recover in your browser. Nothing is written and no record is returned."),
  );
  root.appendChild(keyHandlingNote());

  // Attended verification drives the attest-session endpoints (POST /admin/attest/session/create, /prove,
  // /capsules, /verify), which the engine gates on drill.run (gate(caller, "drill.run"), held by Operator,
  // Restore operator, Approver and Owner). Gating by that capability, not the operator role rank, matters because a restore-operator holds drill.run (a recovery rehearsal is part of the recovery role) yet
  // sits off the rank ladder, so the old canDo("operator") rank check hid this in-platform recovery proof
  // from the recovery-only role. A caller without drill.run (a Viewer, an Access-admin) still gets the note.
  if (!canCap("drill.run")) {
    root.appendChild(inlineOutcome({ heading: `${titleCase(capabilityPhrase("drill.run"))} required`, reason: capGateReason("drill.run"), reassurance: `Attended verification recovers keys and runs a keyed verify, so it needs ${capabilityPhrase("drill.run")}. It never writes data and never reveals a record.` }));
    return root;
  }

  // Session-scoped state. The parsed identity is held ONLY here; the session is the engine's pinned-run
  // record. aborted guards the loop against a late tick.
  let identity: HybridRecipientPrivate | null = null;
  let session: CreateAttestSessionResult | null = null;
  let aborted = false;
  // The setup form's reassembly card, when one is mounted. Held so the unmount teardown can wipe its buffers.
  let setupCard: ReassemblyCard | null = null;

  // wipeIdentity ZEROES the key bytes before dropping the reference. Setting `identity = null` alone, which
  // is what this screen used to do at every one of these points, drops a reference and leaves the 96 bytes
  // in the heap for the garbage collector to reclaim whenever it likes. This is the longest-lived key holder
  // in the product (an attended session runs for as long as the estate takes), so it is the one place that
  // most needs the wipe, and it was the only restore surface without one: /restore/break-glass and
  // /restore/recover-key both already do this.
  //
  // Best-effort, and the copy must not promise more: both fields are views over the same 96-byte decode, so
  // this wipes it whole, but the identity.key TEXT they were parsed from is an immutable JS string that
  // cannot be overwritten (reassembly.ts and break-glass.ts state the same caveat).
  const wipeIdentity = (): void => {
    if (identity) {
      identity.x25519Scalar.fill(0);
      identity.mlkemSeed.fill(0);
    }
    identity = null;
  };

  const setupHost = h("div");
  const runHost = h("div");
  root.appendChild(setupHost);
  // THE CEREMONY, named before the button rather than discovered after it. Opening an attested verification
  // session pins runs and issues a live-possession challenge, so the engine demands a fresh identity check
  // on Start. It is stated here, between the setup form and the runner, because the operator has their
  // identity.key open at that moment and a second unexplained credential sheet reads as the key failing.
  root.appendChild(
    h("p", { class: "field__hint measure" }, "You may be asked to confirm with your own passkey when you start. That is your sign-in passkey, not your identity.key. If you dismiss that prompt, or it fails, no session is opened and you can start again from this form."),
  );
  root.appendChild(runHost);

  // The setup form: the identity.key picker, the scope + sample fields, and Start. Rebuilt on reset.
  const paintSetup = (): void => {
    aborted = false;
    wipeIdentity();
    session = null;
    runHost.replaceChildren();
    setupCard?.teardown();
    setupCard = null;
    setupHost.replaceChildren(renderSetup(engine, {
      onStart: (id, scope, sampleRate) => { identity = id; void start(scope, sampleRate); },
      onCard: (c) => { setupCard = c; },
    }));
    // Offer to resume an in-progress session (a reopened tab) above the fresh form.
    const resume = readResume();
    if (resume) setupHost.insertBefore(renderResumeBanner(resume, (id) => { identity = id; void resumeSession(resume.sessionId); }), setupHost.firstChild);
  };

  // start creates the session, shows the estimate, proves live possession, then drives the loop.
  const start = async (scope: string[] | undefined, sampleRate: number): Promise<void> => {
    if (!identity) return;
    runHost.replaceChildren(runningNote("Starting attended verification. Pinning your runs and issuing a live-possession challenge."));
    try {
      session = await engine.createAttestSession({ ...(scope && scope.length > 0 ? { scope } : {}), sampleRate });
    } catch (err) {
      if (isUnauthorised(err)) {
        // PAINT FIRST, THEN LEAVE: the runner reads "Starting attended verification" until this replaces it.
        runHost.replaceChildren(sessionEnded(() => void start(scope, sampleRate)));
        return void goSignedOut();
      }
      runHost.replaceChildren(blockError(err, () => void start(scope, sampleRate), { origin: location.origin }));
      return;
    }
    // session is typed as CreateAttestSessionResult, but that is a cast over an unvalidated JSON
    // boundary, not a guarantee -- a route the engine has not modelled (or a stub standing in for one, in
    // a test) answers a generic {ok:true,...} with no `runs` field, and `session.runs.length` below then
    // threw on ANY caller, not only the demo world's fallback. Checked here too (client-attest.ts's
    // createAttestSession already throws on the same malformed shape) so this screen degrades honestly
    // regardless of where `session` came from, the same reason recovery-codes-panel.ts does not
    // trust its caller either.
    if (!isCreateAttestSessionResult(session)) {
      runHost.replaceChildren(inlineOutcome({
        heading: "Could not start attended verification",
        reason: "The response did not include the data attended verification needs.",
        reassurance: "Try again, or contact support if this keeps happening.",
      }));
      clearResume();
      return;
    }
    persistResume(session.sessionId, session.sampleRate);
    if (session.runs.length === 0) {
      runHost.replaceChildren(inlineOutcome({ heading: "Nothing to verify yet", reason: "No downpipe in scope has a completed run to verify.", reassurance: "Run a backup first, then return here to prove it restorable." }));
      clearResume();
      return;
    }
    setupHost.replaceChildren();
    await proveAndLoop(session.runs);
  };

  // proveAndLoop answers the live-possession challenge then runs the verify loop over the given runs.
  const proveAndLoop = async (runs: AttestSessionRun[]): Promise<void> => {
    if (!identity || !session) return;
    const panel = buildProgressPanel(runs);
    runHost.replaceChildren(estimateLine(session), abortControl(), panel.el);
    try {
      const proof = await deriveAttestProof(identity, session.challenge.ciphertextB64, session.challenge.nonceB64);
      await engine.proveAttestSession({ sessionId: session.sessionId, proofB64: b64urlEncode(proof) });
    } catch (err) {
      if (isUnauthorised(err)) return void goSignedOut();
      runHost.replaceChildren(blockError(err, () => void proveAndLoop(runs), { origin: location.origin }));
      return;
    }
    await loop(runs.map((r) => r.runId), panel);
  };

  // loop drives the batched verify: for each batch it recovers each run's master IN THE BROWSER and hands
  // only the single-run key to the engine's verify. A run whose key cannot be recovered locally is marked
  // failed without ever sending anything. It is resumable: on a transport fault it offers Retry from the
  // still-pending runs (the identity is still in memory).
  const loop = async (pendingIds: string[], panel: AttendProgressPanel): Promise<void> => {
    if (!identity || !session) return;
    let verified = 0;
    let failed = 0;
    const total = pendingIds.length;
    const still = [...pendingIds];
    const resolve = (id: string, ok: boolean): void => {
      still.splice(still.indexOf(id), 1);
      if (ok) verified++; else failed++;
      panel.setTally({ verified, failed, pending: total - verified - failed, total });
    };
    for (const batch of chunk(pendingIds, BATCH_SIZE)) {
      if (aborted) return;
      for (const id of batch) panel.setPhase(id, "verifying");
      let capsuleBatch: Array<{ runId: string; masterB64: string }>;
      try {
        const { capsules } = await engine.attestCapsules({ sessionId: session.sessionId, runIds: batch });
        const byId = new Map(capsules.map((c) => [c.runId, c]));
        capsuleBatch = [];
        for (const id of batch) {
          const cap = byId.get(id);
          if (!cap) { panel.setPhase(id, "failed", { reason: "the engine returned no capsule for this run" }); resolve(id, false); continue; }
          try {
            const master = await openCapsule(cap.masterCapsule, identity, cap.keyCommitment);
            capsuleBatch.push({ runId: id, masterB64: b64urlEncode(master) });
            // Zero the recovered per-run master in place, exactly as the break-glass panel's wipeMaster
            // does. Without this a session over N runs left N live per-run masters in this tab's memory
            // until it was closed, on the flow whose whole claim is that key material is short-lived.
            //
            // The base64 the engine is sent CANNOT be wiped: JavaScript strings are immutable, so that copy
            // lives until it is collected. Stating the limit rather than implying the buffer wipe covers
            // both: what this removes is the long-lived typed array, which is the part this function controls.
            master.fill(0);
          } catch {
            panel.setPhase(id, "failed", { reason: "could not recover this run's key with the selected identity.key" });
            resolve(id, false);
          }
        }
        if (capsuleBatch.length > 0) {
          const { results } = await engine.attestVerify({ sessionId: session.sessionId, batch: capsuleBatch });
          for (const r of results) {
            panel.setPhase(r.runId, r.ok ? "verified" : "failed", { recordsVerified: r.recordsVerified, recordsTotal: r.recordsTotal, failures: r.failures, ...(r.ok ? {} : { reason: "some sampled records did not verify" }) });
            resolve(r.runId, r.ok);
          }
        }
      } catch (err) {
        if (isUnauthorised(err)) return void goSignedOut();
        // Leave the resolved runs in place; offer to continue from the still-pending set.
        runHost.appendChild(h("div", { style: "margin-top:var(--space-3)" }, blockError(err, () => void loop(still, panel), { origin: location.origin })));
        return;
      }
    }
    finish({ verified, failed, total });
  };

  // finish paints the completion summary, drops the identity from memory and clears the resume marker.
  const finish = (progress: { verified: number; failed: number; total: number }): void => {
    wipeIdentity();
    clearResume();
    const rate = session?.sampleRate ?? 100;
    runHost.replaceChildren(renderAttendSummary({ ...progress, pending: 0 }, rate), h("div", { style: "margin-top:var(--space-3)" }, h("button", { "data-dp": "restore-flow.button.paint-setup#1", class: "btn btn--ghost btn--sm", type: "button", on: { click: paintSetup } }, "Run another attended verification")));
    toast({ message: progress.failed === 0 ? "Attended verification complete." : "Attended verification finished with failures to investigate." });
  };

  // abortControl is the operator's stop button: it ends the session server-side and resets to setup.
  const abortControl = (): HTMLElement => {
    const btn = h("button", { "data-dp": "restore-flow.button.paint-setup#2", class: "btn btn--ghost btn--sm", type: "button" }, "Abort") as HTMLButtonElement;
    btn.addEventListener("click", async () => {
      aborted = true;
      btn.disabled = true;
      const id = session?.sessionId;
      wipeIdentity();
      clearResume();
      if (id) await engine.abortAttestSession(id).catch(() => { /* best-effort: the session lapses regardless */ });
      paintSetup();
    });
    return h("div", { style: "display:flex;justify-content:flex-end" }, btn);
  };

  // resumeSession continues an in-progress session from the engine's status: it reads which runs are still
  // pending, re-proves if the challenge is not already answered, and runs the loop over the pending runs.
  const resumeSession = async (sessionId: string): Promise<void> => {
    if (!identity) return;
    setupHost.replaceChildren();
    runHost.replaceChildren(runningNote("Resuming your attended-verification session."));
    let record: AttestSessionRecord;
    try {
      const status = (await engine.attestStatus(sessionId)).session;
      // The same unguarded-response shape as start()'s session.runs.length, one hop further out. A
      // route the engine has not modelled degrades to a 200 with no `session` field at all, so `status`
      // reads as `undefined` here, and `record.runs` below threw on it directly (there is no field to be
      // missing; the whole record is). Folded into the existing catch below (rather than a new branch) so
      // a malformed 200 and a genuine fetch failure both land on the same honest "could not resume" outcome.
      if (!isAttestSessionRecord(status)) throw new Error("resume attended verification: the response did not include the session");
      record = status;
    } catch (err) {
      if (isUnauthorised(err)) {
        // PAINT FIRST, THEN LEAVE: the runner reads "Resuming your attended-verification session" until this
        // replaces it. The resume marker is deliberately KEPT: the session is still the engine's, and a
        // re-auth should be able to pick it up rather than being told to start again.
        runHost.replaceChildren(sessionEnded(() => void resumeSession(sessionId)));
        return void goSignedOut();
      }
      clearResume();
      runHost.replaceChildren(inlineOutcome({ heading: "Could not resume", reason: "This session could not be read back; it may have lapsed.", reassurance: "Start a fresh attended verification below." }), h("div", { style: "margin-top:var(--space-3)" }, h("button", { "data-dp": "restore-flow.button.paint-setup#3", class: "btn btn--secondary btn--sm", type: "button", on: { click: paintSetup } }, "Start a new session")));
      return;
    }
    const pending = (record.runs ?? []).filter((r) => r.state === "pending");
    // A skipped run carries NO pass/fail verdict, so it must never be folded into "already verified": that
    // claim would be false for the one run that was never checked at all. It is also excluded from `pending`
    // (correctly -- there is nothing left to verify on it), so without naming it separately here it would
    // simply vanish: not offered for re-verification and not shown as resolved either.
    const skipped = (record.runs ?? []).filter((r) => r.state === "skipped");
    if (record.status === "complete" || (record.runs && pending.length === 0)) {
      clearResume();
      const heading = skipped.length > 0 ? "Already resolved" : "Already complete";
      const reason = skipped.length > 0
        ? `Every run in this session has been resolved; ${skipped.length} of ${(record.runs ?? []).length} ${skipped.length === 1 ? "was" : "were"} skipped rather than verified.`
        : "Every run in this session is already verified.";
      runHost.replaceChildren(inlineOutcome({ heading, reason, reassurance: "Start a fresh attended verification to prove your latest runs." }), h("div", { style: "margin-top:var(--space-3)" }, h("button", { "data-dp": "restore-flow.button.paint-setup#4", class: "btn btn--secondary btn--sm", type: "button", on: { click: paintSetup } }, "Start a new session")));
      return;
    }
    // Rebuild the pinned-run shape from the status (names/counts are optional; fall back to the run id).
    // The panel shows the PENDING runs (what the loop below will actually verify) plus any SKIPPED runs, so
    // a skipped run is visibly accounted for rather than silently dropped; only the pending run ids are
    // handed to the loop.
    const toRunShape = (r: AttestSessionRunStatus): AttestSessionRun => ({ downpipeId: r.downpipeId ?? "", runId: r.runId, name: r.name ?? r.runId, recordCount: r.recordCount ?? 0 });
    const runs: AttestSessionRun[] = pending.map(toRunShape);
    const panelRuns: AttestSessionRun[] = [...runs, ...skipped.map(toRunShape)];
    // Reuse the challenge-less path: a resumed session is already proven, so build a session stub and loop.
    session = { sessionId, challenge: { ciphertextB64: "", nonceB64: "" }, runs, sampleRate: record.sampleRate ?? 100, estimate: { runs: runs.length, records: 0 } };
    const panel = buildProgressPanel(panelRuns);
    for (const r of skipped) panel.setPhase(r.runId, "skipped");
    runHost.replaceChildren(estimateLine(session), abortControl(), panel.el);
    // If the engine has NOT recorded the challenge as answered, re-prove before looping.
    if (record.proven === false && identity) {
      runHost.replaceChildren(inlineOutcome({ heading: "This session needs re-proving", reason: "The live-possession challenge for this session was not completed, and it cannot be re-issued here.", reassurance: "Start a fresh attended verification below." }), h("div", { style: "margin-top:var(--space-3)" }, h("button", { "data-dp": "restore-flow.button.paint-setup#5", class: "btn btn--secondary btn--sm", type: "button", on: { click: paintSetup } }, "Start a new session")));
      clearResume();
      return;
    }
    await loop(runs.map((r) => r.runId), panel);
  };

  paintSetup();

  // The client-side reminder settings, folded away beneath the runner (calm density).
  root.appendChild(collapsedSection("Reminders and cadence", renderSettings(engine)));

  // Best-effort wipe on navigation away (root leaves the DOM). Without this, leaving mid-session left the
  // key live in this closure AND left the batch loop running against the engine, which is the state a
  // customer reaches by simply clicking another nav item. Mirrors the /restore/recover-key and canary
  // MutationObserver-on-disconnect pattern; best-effort, since a hard tab close cannot run JS to wipe. The
  // everConnected guard stops a DOM mutation BEFORE this screen mounts firing a premature teardown.
  let everConnected = false;
  const observer = new MutationObserver(() => {
    if (root.isConnected) { everConnected = true; return; }
    if (everConnected) {
      aborted = true; // stop the batch loop: a late tick must not keep calling the engine for a screen that is gone
      wipeIdentity();
      setupCard?.teardown();
      setupCard = null;
      observer.disconnect();
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  return root;
}

// renderSetup builds the setup form: the identity.key picker, the scope select (+ optional downpipe
// checklist), the sample-percentage field and Start. onStart is called with the parsed identity, the chosen
// scope (undefined = all downpipes with a completed run) and the sample rate.
function renderSetup(engine: EngineClient, opts: { onStart: (identity: HybridRecipientPrivate, scope: string[] | undefined, sampleRate: number) => void; onCard?: (card: ReassemblyCard) => void }): HTMLElement {
  const card = h("section", { class: "card", style: "display:grid;gap:var(--space-4)" });
  card.appendChild(h("h3", { class: "card__title" }, "Start a verification"));

  // 1) The identity.key picker (read locally, never uploaded).
  let identity: HybridRecipientPrivate | null = null;
  // The setup form parses its own copy and holds it until Start hands it to the runner. Re-selecting a file,
  // or a failed parse, must zero the superseded bytes rather than just reassigning over them.
  const wipeSetupIdentity = (): void => {
    if (identity) {
      identity.x25519Scalar.fill(0);
      identity.mlkemSeed.fill(0);
    }
    identity = null;
  };
  const keyStatus = h("p", { class: "field__hint", style: "margin:0" }, "No key selected yet.");
  const fileInput = h("input", { type: "file", accept: ".key,text/plain", id: "attend-identity", "aria-label": "Select your identity.key file" }) as HTMLInputElement;
  const keyErr = h("p", { class: "field__error", role: "alert", hidden: true });
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    keyErr.hidden = true;
    void readIdentityFile(file)
      .then((id) => { wipeSetupIdentity(); identity = id; keyStatus.replaceChildren(badge("ok", "Key read in this browser", { dot: true }), document.createTextNode(" It was not uploaded.")); startBtn.disabled = false; })
      .catch((e: unknown) => { wipeSetupIdentity(); startBtn.disabled = true; keyErr.textContent = e instanceof Error ? `${e.message}. No key left this device.` : "That file could not be read."; keyErr.hidden = false; keyStatus.textContent = "No key selected yet."; });
  });
  // What this asks of the operator, before they start rather than when they discover it. The session holds
  // the key for its whole length by necessity (it opens one archive key per run), and a reopened tab has to
  // be given the key again. For a split key that means re-convening a quorum, which is a room full of people,
  // so it must not be a surprise halfway through a large estate.
  card.appendChild(
    h("p", { class: "field__hint measure", style: "margin-top:var(--space-2)" },
      "This session needs your key for its whole length, not just to start it. If you close this page the session stops, and resuming asks for your key again. If you hold a split key, that means gathering a quorum of shares a second time, so run this with your custodians available and keep the page open."),
  );
  card.appendChild(h("div", { class: "field" }, h("label", { class: "field__label", for: "attend-identity" }, "Your break-glass key (identity.key)"), fileInput, h("p", { class: "field__hint", style: "margin-top:var(--space-1)" }, "Select the identity.key you saved offline. It is read here and never uploaded."), keyDocLink(), keyStatus, keyErr));

  // 1b) Or reassemble a split (M-of-N) key. Some organisations split the break-glass key for internal
  // separation of duties rather than for any cryptographic gain, and until now this screen accepted only a
  // single identity.key file, so those customers could not run an attended verification AT ALL: the one
  // routine thing that proves their offline key opens a real archive. The shared reassembly card is the same
  // component /restore/break-glass and /restore/recover-key already mount, in no-download mode, so the
  // recovered key feeds this session rather than becoming a file on disk.
  //
  // onInvalidated matters as much as onRecovered: if the loaded shares or ciphertext change after a
  // reconstruct, any key derived from the old set is stale and must not start a session.
  const reassembly = renderReassemblyCard({
    showDownload: false,
    onRecovered: (recovered) => {
      // The card hands back the PARSED key, so there is no text to re-parse and no second unwipeable copy
      // of the customer's break-glass key in this closure.
      wipeSetupIdentity();
      if (recovered === null) {
        keyErr.hidden = true;
        startBtn.disabled = true;
        keyStatus.textContent = "The reassembled file is not a standard identity.key, so it cannot open a run.";
        return;
      }
      identity = recovered;
      keyErr.hidden = true;
      keyStatus.replaceChildren(badge("ok", "Split key reassembled in this browser", { dot: true }), document.createTextNode(" Nothing was uploaded."));
      startBtn.disabled = false;
    },
    onInvalidated: () => {
      // The shares or the ciphertext changed, so anything reconstructed from the old set is stale.
      wipeSetupIdentity();
      startBtn.disabled = true;
      keyStatus.textContent = "No key selected yet.";
    },
  });
  card.appendChild(collapsedSection("Reassemble a split (M-of-N) key instead", reassembly.el));
  // Hand the card up so the runner's unmount teardown can wipe the share bodies, the envelope ciphertext and
  // the recovered bytes it still holds. Without this the split-key route would leak exactly what the
  // single-file route no longer does.
  opts.onCard?.(reassembly);

  // 2) Scope: all downpipes with a completed run (default) or a chosen subset.
  const checklistHost = h("div");
  const scopeField = field({ id: "attend-scope", label: "Scope", kind: "select", value: "all", options: [{ value: "all", label: "All downpipes with a completed run" }, { value: "choose", label: "Choose specific downpipes" }], hint: "Verify every downpipe that has a completed run, or pick a subset.", doc: { href: "https://docs.downpipes.io/recovery/attended-verification", anchor: "running-a-session" }, onInput: (v) => { if (v === "choose") void paintChecklist(); else checklistHost.replaceChildren(); } });
  const selectedIds = new Set<string>();
  const paintChecklist = async (): Promise<void> => {
    checklistHost.replaceChildren(h("p", { class: "field__hint" }, "Loading your downpipes."));
    try {
      const list = await engine.listDownpipes();
      const withRun = list.filter((d) => d.lastRunId !== null && d.lastRunId !== "");
      if (withRun.length === 0) { checklistHost.replaceChildren(h("p", { class: "field__hint" }, "No downpipe has a completed run yet.")); return; }
      const ul = h("ul", { class: "attend-scope-list", role: "list", style: "list-style:none;padding:0;margin:0;display:grid;gap:var(--space-1)" });
      for (const d of withRun) {
        const cb = h("input", { "data-dp": "restore-flow.checkbox.paint-checklist", type: "checkbox", "aria-label": `Include ${d.config.name}` }) as HTMLInputElement;
        cb.addEventListener("change", () => { if (cb.checked) selectedIds.add(d.config.id); else selectedIds.delete(d.config.id); });
        ul.appendChild(h("li", h("label", { style: "display:flex;gap:var(--space-2);align-items:center" }, cb, h("span", d.config.name))));
      }
      checklistHost.replaceChildren(ul);
    } catch (err) {
      if (isUnauthorised(err)) {
        // PAINT FIRST, THEN LEAVE: the checklist reads "Loading your downpipes." until this replaces it.
        checklistHost.replaceChildren(sessionEnded(() => void paintChecklist()));
        return void goSignedOut();
      }
      checklistHost.replaceChildren(h("p", { class: "field__hint" }, "Could not load your downpipes; the whole-fleet scope still works."));
    }
  };
  card.appendChild(scopeField.el);
  card.appendChild(checklistHost);

  // 3) The sample percentage (1..100; only 100% records a full proof).
  const sampleField = field({ id: "attend-sample", label: "Record sample (%)", type: "number", value: "100", placeholder: "100", hint: "The percentage of each run's records to decrypt and verify. Only 100% records a full recoverability proof; a lower sample proves a random subset and reads as a partial proof.", doc: { href: "https://docs.downpipes.io/recovery/attended-verification", anchor: "running-a-session" }, validate: sampleRateError });
  card.appendChild(sampleField.el);

  const startBtn = h("button", { "data-dp": "restore-flow.button.start", class: "btn btn--primary", type: "button", disabled: true }, svgIcon(ICON_PLAY, { size: 14 }), "Start attended verification") as HTMLButtonElement;
  startBtn.addEventListener("click", () => {
    if (!identity) return;
    if (!sampleField.validate()) return;
    const scope = scopeField.value() === "choose" ? [...selectedIds] : undefined;
    if (scopeField.value() === "choose" && (!scope || scope.length === 0)) { scopeField.setError("Choose at least one downpipe, or switch back to all downpipes."); return; }
    opts.onStart(identity, scope, Number(sampleField.value()));
  });
  card.appendChild(h("div", { style: "display:flex;gap:var(--space-2)" }, startBtn));
  return card;
}

// sampleRateError validates the sample percentage inline: an integer from 1 to 100, mirroring the engine's
// clamp domain (engine/src/attest/verify.ts sampleCount clamps 1..100). Returns an error message or null.
function sampleRateError(value: string): string | null {
  const n = Number(value);
  if (value.trim() === "" || !Number.isFinite(n)) return "Enter a whole number from 1 to 100.";
  if (!Number.isInteger(n)) return "The sample must be a whole number of per cent.";
  if (n < 1 || n > 100) return "The sample must be between 1 and 100 per cent.";
  return null;
}

// renderSettings builds the attended-verification cadence and the local reminder toggle.
//
// The two are deliberately stored in DIFFERENT places, and that split is the point.
//
// THE CADENCE IS ESTATE STATE. It is the interval the organisation states it will prove recoverability
// within, so it belongs to the estate, not to whichever browser happened to set it. It used to live in
// localStorage, which meant the estate knew nothing about its own proof rhythm: the nudge did not follow the
// operator to another machine, private browsing dropped it, and clearing site data reset it. It now reads and
// writes the engine (GET/POST /admin/config/attended-cadence), rides the signed control-plane export, and
// feeds the attended-verification-cadence posture check.
//
// THE TOGGLE STAYS LOCAL, because "show me a nudge on this screen" genuinely is a per-browser preference and
// has no bearing on what the estate has committed to.
//
// Writing the cadence is OWNER-ONLY server-side, so a non-owner sees the current interval and cannot change
// it. The select is disabled for them with the reason stated, rather than letting them pick a value and
// meeting a 403 after the fact.
function renderSettings(engine: EngineClient): HTMLElement {
  const wrap = h("div", { style: "display:grid;gap:var(--space-3)" });
  wrap.appendChild(
    h(
      "p",
      { class: "field__hint measure", style: "margin:0" },
      "How often your organisation will prove its backups restorable at an attended verification. This is estate-wide: it is stored in your engine, travels with your signed configuration export, and appears in your compliance posture. The reminder toggle below is separate and local to this browser.",
    ),
  );

  const isOwner = canDo("owner");
  const cadence = field({
    id: "attend-cadence",
    label: "Prove recoverability every",
    kind: "select",
    value: "0",
    options: CADENCE_OPTIONS,
    hint: isOwner
      ? "Stored in your engine. Choosing 'Not stated' records no rhythm rather than a zero-day one."
      : "Stored in your engine. Only an Owner can change it.",
    doc: { href: "https://docs.downpipes.io/recovery/attended-verification", anchor: "scheduling-and-reminders" },
  });
  const cadenceInput = cadence.el.querySelector("select") as HTMLSelectElement | null;
  // Disabled-with-reason, not the native `disabled` attribute: a non-owner still tabs onto the
  // control and hears why it is refused ("Only an Owner can change it.", already the field's own hint
  // text above), rather than the select silently vanishing from the tab order. cadence is
  // field()-built, so the shared Field.setDisabled carries this directly.
  if (!isOwner) cadence.setDisabled("Only an Owner can change it.");
  wrap.appendChild(cadence.el);

  // Load the current interval. A read failure leaves the control at "Not stated" and says so, rather than
  // silently showing a default that is not what the estate holds.
  void engine
    .getAttendedCadence()
    .then((r) => {
      if (cadenceInput === null) return;
      // A response that does not carry a NUMBER is not an exotic interval, it is an unreadable answer, and it
      // must be reported as one. Without this guard a body missing the field renders "a undefined-day
      // interval": the demo's own benignGet returns exactly such a shape for a route its table has not
      // learned yet, and the public tour would show that sentence to a visitor.
      if (typeof r.attendedCadenceDays !== "number" || !Number.isFinite(r.attendedCadenceDays)) {
        cadence.setError("Your engine did not return an interval, so this shows 'Not stated' rather than a guess.");
        return;
      }
      const v = String(r.attendedCadenceDays);
      if (CADENCE_OPTIONS.some((o) => o.value === v)) cadenceInput.value = v;
      // An interval the engine accepts but this closed list does not offer (set through the API, or offered
      // by a newer console). Saying so is honest; silently snapping the control to a neighbouring option
      // would misreport what the estate actually holds.
      else cadence.setError(`Your engine holds a ${r.attendedCadenceDays}-day interval, which is not one of the choices here. Choosing one will replace it.`);
    })
    .catch(() => {
      cadence.setError("Could not read the current interval from your engine, so this shows 'Not stated' rather than a guess.");
    });

  if (cadenceInput !== null && isOwner) {
    cadenceInput.addEventListener("change", () => {
      const days = Number(cadenceInput.value);
      void engine
        .setAttendedCadence(days)
        .then(() => {
          cadence.clearError();
        })
        .catch((e: unknown) => {
          cadence.setError(e instanceof Error ? `Your engine did not accept that interval: ${e.message}` : "Your engine did not accept that interval.");
        });
    });
  }

  const remindersBox = h("input", { type: "checkbox", id: "attend-reminders", ...(remindersOn() ? { checked: true } : {}) }) as HTMLInputElement;
  remindersBox.addEventListener("change", () => writeLocal(REMINDERS_KEY, remindersBox.checked ? "on" : "off"));
  wrap.appendChild(
    h(
      "label",
      { class: "field", style: "display:flex;gap:var(--space-2);align-items:center" },
      remindersBox,
      h("span", { class: "field__label", style: "margin:0" }, "Show a due reminder on the Restore screen (this browser only)"),
    ),
  );
  return wrap;
}

// keyDocLink is the group-level external doc link for the raw identity.key file input (a raw control cannot
// ride a field()'s doc option). The href is a string literal so the doc-link gate validates the anchor.
function keyDocLink(): HTMLElement {
  return h("a", { class: "field__doc linklike", href: "https://docs.downpipes.io/recovery/attended-verification#how-your-key-is-handled", target: "_blank", rel: "noreferrer noopener" }, "How your key is handled", svgIcon(ICON_CHEVRON_RIGHT, { size: 13 }));
}

// estimateLine states the session size honestly: how many runs and roughly how many records, with NO
// fabricated wall-clock (the first run's timing is genuinely unknown).
function estimateLine(session: CreateAttestSessionResult): HTMLElement {
  const { runs, records } = session.estimate;
  const sample = session.sampleRate >= 100 ? "a full 100% sample" : `a ${session.sampleRate}% sample`;
  return h("p", { class: "field__hint", style: "margin:0" }, `${groupNumber(runs)} ${runs === 1 ? "run" : "runs"}, about ${groupNumber(records)} ${records === 1 ? "record" : "records"} at ${sample}. First run, so timing is not yet known.`);
}

// runningNote is the immediate in-progress status for a multi-second step, so the runner reads as working.
function runningNote(msg: string): HTMLElement {
  return h("p", { class: "field__hint", style: "display:flex;align-items:center;gap:var(--space-2);margin:0" }, h("span", { class: "ob-spinner", "aria-hidden": "true" }), h("span", msg));
}

// renderResumeBanner offers to resume a persisted session (a reopened tab), re-selecting the identity.key.
//
// It carries BOTH supply routes, for the same reason the setup card does. The banner's own copy tells a
// split holder that resuming needs a quorum of shares again, and for a while the only control under that
// sentence was a file picker: the promise was made and the control could not keep it. A split holder who
// reopened the tab mid-session had one option, which was to abandon the session and start fresh, and on a
// large estate that is a re-convened quorum plus everything the session had already done.
//
// There is no staleness window here and so no onInvalidated. onResume consumes the key immediately by
// resuming the session, unlike the setup card where a reconstructed key waits for the operator to press
// start and can go stale in between.
function renderResumeBanner(resume: { sessionId: string; sampleRate: number }, onResume: (identity: HybridRecipientPrivate) => void): HTMLElement {
  const banner = h("section", { class: "card card--warn", style: "display:grid;gap:var(--space-3);margin-bottom:var(--space-4)" });
  banner.appendChild(h("h3", { class: "card__title" }, "Resume your last attended verification"));
  banner.appendChild(h("p", { class: "field__hint measure", style: "margin:0" }, `An attended-verification session from this browser (${resume.sampleRate}% sample) did not finish. Re-select your break-glass key to continue it from where it stopped, or start fresh below. If you hold a split key, resuming needs a quorum of shares again, the same as when you started it.`));
  const fileInput = h("input", { "data-dp": "restore-flow.file.resume-banner", type: "file", accept: ".key,text/plain", "aria-label": "Re-select your identity.key to resume" }) as HTMLInputElement;
  const err = h("p", { class: "field__error", role: "alert", hidden: true });
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    err.hidden = true;
    void readIdentityFile(file).then(onResume).catch((e: unknown) => { err.textContent = e instanceof Error ? e.message : "Could not read that file."; err.hidden = false; });
  });
  banner.appendChild(fileInput);
  banner.appendChild(err);
  const reassembly = renderReassemblyCard({
    showDownload: false,
    onRecovered: (recovered) => {
      if (recovered === null) {
        err.textContent = "The reassembled file is not a standard identity.key, so it cannot resume this session.";
        err.hidden = false;
        return;
      }
      err.hidden = true;
      onResume(recovered);
    },
  });
  banner.appendChild(collapsedSection("Reassemble a split (M-of-N) key instead", reassembly.el));
  // This banner returns a bare element, so no teardown handle escapes to a caller the way the setup form's
  // does (renderSetupForm hands its card up for the runner's unmount teardown). Without this the card's
  // shares, envelope and reconstructed private simply outlived the banner. Wiping on disconnect keeps the
  // guarantee without changing the banner's return shape, which several callers depend on.
  wipeOnDisconnect(banner, () => reassembly.teardown());
  return banner;
}

// ---- the entry card for the runless /restore landing --------------------------------------------------
// attendEntryCard is the compact entry point on the /restore home: it explains the offline-key-only
// in-platform proof path and links into the runner, plus a best-effort "due" nudge when the fleet's newest
// attended proof is older than the configured reminder cadence. It degrades to the plain pitch when the
// downpipe read or the setting is absent, and never blocks the restore flow.
export function attendEntryCard(engine: EngineClient): HTMLElement {
  const card = h("section", { class: "card", "aria-labelledby": "attend-entry-h", style: "display:grid;gap:var(--space-3)" });
  const head = h("div", { class: "card__header" });
  head.appendChild(h("h2", { class: "card__title", id: "attend-entry-h" }, "Attended verification"));
  head.appendChild(badge("trust", "offline-key-only proof"));
  card.appendChild(head);
  card.appendChild(h("p", { class: "field__hint measure", style: "margin:0" }, "In the offline-key-only posture your engine still verifies each run at seal and flies its hourly canary, but it holds no key to reopen a run it sealed earlier. Prove those here instead: supply your break-glass key in your browser and the engine verifies a sample against the keys you recover. Nothing is written."));

  const nudgeHost = h("div");
  card.appendChild(nudgeHost);

  card.appendChild(
    h("div", { style: "display:flex;gap:var(--space-2);flex-wrap:wrap;align-items:center" },
      h("button", { "data-dp": "restore-flow.button.navigate-restore-attend#1", class: "btn btn--secondary btn--sm", type: "button", on: { click: () => navigate("/restore/attend") } }, svgIcon(ICON_SHIELD_CHECK, { size: 14 }), "Start attended verification"),
    ),
  );

  // Best-effort due nudge from the ESTATE's stated interval and the fleet's newest attended proof.
  //
  // The interval now comes from the engine rather than this browser, so the nudge means the same thing on
  // every machine and survives a cleared cache. The toggle stays local, because whether to show a nudge
  // on this screen is genuinely a per-browser preference.
  //
  // Both reads are best-effort and neither blocks: a nudge that cannot be computed is simply absent,
  // which is honest, where one computed from a stale local number would be confidently wrong.
  if (remindersOn()) {
    void Promise.all([engine.getAttendedCadence(), engine.listDownpipes()])
      .then(([cadence, list]) => {
        if (cadence.attendedCadenceDays <= 0) return;
        const nudge = dueNudge(list, cadence.attendedCadenceDays);
        if (nudge) nudgeHost.replaceChildren(nudge);
      })
      .catch(() => { /* read-only nudge: never blocks */ });
  }
  return card;
}

// dueNudge computes a best-effort "attended verification is due" note: the newest ATTENDED proof across the
// fleet vs the configured cadence. Returns an amber note when overdue (or never attended), or null when a
// recent attended proof exists (no nudge needed). Recency only; no value, no key.
function dueNudge(list: DownpipeState[], days: number): HTMLElement | null {
  const attended = list
    .filter((d) => d.restoreProvenMethod === "attended-blind-test" && d.lastRestoreProvenAt)
    .map((d) => Date.parse(d.lastRestoreProvenAt ?? ""))
    .filter((ms) => Number.isFinite(ms));
  const newest = attended.length > 0 ? Math.max(...attended) : null;
  const dueMs = days * 24 * 60 * 60 * 1000;
  if (newest !== null && Date.now() - newest < dueMs) return null;
  const detail = newest !== null
    ? `The newest attended verification was ${relativeTime(new Date(newest).toISOString())}, past your ${days}-day reminder cadence.`
    : "No attended verification has been recorded in this posture yet.";
  return h("div", { style: "display:flex;gap:var(--space-2);align-items:flex-start" }, h("span", { class: "dot dot--warn", "aria-hidden": "true", style: "margin-top:6px;flex:none" }), h("p", { class: "field__hint", style: "margin:0" }, `Attended verification is due. ${detail}`));
}
