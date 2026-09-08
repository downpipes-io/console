// The PLACEHOLDER CUE: a short note pinned under every credential field the course puts in front of a
// learner, saying that any value works here.
//
// WHY IT EXISTS. The course asks for a Cloudflare deploy token, an access key, a secret and a one-shot
// token, on real screens that ask for them exactly as the product does. A learner who does not know the
// console is a replica goes looking for a real Cloudflare account, or stops. The introduction says so and
// the banner says so, and neither is on the screen at the moment the cursor is in the box. This is.
//
// HOW IT ATTACHES. It watches the document and, for every VISIBLE password field (and the token fields the
// course names), appends one small note inside that field's own wrapper. It writes text through the DOM
// builder, never markup, and it adds no data-dp hook and no field: it decorates the console's fields, it
// does not become one, so the field catalogue and the control censuses are untouched by design.
//
// It runs only in training mode, mounted by the training walk. Nothing here is reachable from the genuine
// console, which is why the note can be this blunt.
//
// House rules: Australian English, no em dashes, precise claims.

import { h } from "../../dom.ts";

// The marker that makes the cue idempotent: a field that already carries one is skipped, and a cue whose
// field has left the document is dropped.
const CUE_ATTR = "data-training-cue";

// The note itself. Short, because it sits under a form control that already has a label and a hint.
const CUE_TEXT = "Training replica: type anything. No real credential is needed, and nothing is sent anywhere.";

export interface TrainingFieldCues {
  // Re-scan and attach where needed (the walk calls it on every beat; the observer calls it on DOM changes).
  refresh(): void;
  // Remove every cue and stop watching.
  destroy(): void;
}

// isVisible is the cheap test the rest of the tour chrome uses: an element with no offsetParent is not on
// screen. Guarded for the headless shim, where nothing lays out and everything reports undefined.
function isVisible(el: HTMLElement): boolean {
  if (typeof el.offsetParent === "undefined") return true;
  return el.offsetParent !== null;
}

// credentialFields finds the controls a learner would otherwise try to fill with something real: every
// password input, plus any text input whose hook or name says token. Scoped to the document because the
// course's forms live in the page, in dialogs, and in the onboarding deck, which are three different roots.
function credentialFields(doc: Document): HTMLElement[] {
  let nodes: Element[] = [];
  try {
    nodes = Array.from(doc.querySelectorAll('input[type="password"], input[data-dp*="token"], input[data-dp*="secret"], input[name*="token"]'));
  } catch {
    return [];
  }
  return nodes.filter((n): n is HTMLElement => n instanceof Object && isVisible(n as HTMLElement));
}

export function mountTrainingFieldCues(doc: Document = document): TrainingFieldCues {
  let destroyed = false;

  function refresh(): void {
    if (destroyed) return;
    // Drop cues whose field has gone (a dialog closed, a step moved on).
    for (const stale of Array.from(doc.querySelectorAll(`[${CUE_ATTR}]`))) {
      if (!stale.isConnected || stale.parentElement === null) stale.remove();
    }
    for (const field of credentialFields(doc)) {
      const holder = field.closest(".field") ?? field.parentElement;
      if (!holder || holder.querySelector(`[${CUE_ATTR}]`) !== null) continue;
      holder.appendChild(
        h("p", {
          [CUE_ATTR]: "true",
          style: [
            "margin:var(--space-1) 0 0",
            "font-size:var(--text-xs)",
            "line-height:1.45",
            "color:var(--accent-subtle-fg)",
            "font-weight:var(--weight-medium)",
          ].join(";"),
        }, CUE_TEXT),
      );
    }
  }

  // A debounced observer, because the console re-renders whole screens on navigation and a cue attached to
  // a detached node would be invisible. The debounce keeps a re-render from running the scan per mutation.
  let pending: ReturnType<typeof setTimeout> | null = null;
  const schedule = (): void => {
    if (destroyed || typeof setTimeout !== "function") return;
    if (pending !== null) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      refresh();
    }, 40);
  };
  const MO = (typeof globalThis !== "undefined" ? (globalThis as { MutationObserver?: typeof MutationObserver }).MutationObserver : undefined);
  const observer = typeof MO === "function" ? new MO(schedule) : null;
  // ATTRIBUTES ARE WATCHED, NOT JUST INSERTIONS, and the onboarding deck is why. Its cards are all in the
  // document from the start and are REVEALED by attribute (aria-hidden, style), so a childList-only
  // observer never fires when the card holding the key install appears. The robot learner caught this: two
  // rounds showed a password field with no cue beside it, which is the exact moment a learner would go
  // looking for a real Cloudflare token.
  if (observer && doc.body) {
    observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class", "aria-hidden", "hidden"] });
  }
  refresh();

  return {
    refresh,
    destroy(): void {
      destroyed = true;
      if (pending !== null) {
        clearTimeout(pending);
        pending = null;
      }
      observer?.disconnect();
      for (const cue of Array.from(doc.querySelectorAll(`[${CUE_ATTR}]`))) cue.remove();
    },
  };
}
