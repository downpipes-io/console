// The Beginner training walk: stand up Downpipes in 30 minutes, hands on, over the demo world.
// The walk is the tour chassis with task gates: the world boots at the training-start variant (a fresh
// account, the setup gate engaged, dual control off). Three chapters carry a TASK the learner must actually
// perform on the real screens: setup itself, a run started by hand, and the month-later failure. The
// director's grader (a pure predicate over the demo world) is what advances past a task, so progress there is
// earned by doing, never by paging. Setup does the work of the four chapters after it (the token, the
// destination, the sources and the downpipe), so those chapters show where each part lives now and ask the
// learner to do nothing. Every task links to the real documentation.
//
// Every chapter carries a GOAL: what this stage is for, and why it comes here. The rail keeps it up for the
// whole stage, because the narration answers "why am I doing this" only if the learner reads every beat in
// order and remembers them; the goal answers it at any moment.
//
// The copy teaches each decision the way the decision catalogue records it: what it means, the
// recommended path, and what the other options translate to. It is written in short sentences on purpose.
// A learner is reading a rail beside a console they are also working, so a sentence they must read twice
// costs them the screen. Credentials here are placeholders and the copy says so plainly: this console is a
// training replica, so any pasted value verifies. The course names one sentinel spelling, training-bad-token,
// which answers with the engine's own refusal. The replica's zero-account sentinel is not taught: the real
// engine refuses a token that sees no account, so a stored zero-account token is not a state a learner meets.

import { navigate } from "../../../nav.ts";
import { advanceWorldDays, injectRunFailure } from "../../demo-state.ts";
import { applyWorldTransform, world } from "../../demo-world.ts";
import type { TypedTourChapter } from "./chapters.ts";

// anyOkRun reports whether any ring holds a completed run. On the training-start world every ring begins
// empty, so the first ok run anywhere is the one setup ran.
function anyOkRun(): boolean {
  return Object.values(world.historyByDownpipe).some((ring) => ring.some((e) => e.status === "ok"));
}

// secondOkRun reports whether one downpipe's ring holds two completed runs: setup's first backup, then the
// run the learner starts on the Downpipes screen.
function secondOkRun(): boolean {
  return Object.values(world.historyByDownpipe).some((ring) => ring.filter((e) => e.status === "ok").length >= 2);
}

// The first-run chapter: the setup surface a fresh account meets, from the read-only token to a sealed first
// backup. Setup asks one question at a time and fills in "Your backup plan" beside it. Setup does the work of
// the next four chapters, so those chapters show where each part lives after setup, on the ordinary screens,
// and ask the learner to do nothing there.
const setupChapter: TypedTourChapter = {
  route: "/setup",
  title: "Set up",
  goal: "Set up the account, from a read-only token to a first backup. Setup locks most screens and unlocks each one at the step that uses it, so every new account starts here.",
  infoPoints: [
    {
      anchor: "setup-stage",
      title: "This is the real first run",
      body: "This is the downpipes console on a new account, with nothing set up. Setup asks one question at a time, and your backup plan fills in as you answer. Most screens stay locked until setup reaches the step that uses them. Everything happens in your browser, and a reload starts again. You cannot break anything.",
    },
    {
      anchor: "setup-stage",
      title: "The one decision that is hard to reverse",
      body: "Setup asks you to choose a key posture, and it has no default. In both postures, your offline key opens every backup. The postures differ in what the engine also holds. With Offline key only, no key in the engine opens an archive, so you do restore tests and pruning by hand. With Operational key, the engine does both on a schedule. An operational key that you add later opens only the backups sealed after you add it.",
      doc: { href: "https://docs.downpipes.io/concepts/choosing-your-key-posture", label: "Choosing your key posture" },
    },
    {
      anchor: "setup-stage",
      title: "Work through setup",
      body: "Answer each question in order. Type any value where setup asks for a token or a key. Setup asks about your Cloudflare account first, and then about where your backups land. Next, it asks what to protect and who can decrypt your backups. Then you keep your offline key safe and apply your setup with one deploy token. Last, you revoke that token and start your first backup.",
      task: { label: "Work through setup until your first backup has run", done: anyOkRun },
      doc: { href: "https://docs.downpipes.io/start-here/first-run-and-setup", label: "The guided first run" },
    },
    {
      anchor: "setup-stage",
      title: "Read the receipt",
      body: "Setup ends on a receipt. It lists each decision that you made and any step that is still open. A sealed backup is not yet a proven restore, and the receipt says so. To read the receipt, press See your receipt. To stay on it, press Pause. The next four stages show where each part of setup lives now.",
    },
  ],
};

// The connect chapter: where the read-only token lives after setup, and why it is not the deploy token.
const connectChapter: TypedTourChapter = {
  route: "/sources",
  title: "Your account connection",
  goal: "See where the read-only token lives now. You pasted it at setup's first question. From here on, Sources is where you replace it or choose which accounts it browses.",
  infoPoints: [
    {
      anchor: "sources-token-status",
      title: "Two tokens, two jobs",
      body: "Your engine stores one read-only token. It lists what you own with this token. It also reads your Cloudflare configuration, Workers, Stream and Images sources with it. This line shows that the token is on, and how many accounts it browses. The deploy token at Apply had a different job: the engine used it once to change itself, and did not keep it. Make the read-only token as a user token, because Cloudflare refuses two configuration surfaces to an account token.",
      doc: { href: "https://docs.downpipes.io/sources/connect-a-source#the-two-tokens", label: "The two tokens" },
    },
    {
      anchor: "sources-token-status",
      title: "Replacing it later",
      body: "Under Replace the token, Verify and replace runs the same check that setup ran. The engine checks the token with Cloudflare before it keeps it. If Cloudflare refuses the token, or the token sees no account, the engine refuses it and keeps nothing. It also refuses a token with no expiry, or with an expiry more than 90 days away. To see a refusal in this replica, paste training-bad-token.",
      doc: { href: "https://docs.downpipes.io/operations/cloudflare-token-scopes", label: "Token scopes" },
    },
  ],
};

// The destination chapter: where backups land, and why setup saved it only after reaching it.
const destinationChapter: TypedTourChapter = {
  route: "/destinations",
  title: "Your destination",
  goal: "See where your backups land. Setup saved the destination only after the engine reached it. This screen is where you add a second destination or replace a key.",
  infoPoints: [
    {
      anchor: "destination-saved",
      title: "Nothing runs without a destination",
      body: "A destination is the bucket that holds your sealed archives. Setup shows Cloudflare R2 first. R2 gets its endpoint from your account ID and uses the region auto, so you type less. Google Cloud has a fixed endpoint, and Azure Blob has no region field. Only S3-compatible offers a storage class, under Change, and it starts at Bucket default. Setup does not offer the archive tiers, because they need a thaw before a read.",
      doc: { href: "https://docs.downpipes.io/backing-up/choosing-a-destination", label: "Choosing a destination" },
    },
    {
      anchor: "destination-saved",
      title: "Verify and save is the only save",
      body: "The engine never keeps a destination that it has not reached. At Verify and save, the engine checks that it can read your bucket. Then it writes a test file to the bucket and tries to delete it. When you add or replace a destination here, it does the same check. The console does not show the key again after you save it. On a real account, a wrong bucket name fails here, before a backup depends on it. In this replica, the check always passes.",
    },
    {
      anchor: "destination-saved",
      title: "Object lock is a separate decision",
      body: "For R2, setup shows the object lock modes on the access key question. R2 cannot enforce object lock, so Governance and Compliance show as unavailable, with the reason on each. For the other providers, setup asks about object lock on a question of its own. You cannot undo Compliance mode, so read the immutability page before you turn object lock on.",
      doc: { href: "https://docs.downpipes.io/assurance-audit/immutability-and-attestation", label: "What WORM commits you to" },
    },
  ],
};

// The sources chapter: what setup attached, and how to add more.
const sourcesChapter: TypedTourChapter = {
  route: "/sources",
  title: "What you protect",
  goal: "See what setup protects. The engine reads some sources through its own bindings and some with the read-only token. This is where you add more.",
  infoPoints: [
    {
      anchor: "sources-protected",
      title: "Bindings, not credentials",
      body: "The engine reads KV namespaces, R2 buckets, D1 databases and Secrets Store through its own bindings, so it needs no token to read them. To add a binding, the engine changes its own settings, and that change needs the deploy token. At Apply, the engine first proved that the change keeps every binding it already has. After the change, it read its bindings again and confirmed that each one is still there. That is the attach safety harness.",
      doc: { href: "https://docs.downpipes.io/sources/connect-a-source#the-attach-safety-harness", label: "The attach safety harness" },
    },
    {
      anchor: "sources-add",
      title: "Adding a source later",
      body: "Add a source opens a picker for the sources that you did not pick at setup. A source that needs a new binding also needs a deploy token. The engine uses that token once for the change and does not keep it. After the change, revoke the token in Cloudflare.",
      doc: { href: "https://docs.downpipes.io/sources/overview#the-eight-source-types", label: "The source types" },
    },
  ],
};

// The downpipe chapter: the backup route setup made.
const downpipeChapter: TypedTourChapter = {
  route: "/downpipes",
  title: "Your downpipe",
  goal: "See the backup routes that setup made from your picks. This is where you change a route or add another.",
  infoPoints: [
    {
      anchor: "dp-schedule",
      title: "A downpipe is a backup route",
      body: "A downpipe sends one source to one or more destinations on a schedule. Setup made your downpipes from your picks, on the schedule that you chose. Setup recommends Daily. The downpipe editor also accepts a cron expression under Advanced schedule. The engine checks its schedules every fifteen minutes, so no schedule fires more often than that. Run now does not wait for the schedule.",
      doc: { href: "https://docs.downpipes.io/backing-up/overview#what-a-downpipe-is", label: "What a downpipe is" },
    },
    {
      anchor: "dp-name",
      title: "Changing it later",
      body: "Open a downpipe to change its schedule, its retention or its destinations. The retention that setup chooses by default, Keep every run, deletes nothing. The 90-day and 365-day choices delete old backups on the schedule. A custom limit in the editor deletes only when you turn on Enforce deletion. Deletion in the engine needs the operational key. New downpipe adds another route, for a source that you attach later.",
      doc: { href: "https://docs.downpipes.io/backing-up/overview#the-fifteen-minute-floor", label: "Schedules and the floor" },
    },
  ],
};

// The run-it chapter: run it again by hand, and read what it wrote.
const firstRunChapter: TypedTourChapter = {
  route: "/downpipes",
  title: "Run it and read it",
  goal: "Start a backup yourself, and read what it wrote. You then see the route work, not only its schedule.",
  infoPoints: [
    {
      anchor: "dp-name",
      title: "Run it now",
      body: "Setup started your first backup. Now start one yourself. The engine seals your source into an archive and writes it to your destination. This Downpipes screen refreshes by itself, so you see the backup finish here. The Runs screen does not refresh by itself. On that screen, refresh the page to see a new status.",
      task: { label: "Open your downpipe and press Run now", done: secondOkRun },
      doc: { href: "https://docs.downpipes.io/day-2/runs-and-history#the-per-run-detail", label: "Reading a run" },
    },
    {
      anchor: "dp-coverage",
      title: "What just happened",
      body: "The Last run column now shows your new backup. The Coverage column shows what this downpipe has proven so far. A sealed backup is not yet a proven restore, so the cell reads Backed up, unproven, until a restore test passes. Overview counts it the same way. Both screens read the engine's own records each time. The Runs screen shows the record count and the archive size of each backup.",
      doc: { href: "https://docs.downpipes.io/start-here/first-run-and-setup", label: "Setup progress is derived" },
    },
  ],
};

// The month-later chapter: the time jump, a failure to diagnose, and the rerun.
const failureChapter: TypedTourChapter = {
  route: "/runs",
  title: "A month later",
  goal: "Diagnose a failed backup and put it right. The course moves the clock forward a month and gives you a failed backup to practise on.",
  worldTransform: () => {
    applyWorldTransform((w) => injectRunFailure(advanceWorldDays(w, 30)));
  },
  preAction: () => {
    // Deep-link the failed run's own drawer (the runs screen auto-opens it when the route names a
    // downpipe/index pair), so the chapter narrates over the failure verdict itself.
    const dp = world.downpipes[0];
    if (dp === undefined) return;
    const head = world.historyByDownpipe[dp.config.id]?.[0];
    if (head === undefined) return;
    navigate(`/runs/${dp.config.id}/${head.index}`);
  },
  infoPoints: [
    {
      anchor: "run-status",
      title: "Thirty days have passed",
      body: "The course moved the clock forward 30 days. The replica added one completed backup a day to each downpipe, whatever its schedule. The newest backup on your first downpipe failed, and the course opened it for you. The Runs table shows the newest first. To show failures first, sort by the Status column.",
    },
    {
      anchor: "run-failure",
      title: "A failure names its cause",
      body: "The verdict gives a short reason from a fixed list, never a stack trace. First, find which side the reason names. This reason names the destination: the bucket refused the engine's write with AccessDenied. A destination reason means that your source is fine and the archive location is not. A source reason means the opposite. A failed backup does not change your earlier backups.",
      doc: { href: "https://docs.downpipes.io/day-2/a-backup-run-failed", label: "A backup run failed" },
    },
    {
      anchor: "run-failure",
      title: "Fix the cause, not the symptom",
      body: "A new backup into the same refusal fails the same way, so fix the cause first. AccessDenied means that the bucket got the request and refused it. Two possible causes are a bucket policy that no longer allows what the engine needs, and a key for a different bucket. Then, on Destinations, press Replace on that destination. If you need a new key, type it there. Then press Verify and save.",
      doc: { href: "https://docs.downpipes.io/reference/troubleshooting", label: "Causes and their fixes" },
    },
    {
      anchor: "run-open-downpipe",
      title: "Rerun it",
      body: "In this replica, the bucket now accepts the write, so you practise the new backup only. When the new backup completes, it goes to the top of the history. The failed row stays in the history below it.",
      task: {
        label: "Open the downpipe and press Run now again",
        // Done once an ok run is NEWER than the failed one. A later Run now puts a new in-flight run on top, and
        // that must not undo a finished step.
        done: () => Object.values(world.historyByDownpipe).some(rerunSucceeded),
      },
      doc: { href: "https://docs.downpipes.io/day-2/a-backup-run-failed", label: "A backup run failed" },
    },
  ],
};

// The wrap chapter: what you can now do, and where the documentation carries it further.
const wrapChapter: TypedTourChapter = {
  route: "/",
  title: "You can run this",
  goal: "See what you built, and where to go next.",
  infoPoints: [
    {
      anchor: "overview-fleet-health",
      title: "What you just did",
      body: "You set up downpipes from nothing. Setup took you from a read-only token to a sealed first backup. You then saw where each part of setup lives, and you found the cause of a failed backup. The documentation covers the next steps: a second destination, retention that deletes old backups, notifications, and a full restore. The quickstart starts after you deploy downpipes into your own Cloudflare account.",
      doc: { href: "https://docs.downpipes.io/start-here/quickstart", label: "The quickstart, after the deploy" },
    },
  ],
  ctaLead: "This course ran in your browser, and a reload starts it again. To do it for real, first deploy downpipes into your own Cloudflare account. The quickstart then takes you through the same setup.",
  ctas: [
    { label: "Deploy it in your own Cloudflare", href: "https://downpipes.io/deploy", kind: "training-deploy", primary: true },
  ],
};

// TRAINING_BEGINNER is the walk the training launcher hands the director: the 30-minute standup path,
// task-gated end to end.
// rerunSucceeded reports whether a ring holds a failed run with a newer ok run above it (the ring is newest first).
export function rerunSucceeded(ring: ReadonlyArray<{ status: string }>): boolean {
  const okAt = ring.findIndex((e) => e.status === "ok");
  const failedAt = ring.findIndex((e) => e.status === "failed");
  return okAt !== -1 && failedAt !== -1 && okAt < failedAt;
}

export const TRAINING_BEGINNER: ReadonlyArray<TypedTourChapter> = [
  setupChapter,
  connectChapter,
  destinationChapter,
  sourcesChapter,
  downpipeChapter,
  firstRunChapter,
  failureChapter,
  wrapChapter,
];
