// The post-apply CONSOLE build check (multi-component updates P5). After a live apply that landed the
// console component, the operator's browser is the real gate (the engine cannot honestly probe a console
// behind Cloudflare Access): this module fetches the origin's own /__build.json (cache: no-store), polls
// briefly and BOUNDEDLY for the new version, and then either prompts the one reload that finishes the
// update, or states honestly that the new console is not being served and offers the one-click console
// rollback, using the one-shot deploy token the calling flow still holds in its local (never stored; it
// dies with the flow's closure). House rules: Australian English, no em dashes, precise claims, no AI
// attribution.

import { h } from "../../lib/dom.ts";
import { goSignedOut } from "../../lib/nav.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { banner } from "../../components/feedback.ts";
import { readServedConsoleVersion, pollForServedVersionRead, type ServedVersionRead } from "../../lib/console-version.ts";
import { recordConsoleBuildCheck, recordConsoleRollback } from "../../lib/client-diag/ring.ts";
import { stashBuildCheck } from "../../lib/client-diag/reload-handoff.ts";
import {
  renderUpdateSteps,
  consoleCheckingLine,
  consoleReloadPromptLine,
  consoleCheckFailedLine,
  consoleRollbackOutcomeLine,
  updateRefusalText,
} from "./shared.ts";
import type { EngineClient } from "../../api.ts";

// The bounded poll: at most CHECK_ATTEMPTS reads, CHECK_DELAY_MS apart (about five seconds end to end), so
// the check can never hang the flow; a slow edge just lands in the honest not-confirmed branch, where the
// operator can wait and reload, or roll back.
const CHECK_ATTEMPTS = 6;
const CHECK_DELAY_MS = 1000;

// ConsoleCheckOpts carries the check's context. token is the SAME one-shot deploy token the apply flow
// holds in its local; it is captured only by the rollback affordance's handler closure, never persisted or
// written anywhere. fetchServedVersion/pollDelayMs are injectable seams for the validators (no network, no
// real clock); production callers omit them.
export interface ConsoleCheckOpts {
  engine: EngineClient;
  out: HTMLElement;
  token: string;
  expectedVersion: string;
  fetchServedVersion?: () => Promise<string | null>;
  pollDelayMs?: number;
  // reload / reloadDelayMs are injectable seams for the validator (production omits them: the real reload
  // is location.reload(), fired after a short beat so the operator sees the success first). Now that the
  // console SPA shell is served no-cache (worker.ts cacheControlFor), an ordinary reload picks up the new
  // build -- no hard refresh -- so the flow finishes ITSELF instead of asking the operator to click.
  reload?: () => void;
  reloadDelayMs?: number;
}

// runConsoleBuildCheck runs the check and renders its outcome into the shared progress region. Returns true
// when the origin was confirmed serving the expected version (the reload prompt is showing), false when it
// was not (the rollback affordance is showing). It never throws for a fetch fault (a fault is just "not
// confirmed"); only the rollback affordance itself can surface an engine refusal, inline.
export async function runConsoleBuildCheck(opts: ConsoleCheckOpts): Promise<boolean> {
  const { engine, out, token, expectedVersion } = opts;
  const checking = h("p", { class: "field__hint", style: "margin-top:var(--space-3)" }, consoleCheckingLine(expectedVersion));
  out.appendChild(checking);

  // The reader. Production uses the CLASSIFYING read, so the pack can say WHICH way the check failed. An
  // injected version-only fetcher (the validators' seam) is adapted to the same shape, and a null from it is
  // reported as `unreachable`: that seam cannot say more, and it is the only caller that cannot.
  const injected = opts.fetchServedVersion;
  const read =
    injected === undefined
      ? (): Promise<ServedVersionRead> => readServedConsoleVersion()
      : async (): Promise<ServedVersionRead> => {
          const version = await injected();
          return version === null ? { version: null, readClass: "unreachable" } : { version, readClass: "ok" };
        };

  const { confirmed, readClass } = await pollForServedVersionRead(expectedVersion, read, CHECK_ATTEMPTS, opts.pollDelayMs ?? CHECK_DELAY_MS);
  checking.remove();

  // THE ONLY WITNESS THAT AN APPLIED CONSOLE UPDATE WAS NEVER SERVED. The engine's update record says the
  // console component applied, and the engine cannot probe a console behind Access to contradict it, so a build
  // check that failed and a tab the operator then closed left the pack asserting a healthy console update with
  // nothing anywhere to the contrary. The class separates the remedies: `wrong-version` is an origin still
  // serving the old assets (a CDN, or an asset deploy that did not land), `non-json` is something else answering
  // on the console's own origin (an Access page reads exactly like this), `unstamped` is a bundle that carries
  // no version at all (which also blinds the update verdict itself), `unreachable` is no answer. `confirmed` is
  // recorded too, so the ABSENCE of a row after an applied console update means something.
  const buildCheckClass = confirmed ? "confirmed" : readClass === "ok" ? "wrong-version" : readClass;
  recordConsoleBuildCheck(buildCheckClass);

  if (confirmed) {
    // AND STASH IT ACROSS THE RELOAD WE ARE ABOUT TO PERFORM. The ring is in-memory, this flow calls
    // location.reload() ~1.5s from now to finish the update, and the reload destroys it. So the `confirmed` row
    // was written and then annihilated on EVERY successful console apply, which made "no console-build-check row"
    // the GUARANTEED state after a healthy update and byte-identical to "the check never ran". The claim that its
    // absence was a fact was false. It is true now: the class crosses the one reload this flow itself triggers,
    // is re-admitted by set membership, and is drained into the fresh ring at boot.
    //
    // Only the confirmed leg stashes. The failure legs do NOT reload, so their rows survive on their own.
    stashBuildCheck(buildCheckClass);
    // The origin serves the new console; the flow FINISHES ITSELF. The shell is served no-cache, so an
    // ordinary reload lands the new build (no hard refresh). Show the calm "reloading" line, offer an
    // immediate "Reload now", and auto-reload after a short beat so the operator sees the success first.
    const doReload = opts.reload ?? ((): void => location.reload());
    out.appendChild(
      banner({
        tone: "info",
        message: consoleReloadPromptLine(expectedVersion),
        action: { label: "Reload now", onClick: () => doReload() },
      }),
    );
    setTimeout(() => doReload(), opts.reloadDelayMs ?? 1500);
    return true;
  }

  // NOT confirmed within the bounded window: honest copy, and the one-click console rollback using the
  // token still held in this call's scope. No confirm dialog here: the flow just applied this update, the
  // copy names exactly what the click does, and this is the recovery direction.
  out.appendChild(
    banner({
      tone: "warn",
      message: consoleCheckFailedLine(expectedVersion),
      action: { label: "Roll back console", onClick: () => void rollbackConsole() },
    }),
  );

  async function rollbackConsole(): Promise<void> {
    const line = h("p", { style: "color:var(--text);margin-top:var(--space-2)" }, "Rolling the console back to its previous version…");
    out.appendChild(line);
    try {
      const res = await engine.rollbackUpdate(token, ["console"]);
      // The rollback ENDED, and this is how. The class is the engine's own outcome vocabulary, so the client
      // row and the engine's rollback record speak one language and can be lined up against each other.
      recordConsoleRollback(res.outcome);
      line.textContent = consoleRollbackOutcomeLine(res);
      out.appendChild(renderUpdateSteps(res.steps));
    } catch (err) {
      if (isUnauthorised(err)) return goSignedOut();
      // The double-fail: the apply landed a console that is not being served, the operator pressed the
      // one recovery this screen offers, and THAT did not come back either. The engine has no rollback record
      // to find (it never received the request, or it refused it), so this row is the only evidence anywhere
      // that a rollback was even attempted from the failed state. The thrown error is never read into it.
      recordConsoleRollback("not-sent");
      line.remove();
      out.appendChild(h("p", { class: "field__error", role: "alert" }, updateRefusalText(err)));
    }
  }
  return false;
}
