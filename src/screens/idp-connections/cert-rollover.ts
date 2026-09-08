// The zero-downtime SAML signing-certificate rollover control, mounted on a SAML connection card.
//
// WHY IT EXISTS. The engine has served POST /admin/idp/connections/cert, gated on the
// owner-exclusive keys.ceremony and routed through the `idp-conn-cert` dual-control owner action. Nothing in
// this console ever called it, so the only portal path through a certificate rotation was remove-and-re-add:
// that bumps the idpEpoch (every session signed in through the connection ends) and, under dual control, queues
// TWO approvals with a window in between where nobody can sign in through the provider at all. The standing rule
// is that a customer never runs a terminal, so a rollover that only exists as an HTTP endpoint does not exist.
//
// THE TWO STEPS ARE A DELIBERATE CHOICE, NOT AN INFERENCE. Append merges the new certificate onto the pinned
// set, so an assertion signed by either the old or the new key verifies while the IdP cuts over. Replace sends
// the full new set, pruning the retired certificate once the cut-over has finished. Doing replace first is what
// breaks sign-in, so the operator picks, and the hint says what each one does rather than leaving it to be
// guessed from the verb.
//
// THE QUEUED BRANCH IS THE POINT OF THIS FILE. A signing certificate is the SAML trust root, so this is the
// same account-takeover blast class as creating a connection: with dual control armed the engine answers 202
// and applies nothing until a second owner approves. The result is read as a discriminated OwnerActionResult
// and the queued case is surfaced as "queued for a second owner", never as a success. A false success here
// would tell an operator their provider's new signing key is trusted while it is not, and they would let the
// old key be retired at the IdP on the strength of it.
//
// House rules: Australian English, no em dashes, precise claims.

import type { EngineClient, IdpConnectionView } from "../../api.ts";
import { isOwnerActionQueuedResult } from "../../api.ts";
import { stepUpAwareText } from "../../components/error-view.ts";
import { field } from "../../components/field.ts";
import { requireChange } from "../../components/require-change.ts";
import { toast } from "../../components/toast.ts";
import { recordInputDropped } from "../../lib/client-diag/ring.ts";
import { h } from "../../lib/dom.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { goSignedOut } from "../../lib/nav.ts";
import { surfaceQueuedOwnerAction } from "../../lib/pending-change-toast.ts";
import { capGateReason, refuseWithReason } from "../common.ts";
import { capitalise, MANAGE_CAP, pemBlocksIntended, splitPems } from "./shared.ts";

// The engine's own cap on the pinned set (validateSamlCerts, engine idpconn-validators.ts SAML_CERTS_MAX).
// Mirrored here so an over-long append is refused at the field rather than as a bare engine reason, and stated
// in the hint so the limit is knowable before the paste.
const SAML_CERTS_MAX = 8;

// certRolloverSection builds the whole control: the mode picker, the PEM paste box, the apply button and the
// inline refusal slot. `reload` re-reads the connection list once a rollover has actually applied.
export function certRolloverSection(engine: EngineClient, conn: IdpConnectionView, canManage: boolean, reload: () => void): HTMLElement {
  const wrap = h("div", { class: "stack-sm", style: "display:grid;gap:var(--space-3)" });
  wrap.appendChild(
    h(
      "p",
      { class: "field__hint measure" },
      "Roll the pinned signing certificate over without ending anyone's session. Append the new certificate before your provider cuts over, so assertions signed by either key verify through the overlap, then replace the set afterwards to prune the retired one. The certificates are public; there is no secret here.",
    ),
  );

  const modeField = field({
    id: "saml-rollover-mode",
    label: "Rollover step",
    kind: "select",
    value: "append",
    hint: "Append adds the pasted certificate(s) to the pinned set and keeps the existing ones, which is the step to take BEFORE your provider cuts over. Replace makes the pasted certificate(s) the entire pinned set, which retires every certificate not pasted, so take it only AFTER the cut-over is complete.",
    doc: { href: "https://docs.downpipes.io/identity-access/connect-saml", anchor: "rotating-the-signing-certificate" },
    options: [
      { value: "append", label: "Append (overlap, before the cut-over)" },
      { value: "replace", label: "Replace (prune, after the cut-over)" },
    ],
  });

  const certsField = field({
    id: "saml-rollover-certs",
    label: "IdP signing certificate(s) (PEM)",
    kind: "textarea",
    required: true,
    placeholder: "-----BEGIN CERTIFICATE-----\nMIIC...\n-----END CERTIFICATE-----",
    hint: `Paste the provider's public signing certificate(s) in PEM form, one after another for several. The pinned set holds up to ${SAML_CERTS_MAX} certificates in total, and on Append that total counts the ones already pinned.`,
    doc: { href: "https://docs.downpipes.io/identity-access/connect-saml", anchor: "rotating-the-signing-certificate" },
    validate: (v) => (v.includes("BEGIN CERTIFICATE") ? null : "Paste at least one PEM certificate (it begins with -----BEGIN CERTIFICATE-----)."),
  });

  const applyError = h("p", { class: "field__error", role: "alert", hidden: true });
  const certRolloverBtn = h(
    "button",
    { "data-busy-label": "Rolling over...",
      "data-dp": "idp-connections.button.cert-rollover",
      class: "btn btn--secondary btn--sm",
      type: "button",
    },
    "Roll over certificate",
  ) as HTMLButtonElement;

  if (canManage) certRolloverBtn.addEventListener("click", () => void runRollover(engine, conn, modeField, certsField, certRolloverBtn, applyError, reload));
  else refuseWithReason(certRolloverBtn, capGateReason(MANAGE_CAP));

  wrap.appendChild(modeField.el);
  wrap.appendChild(certsField.el);
  wrap.appendChild(h("div", { style: "display:flex;gap:var(--space-2);flex-wrap:wrap;align-items:center" }, certRolloverBtn));
  // THE CEREMONY, named before the button rather than discovered after it. A signing certificate decides
  // which assertions verify, so the engine demands a fresh identity check on the rollover.
  wrap.appendChild(
    h("p", { class: "field__hint measure" }, "You may be asked to confirm with your own passkey when you roll over. If you dismiss that prompt, or it fails, nothing is changed and the pinned certificates stay exactly as they are."),
  );
  wrap.appendChild(applyError);
  return wrap;
}

// runRollover is the click handler, split out so the file stays inside the size budget and so the branch order
// is readable at a glance: refuse locally, collect the change reference, POST, then QUEUED before applied.
async function runRollover(
  engine: EngineClient,
  conn: IdpConnectionView,
  modeField: ReturnType<typeof field>,
  certsField: ReturnType<typeof field>,
  certRolloverBtn: HTMLButtonElement,
  applyError: HTMLElement,
  reload: () => void,
): Promise<void> {
  applyError.hidden = true;
  if (!certsField.validate()) {
    certsField.focus();
    return;
  }
  const certs = splitPems(certsField.value());
  // The same measure the create form takes: splitPems keeps only the blocks whose BEGIN and END lines both
  // survived the paste, so an editor that mangled one silently submits FEWER certificates than the operator
  // pasted, and the loss only shows up as a broken sign-in weeks later. Counting BEGIN markers gives the
  // denominator. COUNTS ONLY: no certificate body is ever recorded.
  const intended = pemBlocksIntended(certsField.value());
  recordInputDropped("idp-cert-paste", certs.length, Math.max(0, intended - certs.length));
  if (certs.length === 0) {
    certsField.refuse("Paste at least one complete PEM certificate (the block must end with -----END CERTIFICATE-----).");
    certsField.focus();
    return;
  }
  const mode = modeField.value() === "replace" ? "replace" : "append";
  // THE CAP IS ON THE RESULTING PINNED SET, AND THIS GUARD USED TO COUNT ONLY THE PASTE. On Append the
  // engine validates the EXISTING set concatenated with the paste, so seven pinned plus two pasted is
  // nine and is refused, while this check saw two and let it through. The file's own hint has always said
  // "on Append that total counts the ones already pinned", so what was missing was the arithmetic rather
  // than the knowledge.
  //
  // WHY IT MATTERED MORE THAN AN EXTRA ROUND TRIP. The engine's refusal for an over-capacity array was
  // the wrong-shape sentence ("idpSigningCerts must be a non-empty array of PEM X.509 certificates"),
  // confirmed directly, so an operator rolling a signing certificate over
  // against their provider's cut-over deadline was told their perfectly good certificates were not
  // certificates. The engine now names the capacity too; this refuses before the request, with the
  // pinned count and the remedy that actually lowers it.
  // READ DEFENSIVELY, and this is not belt and braces. The first cut of this guard read
  // conn.idpSigningCerts.length behind a kind check alone, and validate-gated-202-decode drove it with a
  // SAML connection whose certs array was simply absent: a TypeError inside the click handler, on the
  // screen whose whole job is a rollover. The type says the field is there, the wire is what decides, and
  // an absent array must degrade to "count nothing pinned" so the engine still gets the last word. A
  // false negative here costs one round trip; a throw costs the operator the control entirely.
  const pinned = conn.kind === "saml" && Array.isArray(conn.idpSigningCerts) ? conn.idpSigningCerts.length : 0;
  const resulting = mode === "append" ? pinned + certs.length : certs.length;
  if (resulting > SAML_CERTS_MAX) {
    certsField.refuse(
      mode === "append"
        ? `This connection already pins ${pinned} certificate(s), so appending ${certs.length} more would make ${resulting}, over the limit of ${SAML_CERTS_MAX}. Choose Replace to make the pasted certificate(s) the whole pinned set, which prunes the retired ones.`
        : `Paste at most ${SAML_CERTS_MAX} certificates; the pinned set holds ${SAML_CERTS_MAX}.`,
    );
    certsField.focus();
    return;
  }
  const verb = mode === "replace" ? "Replace" : "Append";
  // Change management (owner opt-in): a signing certificate decides which assertions verify, so a rollover is a
  // change-controlled action. Collect a change reference when the policy requires one (a no-op otherwise).
  //
  // The gate op names the ROLLOVER. The op reaches the engine on the one path requireChange records (a policy
  // read that failed, require-change.ts:55), where the engine checks it by SET MEMBERSHIP and fails the record
  // CLOSED on a member it does not hold (engine/src/admin/client-diag-receive.ts:220). The engine admits
  // idp-connection-cert-rollover, so the row now names the operation the operator was actually blocked at
  // instead of the connection edit they never attempted. Never move this ahead of the engine's list.
  const cr = await requireChange(engine, `${verb} the SAML signing certificate(s) on the ${conn.label} connection`, "idp-connection-cert-rollover");
  if (!cr.proceed) return;
  certRolloverBtn.disabled = true;
  const prevLabel = certRolloverBtn.textContent;
  certRolloverBtn.textContent = "Rolling over...";
  const restore = () => {
    certRolloverBtn.disabled = false;
    certRolloverBtn.textContent = prevLabel;
  };
  try {
    const res = await engine.rolloverIdpSigningCerts(conn.id, mode, certs, cr.change ?? undefined);
    // DUAL CONTROL ARMED: the engine answered 202 and stored NOTHING. The pinned set is unchanged until a
    // second owner approves, so this must never read as a completed rollover.
    if (isOwnerActionQueuedResult(res)) {
      surfaceQueuedOwnerAction(`Rolling over the signing certificate on ${conn.label}`);
      restore();
      return;
    }
    if (!res.value.ok) {
      applyError.textContent = capitalise(res.value.reason ?? "the rollover was refused");
      applyError.hidden = false;
      restore();
      return;
    }
    toast({
      message:
        mode === "replace"
          ? `${conn.label} now pins only the certificate(s) you pasted. Nobody was signed out.`
          : `${conn.label} now also trusts the certificate(s) you pasted. Nobody was signed out.`,
    });
    reload();
  } catch (err) {
    if (isUnauthorised(err)) {
      // PAINT FIRST, THEN LEAVE: the rollover did not apply, so the control must not stay dead behind us.
      restore();
      goSignedOut();
      return;
    }
    applyError.textContent = `Could not roll the certificate over. ${stepUpAwareText(err)}`;
    applyError.hidden = false;
    restore();
  }
}
