// The first half of the onboarding card deck data: chapters 0 (Connect) and 1 (Your keys),
// split out of carousel-cards.ts to keep each data module under the size budget. The cards are
// byte-identical to their previous form; only their host
// module moved, and carousel-cards.ts re-concatenates this part with the second part so OB_CARDS
// keeps the exact same order and contents. House rules: Australian English, no em dashes, precise
// claims.

import { h, svgIcon } from "../../lib/dom.ts";
import { canDo, collapsedSection, gateReason, refuseWithReason } from "../common.ts";
import { navigate, goSignedOut } from "../../lib/nav.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { blockError, sessionEnded } from "../../components/error-view.ts";
import { statusWithLabel } from "../../components/status.ts";
import { verdictSurface } from "../../components/verdict.ts";
import { infoTip } from "../../components/info-tip.ts";
import { toast } from "../../components/toast.ts";
import { getEngine, connect, getCeremony, setCeremony, setPostureChoice, getPostureChoice } from "../../lib/store.ts";
import { POSTURE_ACK_STATEMENTS, type PostureChoice } from "../../lib/posture-ack-statements.ts";
import {
  ICON_CHECK,
  ICON_LOCK,
  ICON_REFRESH,
  ICON_CHEVRON_LEFT,
  ICON_KEYS,
} from "../../lib/icons.ts";
import { reportKeygenFault } from "../../lib/client-diag/capability-faults.ts";
import { recordOnboardingStep } from "../../lib/client-diag/ring.ts";
import {
  runKeyCeremony,
  identityFile,
  recipientFile,
  signerPublicFile,
  signerPrivateFile,
  type CeremonyResult,
} from "../../keygen.ts";
import { recoverySheet } from "../../recovery-sheet.ts";
import { renderCustodyStep } from "../../components/custody-step.ts";
import type { CustodyMetadata } from "../../lib/custody.ts";
import {
  type CardDef,
  accessLine,
  resolveAccessVerdict,
  fileRow,
  fpRow,
  setBusy,
  recordCeremonyIntent,
  sheetParams,
  openRecoverySheetWith,
  downloadCeremonyFiles,
  downloadText,
  errMessage,
  cardActions,
  disableGatedPrimary,
  enableGatedPrimary,
  cardEyebrow,
} from "./shared.ts";

// The prereqs gate's one reason, shared by every site that renders it (the card nudge, the
// primary's first render, the re-lock path) so the copies can never drift.
const PREREQS_GATE_REASON = "Tick the required items to continue.";

// ---------------------------------------------------------------------------
// Chapters 0 (Connect) and 1 (Your keys)
// ---------------------------------------------------------------------------

export const OB_CARDS_CONNECT_KEYS: CardDef[] = [
  // -- Chapter 0: Connect --------------------------------------------------
  {
    id: "welcome", chapter: 0,
    custody: "No-custody setup. Your keys are made in this browser.",
    mount(host, nav) {
      host.appendChild(h("div", { class: "cx-hero-mark" }, svgIcon(ICON_LOCK, { size: 28 })));
      host.appendChild(h("h2", { class: "cx-title" }, "Welcome to downpipes"));
      host.appendChild(h("p", { class: "cx-lede" }, "Back up your data automatically. Recover it yourself, even offline."));
      host.appendChild(h("p", { class: "cx-note" }, "Let's set up your console in about five minutes. Your keys are made here in your browser."));
      host.appendChild(cardActions({ nav, showBack: false, primary: { label: "Get started", onClick: () => nav.advance() } }).row);
    },
  },
  {
    id: "prereqs", chapter: 0, gate: true, nudge: PREREQS_GATE_REASON,
    custody: "downpipes runs in your account, not ours.",
    mount(host, nav) {
      host.appendChild(cardEyebrow("Connect"));
      host.appendChild(h("h2", { class: "cx-title" }, "Before you begin"));
      host.appendChild(h("p", { class: "cx-lede" }, "downpipes runs inside your own Cloudflare account. Confirm these are switched on there. Only you can check them; the wizard verifies everything else for you."));

      // The MANUAL prerequisites: the things the engine cannot observe for itself (the account
      // plan, somewhere to write the archives, the optional add-ons). Each is a compact tick row
      // with a pop-style how-to (the same affordance as "How do I create the token?"). The two
      // required items gate Continue; the optional ones are there to acknowledge and never block.
      // The auto-verifiable checks (Durable Objects, the cron, the keys, sliced runs) are
      // confirmed later on the Ready step.
      //
      // THE SECOND ITEM ASKED FOR R2 BY NAME UNTIL, AND GATED CONTINUE ON IT. It read
      // "R2 object storage is turned on" over "Your backups are written to R2", and Continue was
      // disabled until it was ticked. downpipes writes to four kinds of store (Cloudflare R2, any
      // S3-compatible store, Google Cloud Storage, Azure Blob Storage: PROVIDERS in
      // screens/destination-form-fields.ts, providerForEndpoint in engine/src/dest/provider.ts),
      // and the engine's R2 binding is optional and commented out in its own wrangler.toml. So a
      // customer archiving to S3, Google Cloud or Azure could not finish first run at all without
      // ticking a box that was false for them, and the ones who ticked it anyway were taught that
      // the product only writes to R2.
      //
      // THE ITEM IS KEPT REQUIRED AND MADE TRUE, rather than made optional. What it is really
      // asking is whether there is anywhere for the archives to go, which is the one prerequisite
      // a backup product cannot proceed without, and it is still something only the customer can
      // answer. Making it optional would have removed the gate as well as the falsehood, and left
      // a customer to discover on the Destinations screen that they had nowhere to write. R2 stays
      // in the how-to as the worked example, because it is the in-account option and the shortest
      // path, and the other three are named beside it so nobody reads it as the only one.
      const items: Array<{ title: string; sub: string; info: string; required: boolean }> = [
        { title: "Workers Paid plan is active", sub: "Durable Objects and scheduled runs need it (about $5 a month).", required: true, info: "Turn it on in the Cloudflare dashboard: open Workers & Pages, then Plans, then choose Workers Paid. The scheduler (Durable Objects) and the reconciliation cron do not run on the free plan." },
        { title: "An archive destination is available", sub: "Somewhere to write the backups: Cloudflare R2, an S3-compatible store, Google Cloud Storage or Azure Blob Storage.", required: true, info: "R2 is the in-account option and the quickest to start with: open R2 in the dashboard, then Enable. Any S3-compatible store (Amazon S3 included), Google Cloud Storage and Azure Blob Storage work just as well, and each needs a bucket or container plus a key pair you can paste. You do not set any of that up here; you choose the destination later, on the Destinations screen." },
        { title: "Cloudflare Access", sub: "Optional. Single sign-on or IP gating in front of the console.", required: false, info: "Optional, and free for up to 50 users. In Zero Trust, create an Access application for the console's address, then set the Access variables at deploy. You can also just use passkeys, which need no setup at all." },
        { title: "Outbound email", sub: "Optional. Needed only for alert, expiry and invite emails.", required: false, info: "Optional. Complete Email Routing onboarding for your sender domain, then bind EMAIL and set EMAIL_FROM at deploy. Without it the console still works; it just cannot send notifications." },
      ];

      const reqs = h("ul", { class: "cx-reqs" });
      const allBoxes: HTMLInputElement[] = [];
      const requiredBoxes: HTMLInputElement[] = [];
      for (const item of items) {
        const cb = h("input", { "data-dp": "onboarding.checkbox.cb", type: "checkbox" }) as HTMLInputElement;
        allBoxes.push(cb);
        if (item.required) requiredBoxes.push(cb);
        reqs.appendChild(
          h(
            "li",
            { class: "cx-req" },
            h(
              "label",
              { class: "cx-req__lab" },
              cb,
              h("span", { class: "cx-req__box" }, svgIcon(ICON_CHECK, { size: 12 })),
              h("span", { class: "cx-req__txt" }, h("span", { class: "cx-req__t" }, item.title), h("span", { class: "cx-req__s" }, item.sub)),
            ),
            // The pop-style how-to sits OUTSIDE the label so opening it never toggles the box.
            infoTip(item.info, { label: `How to: ${item.title}` }),
          ),
        );
      }
      host.appendChild(h("div", { class: "cx-body" }, reqs));

      const { row, primaryBtn } = cardActions({
        nav,
        primary: { label: "Continue", onClick: () => nav.advance(), enabled: false, reason: PREREQS_GATE_REASON },
      });
      host.appendChild(row);
      const recompute = () => {
        const all = requiredBoxes.every((b) => b.checked);
        if (all) { enableGatedPrimary(primaryBtn); nav.markPassed(); }
        else disableGatedPrimary(primaryBtn, PREREQS_GATE_REASON);
      };
      for (const b of allBoxes) b.addEventListener("change", recompute);
    },
  },
  {
    id: "connect", chapter: 0, gate: true, nudge: "Hold on, still checking your engine.",
    custody: "The console connects to your engine and nowhere else.",
    mount(host, nav) {
      host.appendChild(cardEyebrow("Connect"));
      host.appendChild(h("h2", { class: "cx-title" }, "Connect to your engine"));
      host.appendChild(h("p", { class: "cx-lede" }, "Your engine is served on this same address. This checks that it answers."));

      const verdict = h("div", { class: "cx-body", role: "status", "aria-live": "polite" });
      verdict.appendChild(h("div", { class: "cx-status" }, h("span", { class: "ob-spinner", "aria-hidden": "true" }), h("span", "Checking your engine.")));
      host.appendChild(verdict);
      host.appendChild(
        h("p", { class: "cx-note" }, "Your engine runs in your own Cloudflare account, and the console only ever talks to it."),
      );

      const { row, primaryBtn } = cardActions({
        nav,
        primary: { label: "Continue", onClick: () => nav.advance(), enabled: false, reason: "Checking the engine; this resolves in a moment." },
      });
      host.appendChild(row);
      const enable = () => { enableGatedPrimary(primaryBtn); nav.markPassed(); };

      // The same probe the old connect step ran: GET /admin/health (the CONSOLE_ORIGIN diagnostic),
      // then the authenticated status, then the honest sign-in verdict as one line. Unchanged logic.
      const doConnect = async () => {
        const client = getEngine() ?? connect(location.origin);
        verdict.replaceChildren(h("div", { class: "cx-status" }, h("span", { class: "ob-spinner", "aria-hidden": "true" }), h("span", "Checking your engine.")));
        let healthReachable = false;
        try {
          const hres = await client.health();
          healthReachable = true;
          if (!hres.ok) {
            // G125: the engine ANSWERED and reported itself not healthy. It is reachable, so this is not a
            // connect fault, and the remedy is the engine's own logs. Distinct from transport-error below.
            recordOnboardingStep("connect", "engine-not-ok");
            verdict.replaceChildren(
              verdictSurface({ tone: "warn", title: "The engine responded but reported not ok", body: "The engine is reachable but is not healthy. Check the engine logs, then retry.", action: { label: "Retry", onClick: () => void doConnect() } }),
            );
            return;
          }
        } catch (err) {
          // G125: the health probe itself did not come back. The engine NEVER SAW this request, so no
          // engine-side evidence of it can ever exist: this row is the only record anywhere that a customer
          // tried to connect a wizard to an engine and could not reach it at all.
          recordOnboardingStep("connect", "transport-error");
          verdict.replaceChildren(blockError(err, () => void doConnect(), { origin: location.origin, healthReachable: false }));
          return;
        }
        try {
          const status = await client.status();
          recordOnboardingStep("connect", "ok");
          verdict.replaceChildren(statusWithLabel("ok", `Connected to your engine. Version ${status.engineVersion}.`));
          void resolveAccessVerdict(client)
            .then((v) => verdict.appendChild(h("div", { style: "margin-top:var(--space-2)" }, accessLine(v))))
            .catch(() => {
              // G125: the sign-in verdict line never resolved, so the wizard renders no verdict at all and the
              // operator cannot see whether Access is enforced on the engine they just connected. The comment
              // that used to sit here said the readiness checklist re-checks, which is true and is not evidence.
              recordOnboardingStep("connect", "access-verdict-unresolved");
            });
          enable();
        } catch (err) {
          // G125: THE ACCESS SIGNATURE. Health passed (healthReachable is true: the unauthenticated probe got
          // through) and the AUTHENTICATED status read then failed. The engine is up and reachable and will not
          // serve authenticated traffic from this browser: an Access policy that does not admit this operator,
          // or a CONSOLE_ORIGIN that does not name this console. The customer's report is verbatim "health
          // passes but it keeps kicking me to sign-in", and until now the pack held nothing at all about it,
          // because from the engine's side the only trace is a request it either never received (CORS) or
          // refused at the edge (Access), and neither is in the bundle.
          //
          // A clean 401 is told apart from it. Everywhere else in the console a 401 is the ordinary lapsed
          // session and is deliberately NOT recorded, but at the CONNECT step it means the operator cannot
          // begin, and separating "you are not signed in" from "you are signed in and the engine will not talk
          // to you" IS the diagnosis.
          if (isUnauthorised(err)) {
            recordOnboardingStep("connect", "unauthorised");
            // PAINT FIRST, THEN LEAVE: the verdict is a spinner reading "Checking your engine." until this
            // replaces it, which on the CONNECT step is the whole content of the card.
            verdict.replaceChildren(sessionEnded(() => void doConnect()));
            return goSignedOut();
          }
          recordOnboardingStep("connect", healthReachable ? "health-ok-status-failing" : "transport-error");
          verdict.replaceChildren(blockError(err, () => void doConnect(), { origin: location.origin, healthReachable }));
        }
      };
      void doConnect();
    },
  },

  // -- Chapter 1: Your keys ------------------------------------------------
  {
    id: "keys-intro", chapter: 1,
    custody: "Your keys are generated in this browser, and nothing is sent while they are made.",
    mount(host, nav) {
      host.appendChild(cardEyebrow("Your keys"));
      host.appendChild(h("h2", { class: "cx-title" }, "Now, your keys"));
      host.appendChild(h("p", { class: "cx-lede" }, "We create a small set of keys here in your browser. Nothing is sent to a server while they are made."));
      host.appendChild(
        h("div", { class: "cx-body" },
          h("div", { class: "cx-callout" },
            h("span", { class: "cx-callout__icon" }, svgIcon(ICON_KEYS, { size: 20 })),
            h("span", {}, h("strong", "Each key has one job"), h("span", { class: "cx-callout__b" }, "One proves your backups are genuine; another lets you recover them. We never receive either.")),
          ),
          // What generating actually produces, stated BEFORE the operator presses Generate, so
          // the burst of downloads a moment later is expected rather than alarming.
          h("div", { class: "cx-callout cx-callout--trust" },
            h("span", { class: "cx-callout__icon" }, svgIcon(ICON_LOCK, { size: 20 })),
            h("div", {},
              h("strong", "What you will get"),
              h("ul", { class: "cx-callout__b", style: "margin:0;padding-left:var(--space-4)" },
                // The COUNT is posture-dependent and this card renders BEFORE the fork, so it cannot be
                // stated as one number. downloadCeremonyFiles (./shared.ts) delivers four key files under
                // the offline-key-only posture and five when an operational key was chosen, plus the sheet
                // in both. "Five small key files" was true only for the operational posture, which is not
                // the one that leads the fork, so the customer the sentence exists to reassure (the burst of
                // downloads is expected, not alarming) was the one it was wrong for.
                h("li", {}, "Four small key files, plus a printable recovery sheet. Choosing the operational key on the next step adds a fifth."),
                h("li", {}, "It takes under a minute."),
                h("li", {}, "Have somewhere offline ready for ", h("code", { class: "mono" }, "identity.key"), "."),
              ),
            ),
          ),
        ),
      );
      host.appendChild(cardActions({ nav, primary: { label: "Next", onClick: () => nav.advance() } }).row);
    },
  },
  {
    id: "break-glass", chapter: 1,
    custody: "Your break-glass key is never sent to us; you save it yourself.",
    mount(host, nav) {
      host.appendChild(cardEyebrow("Your keys"));
      host.appendChild(h("h2", { class: "cx-title" }, "Meet your break-glass key"));
      host.appendChild(h("p", { class: "cx-lede" }, "One key is special. Your break-glass key is the only thing that can recover your backups; you download and keep it, and it is never sent to us."));
      host.appendChild(
        h("div", { class: "cx-body" },
          h("div", { class: "cx-callout cx-callout--trust" },
            h("span", { class: "cx-callout__icon" }, svgIcon(ICON_LOCK, { size: 20 })),
            h("span", {}, h("strong", "There is no copy anywhere else"), h("span", { class: "cx-callout__b" }, "Not on our servers, and not on your engine. You will save it yourself in a moment, somewhere safe.")),
          ),
        ),
      );
      host.appendChild(cardActions({ nav, primary: { label: "Next", onClick: () => nav.advance() } }).row);
    },
  },
  {
    id: "tradeoff", chapter: 1, gate: true, nudge: "Choose your key posture to continue.",
    custody: "You choose what your engine can decrypt. Your break-glass key stays offline either way.",
    mount(host, nav) {
      host.appendChild(cardEyebrow("Your keys"));
      host.appendChild(h("h2", { class: "cx-title" }, "Choose your key posture"));
      host.appendChild(h("p", { class: "cx-lede" }, "Both postures protect your data with the same offline break-glass key, so both recover offline. The choice is what your engine also holds, and whether it can reopen a run it sealed earlier without you."));
      const body = h("div", { class: "cx-body" });
      host.appendChild(body);

      // The docs link: "Learn the implications of each". It opens the pros-and-cons,
      // supply-chain scenario and residual-risk page in a new tab (the same page the recorded acceptance
      // statements are quoted on, so the page IS the disclosure).
      const learnMore = h("p", { class: "field__hint", style: "margin-top:var(--space-3)" },
        h("a", { class: "linklike", href: "https://docs.downpipes.io/concepts/choosing-your-key-posture", target: "_blank", rel: "noreferrer noopener" }, "Learn the implications of each"),
      );

      // renderAlreadyKeyed: a returning operator whose engine already holds keys cannot change posture
      // here (posture is fixed at key generation), so do NOT force a choice against a posture that is
      // already set (recording a "choice" that contradicts the live posture would be worse than useless).
      // Show the current posture, say it is fixed, point at the Keys screen to re-key, and let them continue.
      const renderAlreadyKeyed = (operationalPresent: boolean) => {
        const postureLabel = operationalPresent
          ? "Your engine holds an operational key, so it can reopen and restore-test your past runs on its own."
          : "Your engine is offline-key-only, so it holds no key that can decrypt your archives.";
        body.replaceChildren(
          h("div", { class: "cx-callout cx-callout--trust" },
            h("span", { class: "cx-callout__icon" }, svgIcon(ICON_LOCK, { size: 20 })),
            h("span", {},
              h("strong", "Your key posture is already set"),
              h("span", { class: "cx-callout__b" },
                postureLabel,
                // "Posture is fixed when your keys are generated. To change it, re-key" was false: keys/posture.ts
                // adds an operational key over POST /admin/keys/add-operational and keys/posture-switch.ts removes
                // one over POST /admin/keys/break-glass-only, and neither runs a key ceremony or touches the
                // break-glass key. Sending a customer to a re-key they do not need is how they end up with a new
                // key set that does not match the identity.key and sheet they saved.
                " You can change it from the ",
                h("button", { "data-dp": "onboarding.button.navigate-keys#1", class: "linklike", type: "button", on: { click: () => navigate("/keys") } }, "Keys screen"),
                " without a re-key, and your break-glass key stays the one you already saved.",
              ),
            ),
          ),
          learnMore,
        );
        nav.markPassed();
        host.appendChild(cardActions({ nav, primary: { label: "Continue", onClick: () => nav.advance() } }).row);
      };

      // renderFork: a fresh, keyless onboarding shows the live two-panel choice with a reveal-on-select
      // acceptance. No default selection; the customer picks a posture, reads its exact acceptance
      // statement, ticks that they understand, and confirms. The confirm records the acknowledgement
      // (best-effort, advisory) and threads the posture into the ceremony on the next card.
      const renderFork = () => {
        const panels: Partial<Record<PostureChoice, HTMLElement>> = {};
        const acceptHost = h("div");

        // buildPanel is one descriptive posture panel: a title, a one-line summary, two implication
        // points (never three, per house style), and a Choose button that selects it.
        const buildPanel = (posture: PostureChoice, title: string, summary: string, points: string[], onChoose: () => void): HTMLElement => {
          const pts = h("ul", { class: "ob-posture-card__points" });
          for (const p of points) pts.appendChild(h("li", {}, p));
          const chooseBtn = h("button", { "data-dp": "onboarding.button.choose", class: "btn btn--secondary btn--sm", type: "button" }, "Choose this") as HTMLButtonElement;
          chooseBtn.addEventListener("click", onChoose);
          const panel = h("div", { class: "ob-posture-card", "data-posture": posture, "data-selected": "false" },
            h("div", { class: "ob-posture-card__title" }, title),
            h("div", { class: "ob-posture-card__summary" }, summary),
            pts,
            h("div", { class: "ob-posture-card__spacer" }),
            chooseBtn,
          );
          panels[posture] = panel;
          return panel;
        };

        const select = (posture: PostureChoice) => {
          for (const [k, el] of Object.entries(panels)) {
            if (el) el.setAttribute("data-selected", k === posture ? "true" : "false");
          }
          renderAcceptance(posture);
        };

        // renderAcceptance shows the chosen posture's EXACT acceptance statement (the same words the
        // engine hashes into the audit record), a single affirmation checkbox, and a confirm button
        // disabled until it is ticked. Confirming records the acknowledgement and advances.
        const renderAcceptance = (posture: PostureChoice) => {
          const stmt = POSTURE_ACK_STATEMENTS[posture];
          const check = h("input", { "data-dp": "onboarding.checkbox.check", type: "checkbox", "aria-label": "I have read the implications and understand my choice" }) as HTMLInputElement;
          const confirmBtn = h("button", { "data-dp": "onboarding.button.confirm", class: "btn btn--primary", type: "button", disabled: true, "aria-disabled": "true" }, "Confirm and continue") as HTMLButtonElement;
          const busyReset = () => setBusy(confirmBtn, false, "Confirm and continue");
          check.addEventListener("change", () => {
            confirmBtn.disabled = !check.checked;
            if (check.checked) confirmBtn.removeAttribute("aria-disabled");
            else confirmBtn.setAttribute("aria-disabled", "true");
          });
          confirmBtn.addEventListener("click", async () => {
            if (confirmBtn.disabled) return;
            setBusy(confirmBtn, true, "Recording your choice");
            setPostureChoice(posture);
            // Acknowledgement: the engine records the posture, the statement version and a hash of these
            // exact words into the tamper-evident audit log. It stays ADVISORY and never blocks the
            // ceremony, because a customer must not be stuck at a key ceremony by a transient network
            // fault. But it no longer fails SILENTLY.
            //
            // It used to `.catch(() => {})` and read nothing back. That was doubly wrong: the client
            // NEVER throws (client-keys.ts acknowledgePosture swallows its own transport and non-2xx
            // cases and resolves { ok: false }), so the catch was dead code AND the one honest signal it
            // does return was discarded. Any failure therefore left the operator believing their choice
            // was recorded when nothing had been written anywhere.
            //
            // The engine refuses an unknown statement version outright, so the window where this fires
            // is exactly a console/engine skew across a statement bump: when losing the record matters
            // most and is least likely to be noticed.
            const engine = getEngine();
            let ackRecorded = true;
            if (engine) {
              const ack = await engine.acknowledgePosture({ posture, statementVersion: stmt.version, acknowledgedText: stmt.text, channel: "onboarding" });
              ackRecorded = ack.ok;
            }
            busyReset();
            // Advisory, so the ceremony still advances. The toast is the honest signal: the choice IS in
            // force (it threads into the ceremony from the store either way); what is missing is the
            // audit record of the words shown.
            if (!ackRecorded) {
              toast({ message: "Your choice is set, but the engine did not record the acknowledgement. Re-affirm it on the Keys screen so the record exists." });
            }
            nav.markPassed();
            nav.advance();
          });
          acceptHost.replaceChildren(
            h("div", { class: "ob-posture-accept" },
              h("p", { class: "ob-posture-accept__statement" }, stmt.text),
              h("label", { class: "ob-posture-accept__check" }, check, h("span", {}, "I have read the implications and understand my choice.")),
              h("div", { style: "margin-top:var(--space-3)" }, confirmBtn),
            ),
          );
        };

        const fork = h("div", { class: "ob-posture-fork" },
          // ORDER IS THE DEFAULT SIGNAL. There is deliberately no pre-selected panel, so in a two-panel fork
          // the one that leads is what a customer reads as recommended. Offline-key-only leads from
          // (H2), and the asymmetry of the mistakes is why: an accidental strict posture is RECOVERABLE, since
          // the Keys screen can add an operational key later without a re-key and without touching the
          // break-glass key. An accidental operational key is NOT, because, as its own acceptance statement
          // says, removing it later does not protect archives already sealed while it was present.
          buildPanel(
            "break-glass-only",
            "Offline key only",
            "Your engine holds no key that can decrypt your archives, so nothing in the platform can read them at rest.",
            [
              "Your engine still checks every run as it seals it, and proves its write-and-restore path hourly with its own test data.",
              "It cannot reopen a run it sealed earlier without you. You prove that at an attended verification, supplying your break-glass key at the time.",
            ],
            () => select("break-glass-only"),
          ),
          buildPanel(
            "operational",
            "Operational key",
            "Your engine also holds an operational key, so it can reopen and restore-test your past runs with nobody present.",
            [
              "It is a secret in your own engine, in your own Cloudflare account, and it can decrypt your stored archives.",
              "If your Cloudflare account is compromised, or a malicious update runs in your engine, your stored archives could be read.",
            ],
            () => select("operational"),
          ),
        );
        body.replaceChildren(fork, learnMore, acceptHost);

        // Re-select a posture already chosen this session (a Back/Forward round-trip), so the acceptance
        // is not silently lost.
        const prior = getPostureChoice();
        if (prior) select(prior);
      };

      // Read the engine status to decide fork vs already-keyed. A fresh engine (or an unreadable status)
      // shows the fork; an engine that already holds a break-glass key shows the fixed-posture message.
      const engine = getEngine();
      if (!engine) { renderFork(); return; }
      void engine.status().then((s) => {
        if (s.breakGlassConfigured) renderAlreadyKeyed(Boolean(s.operationalConfigured?.private));
        else renderFork();
      }).catch(() => renderFork());
    },
    // Rebuild from the live store/status when the operator returns (the deck mounts each card once), so
    // a changed posture choice or a now-provisioned engine is reflected rather than a frozen first render.
    onShow(host, nav) { host.replaceChildren(); this.mount(host, nav); },
  },
  {
    id: "generate", chapter: 1, gate: true, nudge: "Generate your keys to continue.",
    custody: "Generating happens in this browser. Nothing is sent anywhere.",
    mount(host, nav) {
      host.appendChild(cardEyebrow("Your keys"));
      const titleEl = h("h2", { class: "cx-title" }, "Ready when you are");
      const ledeEl = h("p", { class: "cx-lede" }, "We create your keys and download them. Keep ", h("code", { class: "mono" }, "identity.key"), " somewhere safe. It is the one that recovers your backups.");
      host.appendChild(titleEl);
      host.appendChild(ledeEl);

      const progress = h("div", { class: "cx-body", role: "status", "aria-live": "polite" });
      const ownerOk = canDo("owner");
      const generateBtn = h(
        "button",
        { "data-dp": "onboarding.button.generate", class: "btn btn--primary btn--lg", type: "button" },
        svgIcon(ICON_REFRESH, { size: 16 }), "Generate my keys",
      ) as HTMLButtonElement;

      const actions = h("div", { class: "cx-card__actions" });
      actions.appendChild(h("button", { "data-dp": "onboarding.button.back#1", class: "cx-back", type: "button", on: { click: () => nav.back() } }, svgIcon(ICON_CHEVRON_LEFT, { size: 16 }), "Back"));
      actions.appendChild(h("span", { class: "cx-spacer" }));
      actions.appendChild(generateBtn);
      // The forward primary appears once keys exist SOMEWHERE (this tab's ceremony, or a
      // deploy-provisioned engine). When it does it becomes the PROMINENT action and Generate
      // demotes to a quiet "replace" control, so the continue path is never buried (owner: the
      // continue was hidden under "Generate new keys").
      const fwdHost = h("span");
      actions.appendChild(fwdHost);
      const showContinue = (label: string) => {
        nav.markPassed();
        fwdHost.replaceChildren(h("button", { "data-dp": "onboarding.button.advance", class: "btn btn--primary btn--lg", type: "button", on: { click: () => nav.advance() } }, label));
      };

      // The generate handler: mark the attempt, run the in-browser ceremony, save the result, deliver the
      // files, and advance.
      //
      // G046: the intent marker is recorded BEFORE the ceremony runs, not after it succeeds. Taken on
      // success only, it disappeared precisely when support needed it: a ceremony that threw left the audit
      // log identical to one nobody ever started, so "your key ceremony failed" and "you never ran one" were
      // the same evidence. Marking the attempt separates them (an intent event with no keys installed is a
      // ceremony that did not complete), and it costs nothing on the happy path: the same one marker, a
      // moment earlier. It is best-effort and never blocks the ceremony.
      //
      // G077: the file delivery is now checked. The keys exist in this tab whether or not the browser
      // accepted the downloads, so a refusal must NOT be reported as a failed ceremony (it used to throw
      // into the catch below, which said "could not generate keys" about keys that had been generated). A
      // refusal instead names the files that did not arrive and holds the operator on this card with a
      // Continue that leads to the per-file re-download controls.
      const onGenerate = async () => {
        setBusy(generateBtn, true, "Generating in this browser");
        progress.replaceChildren(
          h("span", { class: "status", style: "display:inline-flex;align-items:center;gap:var(--space-2)" },
            h("span", { class: "ob-spinner", "aria-hidden": "true" }),
            h("span", "Generating your keys in this browser. This takes a moment, and nothing is sent anywhere."),
          ),
        );
        recordCeremonyIntent();
        try {
          // The operational key is generated ONLY when the operator explicitly chose it at the fork.
          //
          // The line that used to sit here said the opposite of the line below it and of the code: that "a
          // null choice defaults to the operational key, the automated-proof path". That was true before the
          // H2 default flip and has been wrong since. Removed rather than softened, because a comment that
          // contradicts the statement directly beneath it teaches whichever one the reader stops at, and this
          // one taught the weaker posture as the default.
          //
          // The FALLBACK when no posture was recorded, inverted with the H2 default flip: an absent choice
          // now yields the STRICTER posture rather than the weaker one. Nobody reaches here without an
          // explicit, hash-recorded acceptance in the ordinary flow, so this only governs the odd path (a
          // restored tab, a skipped fork). Falling strict is the safe direction for exactly the reason the
          // panel order comment gives: the strict posture can be relaxed later without a re-key, and the
          // operational one cannot be undone for archives already sealed under it.
          const result = await runKeyCeremony({ operational: getPostureChoice() === "operational" });
          setCeremony(result);
          const refused = downloadCeremonyFiles(result);
          if (refused.length > 0) {
            setBusy(generateBtn, false, "Generate my keys");
            progress.replaceChildren(
              h("p", { class: "field__error" }, `Your keys were created in this browser, but it did not save ${refused.length === 1 ? "one file" : `${refused.length} files`}: ${refused.join(", ")}. Check your browser's download settings, then download each file on the next step.`),
            );
            showContinue("Continue to your files");
            return;
          }
          // G125: the ceremony completed AND every file was saved. Recorded so its absence means something:
          // the FAILURES of this step already have a more specific home (G077's capability-fault, which names
          // the capability, the ceremony and whether the browser lacked it or refused it), so this row is not
          // duplicating them. What it adds is the denominator: a wizard whose generate step never ended `ok`.
          recordOnboardingStep("generate", "ok");
          toast({ message: "Keys generated in this browser. Save identity.key offline." });
          nav.markPassed();
          nav.advance();
        } catch (err) {
          // G077: the ceremony produced NO KEYS. On a locked-down browser (no usable WebCrypto, or one that
          // refuses the generate) this is the end of the road: there is no identity.key to save and nothing
          // taken afterwards could ever be recovered. The message below is for the operator; the pack gets a
          // closed-class row that says which capability failed, on which ceremony, and whether the capability
          // was absent (a plain-http host) or present and refused. The reporter takes no error argument.
          reportKeygenFault("key-ceremony");
          setBusy(generateBtn, false, "Generate my keys");
          progress.replaceChildren(
            h("p", { class: "field__error" }, `Could not generate keys in this browser (${errMessage(err)}). No key left this device.`),
          );
        }
      };

      // Re-run guard: when the engine ALREADY reports a break-glass key (and no in-tab ceremony),
      // generating again makes a NEW set. Warn before Generate, demote Generate to "Generate new
      // keys", and surface a forward "Continue with the existing keys". Same contract as the old step.
      const reframeForExistingKeys = () => {
        const statusEngine = getEngine();
        if (!statusEngine) return;
        void statusEngine.status().then((s) => {
          if (!s.breakGlassConfigured) return;
          // The engine genuinely holds keys: acknowledge setup so the guided checklist reads them as
          // done. This clears the demo first-run marker that "continue with existing keys" would
          // otherwise leave set (it skips /keys/install, the only other path that clears it), which
          // was pinning the Overview checklist at "0 of N". Server-enforced + best-effort.
          void statusEngine.acknowledgeSetup();
          // The engine already holds keys (a deploy-provisioned or resumed engine). Reframe the
          // whole card so the continue path leads and "Generate" becomes a quiet, clearly-labelled
          // replace action rather than the prominent button (owner: the continue was buried).
          titleEl.textContent = "Your keys are already set";
          ledeEl.replaceChildren(document.createTextNode("This engine already holds its keys, so there is nothing to generate. Continue with them, or replace them only if you mean to start over."));
          progress.replaceChildren(
            h("p", { class: "field__hint" }, "A replacement makes a brand-new set that will not match the identity.key or recovery sheet you saved, and you would re-install and re-print."),
          );
          showContinue("Continue with these keys");
          if (generateBtn.dataset.busy !== "true") {
            generateBtn.classList.remove("btn--primary", "btn--lg");
            generateBtn.classList.add("btn--ghost", "btn--sm");
            generateBtn.replaceChildren(svgIcon(ICON_REFRESH, { size: 14 }), document.createTextNode("Replace keys instead"));
          }
        }).catch(() => { /* status unreadable: make no claim */ });
      };

      if (!ownerOk) {
        // This used to write `disabled: true` AND `aria-disabled: "true"` on the same button, which reads
        // as remediated and is not: `disabled` removes the control from the tab order, so the ARIA state
        // was announced to nobody. refuseWithReason keeps it focusable, and the visible hint below stays.
        refuseWithReason(generateBtn, gateReason("owner"));
        progress.appendChild(h("p", { class: "field__hint" }, gateReason("owner")));
      } else {
        generateBtn.addEventListener("click", onGenerate);
      }

      host.appendChild(progress);
      host.appendChild(actions);

      if (getCeremony() === null) {
        reframeForExistingKeys();
      } else {
        // A ceremony already ran in this tab (resumed, or generated then navigated back so onShow rebuilt
        // this card): lead with Continue and demote Generate to a quiet "Replace keys instead", so the card
        // reads as a coherent choice rather than offering to generate keys that already exist, and the
        // in-progress spinner from the run that produced them can never linger here.
        showContinue("Continue to your saved keys");
        if (generateBtn.dataset.busy !== "true") {
          generateBtn.classList.remove("btn--primary", "btn--lg");
          generateBtn.classList.add("btn--ghost", "btn--sm");
          generateBtn.replaceChildren(svgIcon(ICON_REFRESH, { size: 14 }), document.createTextNode("Replace keys instead"));
        }
        progress.replaceChildren(h("p", { class: "field__hint" }, "Keys generated in this browser and downloaded. Continue, or replace them only if you mean to start over (replacing makes a brand-new set that will not match the files you saved)."));
      }
    },
    // The deck mounts each card once and keeps its DOM forever; onShow rebuilds this card from the live
    // store when the operator returns, so the success path's "Generating your keys" spinner can never
    // persist as a frozen state and a replaced ceremony is reflected. A clear + re-mount is safe: mount has
    // no side effect beyond reading the store and a best-effort engine-status read.
    onShow(host, nav) { host.replaceChildren(); this.mount(host, nav); },
  },
  {
    id: "keys-ready", chapter: 1,
    custody: "Generated in your browser. We received nothing.",
    mount(host, nav) {
      const result = getCeremony() as CeremonyResult | null;
      if (!result) {
        // Reached without an in-tab ceremony (a deploy-provisioned engine continued past generate).
        host.appendChild(cardEyebrow("", true));
        host.appendChild(h("h2", { class: "cx-title" }, "Your keys are already in place"));
        host.appendChild(h("p", { class: "cx-lede" }, "This engine already holds its keys, so there is nothing to download here. The next step confirms they are present."));
        host.appendChild(cardActions({ nav, primary: { label: "Continue", onClick: () => nav.advance() } }).row);
        return;
      }

      let custodyMeta: CustodyMetadata = { scheme: "undecided", signoffs: [] };
      host.appendChild(cardEyebrow("", true));
      host.appendChild(h("h2", { class: "cx-title" }, "Your keys are ready"));
      host.appendChild(h("p", { class: "cx-lede", style: "margin-bottom:var(--space-5)" }, "Generated in your browser, and we received nothing. Save ", h("code", { class: "mono" }, "identity.key"), " and ", h("code", { class: "mono" }, "signer.pub"), " offline before you continue: an offline restore needs both."));

      const fileList = h("ul", { class: "ob-filelist" });
      fileList.appendChild(fileRow("identity.key", "Keep offline", "warn", () => downloadText("identity.key", identityFile(result.breakGlass), "key-ceremony"), { keepOffline: true, tip: "Your break-glass key, the only thing that can recover your backups. Save it offline and remove it from this machine." }));
      fileList.appendChild(fileRow("recipient.pub", "To engine", "neutral", () => downloadText("recipient.pub", recipientFile(result.breakGlass), "key-ceremony"), { tip: "The public half of your break-glass key. It cannot read anything; your engine uses it to lock new backups. Installed on the next step." }));
      if (result.operational) {
        fileList.appendChild(fileRow("operational.pub", "To engine", "neutral", () => downloadText("operational.pub", recipientFile(result.operational!), "key-ceremony"), { tip: "The public half of your operational key. Your engine gets it on the next step." }));
      }
      // signer.pub is BOTH: it goes to the engine, and it must also be kept in the offline recovery
      // kit, because downpipe verify and downpipe restore refuse to start without --signer and the
      // signer public key is not stored in the archive. It was badged "To engine" alone, which told a
      // customer it was safe to discard the local copy; anyone who did that kept identity.key and the
      // printed sheet and would then have found they could not restore. It is a PUBLIC key, so keeping
      // it beside the sheet gives an attacker nothing.
      fileList.appendChild(fileRow("signer.pub", "Keep offline too", "warn", () => downloadText("signer.pub", signerPublicFile(result.signer), "key-ceremony"), { keepOffline: true, tip: "The public half of your signing key. Your engine gets it on the next step, AND you keep a copy with identity.key: offline restore refuses to run without it, and it is not stored in your backups. It decrypts nothing, so it is safe to keep with the recovery sheet." }));
      fileList.appendChild(fileRow("signer.key", "To engine", "neutral", () => downloadText("signer.key", signerPrivateFile(result.signer), "key-ceremony"), { tip: "Your signing key. It proves each backup is genuine but cannot read your data. Your engine stores it on the next step." }));
      fileList.appendChild(fileRow("recovery-sheet.txt", "Keep offline", "warn", () => downloadText("recovery-sheet.txt", recoverySheet(result, sheetParams(result, custodyMeta)), "recovery-sheet"), { tip: "A printable record of your public fingerprints, with no secret on it. It is a record, not a key: keep it with identity.key AND signer.pub, which are the two files a restore actually needs." }));
      host.appendChild(h("div", { class: "cx-body" }, fileList));

      // Optional references, folded away (calm density): fingerprints, the printable sheet, and
      // the offline custody menu. These reuse the same helpers the old success step used.
      const fpBody = h("div");
      fpBody.appendChild(h("p", { class: "field__hint", style: "display:flex;align-items:center;gap:var(--space-1);margin-bottom:var(--space-2)" }, "Compare these against the recovery sheet.", infoTip("These are PUBLIC fingerprints, safe to record. They identify each key without revealing it; nothing here can decrypt an archive.", { label: "About the public fingerprints" })));
      const fp = h("div", { class: "fingerprints" });
      fp.appendChild(fpRow("break-glass", result.breakGlass.fingerprint));
      if (result.operational) fp.appendChild(fpRow("operational", result.operational.fingerprint));
      fp.appendChild(fpRow("signer", result.signer.fingerprint));
      fpBody.appendChild(fp);
      host.appendChild(collapsedSection("Verify fingerprints (optional)", fpBody));

      const sheetBtn = h("button", { "data-dp": "onboarding.button.sheet", class: "btn btn--secondary btn--sm", type: "button" }, "Open printable recovery sheet") as HTMLButtonElement;
      sheetBtn.addEventListener("click", () => openRecoverySheetWith(result, custodyMeta));
      const dlSheet = h("button", { "data-dp": "onboarding.button.dl-sheet", class: "btn btn--ghost btn--sm", type: "button" }, "Download recovery-sheet.txt") as HTMLButtonElement;
      dlSheet.addEventListener("click", () => downloadText("recovery-sheet.txt", recoverySheet(result, sheetParams(result, custodyMeta)), "recovery-sheet"));
      host.appendChild(h("div", { class: "ob-actions", style: "margin-top:var(--space-3)" }, sheetBtn, dlSheet));
      // THE SHEET ALREADY ON DISK CANNOT KNOW ABOUT A SCHEME CHOSEN HERE, and nothing used to say so.
      // downloadCeremonyFiles delivered recovery-sheet.txt back at the generate step through
      // sheetParams(result) with NO custody argument, and sheetParams omits the custody block entirely
      // unless a scheme is chosen (./shared.ts), so that saved file records none of this. Choosing a scheme
      // below updates only the in-memory custodyMeta that the re-download and printable-sheet controls above
      // read at click time. A customer who splits their break-glass key into custodian shares and stops there
      // therefore keeps a sheet that says nothing about where those shares went, and discovers it at recovery,
      // which is the one moment the omission cannot be repaired.
      const custodyResave = h("p", { class: "field__hint", role: "status", "aria-live": "polite", hidden: true });

      host.appendChild(
        collapsedSection(
          "Protect your break-glass key (optional)",
          renderCustodyStep({
            result,
            onChange: (meta) => {
              custodyMeta = meta;
              const chosen = meta.scheme !== "undecided";
              custodyResave.hidden = !chosen;
              if (chosen) {
                custodyResave.textContent = "The recovery-sheet.txt you already saved does not record this custody scheme. Download the sheet again above so your offline record says where the shares went.";
              }
            },
            // The "key-ceremony" surface is the client-diag evidence channel for a refused or unavailable
            // download; sendShare is the custody-share email. Both sides are kept.
            downloadText: (name, content) => downloadText(name, content, "key-ceremony"),
            sendShare: (input) => getEngine()?.sendCustodyShare(input) ?? Promise.resolve({ sent: false, reason: "no-engine" }),
          }),
        ),
      );

      host.appendChild(custodyResave);

      host.appendChild(
        cardActions({ nav, primary: { label: "I have saved them", icon: ICON_LOCK, onClick: () => nav.advance() } }).row,
      );
    },
    // Rebuild from the live ceremony result when the operator returns (e.g. after replacing their keys),
    // so the file list and fingerprints reflect the CURRENT keys, not the first set this tab generated.
    onShow(host, nav) { host.replaceChildren(); this.mount(host, nav); },
  },
];
