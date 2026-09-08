// The Beginner training walk: stand up Downpipes in 30 minutes, hands on, over the demo world.
// The walk is the tour chassis with task
// gates: the world boots at the training-start variant (a fresh account, the setup gate engaged, dual
// control off) and each chapter carries a TASK the learner must actually perform on the real screens; the
// director's grader (a pure predicate over the demo world) is what advances the walk, so progress is
// earned by doing, never by paging. Every task links to the real documentation.
//
// Every chapter carries a GOAL: what this stage is for, and why it comes here. The rail keeps it up for the
// whole stage. It was added after a first learner said the thing this course most needed to hear: "I can't
// tell what I am doing, why I am doing it." The narration answers the second question only if the learner
// reads every beat in order and remembers them; the goal answers it at any moment.
//
// The copy teaches each decision the way the decision catalogue records it: what it means, the
// recommended path, and what the other options translate to. It is written in short sentences on purpose.
// A learner is reading a rail beside a console they are also working, so a sentence they must read twice
// costs them the screen. Credentials here are placeholders and the copy says so plainly: this console is a
// training replica, so any pasted value verifies, and the two sentinel spellings (training-bad-token,
// training-empty-scopes) exist to demonstrate the real refusal and zero-scope paths on request.
//
// House rules: Australian English, no em dashes, no rule-of-three, precise claims.

import { navigate } from "../../../nav.ts";
import { advanceWorldDays, injectRunFailure } from "../../demo-state.ts";
import { applyWorldTransform, world } from "../../demo-world.ts";
import type { TypedTourChapter } from "./chapters.ts";

// anyOkRun reports whether any ring holds a completed run. On the training-start world every ring begins
// empty, so the first ok run anywhere is the learner's own.
function anyOkRun(): boolean {
  return Object.values(world.historyByDownpipe).some((ring) => ring.some((e) => e.status === "ok"));
}

// boundCount is the bound-tier size the attach task grades on (the same sum the derived setup-state fact
// reports).
function boundCount(): number {
  const b = world.sourceDiscovery.bound;
  return b.kv.length + b.r2.length + b.d1.length + b.secrets.length;
}

// The welcome-and-keys chapter: the onboarding deck a fresh account meets, through to the key install.
const welcomeKeysChapter: TypedTourChapter = {
  route: "/onboarding/connect",
  title: "Welcome and keys",
  goal: "Create your keys and install them. Nothing else in the console unlocks until the engine holds keys, so this is where every new account starts.",
  infoPoints: [
    {
      anchor: "onboarding-card",
      title: "This is the real first run",
      body: "You are looking at the Downpipes console, seeded like a brand new account. Nothing is configured. Most of the console is locked until you set it up. The setup deck in front of you is what a new customer sees on day one. Everything you do runs in your browser and resets when you reload, so you cannot break anything.",
    },
    {
      anchor: "onboarding-card",
      title: "The one decision that is hard to reverse",
      body: "The deck asks you to choose a key posture. Both protect your data with the same offline break-glass key. The choice is what your live engine also holds. Offline key only leaves the engine unable to read an archive on its own, so scheduled restore tests and pruning do not run by themselves. You do those with your key present. Operational key lets the engine do them unattended. Starting offline is the safer way round, because you can add an operational key later without a re-key. Read the trade-off at the documentation link on this panel.",
      doc: { href: "https://docs.downpipes.io/concepts/choosing-your-key-posture", label: "Choosing your key posture" },
    },
    {
      anchor: "onboarding-card",
      title: "Work the deck",
      body: "Work the cards in order. Tick the two prerequisites. Choose a posture. Read the acceptance statement and confirm it. Then generate your keys and install them. The install asks for a one-shot deploy token: type anything here. The deck refuses to continue past a gate you have not met, and that refusal is the product's own, not the training's.",
      task: { label: "Work through the setup cards and install your keys", done: () => world.setupState.keysReady },
      doc: { href: "https://docs.downpipes.io/start-here/first-run-and-setup", label: "The guided first run" },
    },
  ],
};

// The first-destination chapter: where backups land, verified before it is stored.
const destinationChapter: TypedTourChapter = {
  route: "/destinations",
  title: "First destination",
  goal: "Save one place for your backups to land. A backup with nowhere to go cannot run, so the destination comes before the data you want to protect.",
  infoPoints: [
    {
      anchor: "destination-form",
      title: "Nothing runs without a destination",
      body: "A destination is the bucket your sealed archives land in. The form asks which provider it is, and Cloudflare R2 leads: its endpoint is derived from your account id and its region is fixed to auto, so there is no region to choose and less to mistype. The other providers ask for every field, including a storage class that trades cost against retrieval speed. The archive tiers are deliberately not offered, because they need a thaw before a read, and the engine reads every archive back as it seals it.",
      doc: { href: "https://docs.downpipes.io/backing-up/choosing-a-destination", label: "Choosing a destination" },
    },
    {
      anchor: "destination-form",
      title: "Verify and save is the only save",
      body: "The console never stores a destination it has not reached. The button reaches the bucket, authenticates, and writes a probe object before anything is kept. Credentials are sent once and never shown again. In this replica the probe always passes. On a real account, a typo in the bucket name fails here, at your desk, and not at 2am.",
    },
    {
      anchor: "destination-form",
      title: "Create yours",
      body: "Fill in the form. Any placeholder works for the credentials. Choose a bucket name you like. Then press Verify and save. WORM object lock is on this form too. Leave it off today: it is a decision with consequences you should read first, and the immutability page carries them.",
      task: { label: "Fill in the form and press Verify and save", done: () => world.destinations.destinations.length > 0 },
      doc: { href: "https://docs.downpipes.io/assurance-audit/immutability-and-attestation", label: "What WORM commits you to" },
    },
  ],
};

// The connect chapter: the two tokens, and why they are different.
const connectChapter: TypedTourChapter = {
  route: "/sources",
  title: "Connect your account",
  goal: "Give Downpipes a read-only token, so it can list what you own. You cannot choose what to protect until the console can see it.",
  infoPoints: [
    {
      anchor: "sources-token-entry",
      title: "Two tokens, two jobs",
      body: "Downpipes stores one read-only discovery token, and uses it to browse what you own. A separate one-shot deploy token is used for the rare change that touches the engine itself. You use that one once, then revoke it. Mint the discovery token as a user token, not an account token: Cloudflare refuses two configuration surfaces to account-owned tokens, whatever permissions they carry.",
      doc: { href: "https://docs.downpipes.io/sources/connect-a-source#the-two-tokens", label: "The two tokens" },
    },
    {
      anchor: "sources-token-entry",
      title: "Paste the read-only token",
      body: "Paste any placeholder value and verify it. On a real account the token is checked against Cloudflare before it is stored. A token that authenticates but sees no accounts gets a warning, not a false success. A refused token stores nothing. This replica can show both failures: paste training-empty-scopes for the zero-accounts warning, or training-bad-token for a refusal.",
      task: { label: "Paste any token, press Verify and save, and see your account appear", done: () => world.sourceDiscovery.tokenPresent && (world.sourceDiscovery.accounts?.length ?? 0) > 0 },
      doc: { href: "https://docs.downpipes.io/operations/cloudflare-token-scopes", label: "Token scopes" },
    },
  ],
};

// The pick-what-to-protect chapter: the four binding stores need no token at all.
const sourcesChapter: TypedTourChapter = {
  route: "/sources",
  title: "Pick what to protect",
  goal: "Attach your first source. The engine can only back up what it is bound to, and it holds no bindings yet.",
  infoPoints: [
    {
      anchor: "sources-add",
      title: "Bindings, not credentials",
      body: "KV namespaces, R2 buckets, D1 databases and Secrets Store need no token at all. The engine reaches them through its own bindings. Attaching one is a single change the engine makes to itself. It then re-reads its bindings and proves that none of its own changed. That re-read is the attach safety harness, and it is why the attach asks for a one-shot deploy token.",
      doc: { href: "https://docs.downpipes.io/sources/connect-a-source#the-attach-safety-harness", label: "The attach safety harness" },
    },
    {
      anchor: "sources-add",
      title: "Attach your first source",
      body: "Press Add a source. Pick one of the KV namespaces discovery found. Attach it, with any placeholder as the one-shot token. The narration on that screen is the product's own: the token is used once for this single change, it is never stored, and you revoke it afterwards.",
      task: { label: "Press Add a source and attach a binding", done: () => boundCount() > 0 },
      doc: { href: "https://docs.downpipes.io/sources/overview#the-eight-source-types", label: "The source types" },
    },
  ],
};

// The first-downpipe chapter: source, destination, schedule.
const downpipeChapter: TypedTourChapter = {
  route: "/downpipes",
  title: "First downpipe",
  goal: "Join the parts into one backup route: a source, a destination, and a schedule. Until a downpipe exists, nothing is scheduled to run.",
  infoPoints: [
    {
      anchor: "downpipes-empty",
      title: "A downpipe is a backup route",
      body: "One source, one or more destinations, and a schedule. Daily is the recommended cadence for most stores. Hourly is the fastest offered, and every dispatch rides a fifteen-minute engine tick either way. Retention starts as report-only: the engine computes what a prune would delete, and deletes nothing until you arm enforcement yourself. This course leaves it that way.",
      doc: { href: "https://docs.downpipes.io/backing-up/overview#what-a-downpipe-is", label: "What a downpipe is" },
    },
    {
      anchor: "downpipes-empty",
      title: "Create it",
      body: "Press New downpipe. The wizard lists what you attached, confirms the destination you verified, and asks for a name and a cadence. Choose daily and keep the defaults. The wizard invents nothing you did not choose.",
      task: { label: "Press New downpipe and create your first one", done: () => world.downpipes.length > 0 },
      doc: { href: "https://docs.downpipes.io/backing-up/overview#the-fifteen-minute-floor", label: "Schedules and the floor" },
    },
  ],
};

// The run-it chapter: trigger, refresh, read.
const firstRunChapter: TypedTourChapter = {
  route: "/downpipes",
  title: "Run it and read it",
  goal: "Run the backup now, and read what it wrote. A schedule you have never watched run is a promise, not a backup.",
  infoPoints: [
    {
      anchor: "dp-name",
      title: "Run it now",
      body: "Open your downpipe and press Run now. A run seals your source into an archive, then verifies what it wrote before it reports success. The Runs screen does not poll in the background, by design, so there you refresh to watch a run move from Running to done. The downpipes screen you are on now refreshes itself.",
      task: { label: "Open your downpipe, press Run now, and wait for it to finish", done: anyOkRun },
      doc: { href: "https://docs.downpipes.io/day-2/runs-and-history#the-per-run-detail", label: "Reading a run" },
    },
    {
      anchor: "dp-coverage",
      title: "What just happened",
      body: "The run's row now carries its counts: records sealed, bytes written, and the destination it sealed to. Your Overview has come alive as well. With every setup step done, the full dashboard paints instead of the checklist. That change is derived from the facts, not from a wizard position, and the console re-reads those facts every time.",
      doc: { href: "https://docs.downpipes.io/start-here/first-run-and-setup", label: "Setup progress is derived" },
    },
  ],
};

// The month-later chapter: the time jump, a failure to diagnose, and the rerun.
const failureChapter: TypedTourChapter = {
  route: "/runs",
  title: "A month later",
  goal: "Diagnose a failed backup and put it right. This is the commonest day-two job, so the course jumps a month forward to give you one to practise on.",
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
      body: "The course just advanced the world by a month. Your downpipe ran daily, and the history behind this screen grew accordingly. It also added the thing you are here to learn: the newest run failed. The Runs view sorts worst first on purpose, so an operator sees a failure straight away instead of hunting for it under a page of green.",
    },
    {
      anchor: "run-failure",
      title: "A failure names its cause",
      body: "The verdict gives a plain, recoverable reason, never a stack trace. Read which side it names, because that is the first fork in any diagnosis. This one is a destination reason: the bucket refused a list during the check that runs before sealing, so nothing was written on this run. A destination reason means your source is fine and the archive location is not. A source reason would mean the opposite. Your earlier backups are untouched either way.",
      doc: { href: "https://docs.downpipes.io/day-2/a-backup-run-failed", label: "A backup run failed" },
    },
    {
      anchor: "run-failure",
      title: "Fix the cause, not the symptom",
      body: "A rerun into the same refusal produces the same red row, so on a real account you fix the cause first. Access denied means the request reached the bucket and was refused there: usually a policy that no longer allows what the engine needs, or a key scoped to a different bucket. The linked page names each cause and its fix. Then, in Destinations, press Replace on that destination and Verify and save. That reaches the bucket again and proves the fix at your desk, and it is where a replacement key goes.",
      doc: { href: "https://docs.downpipes.io/reference/troubleshooting", label: "Causes and their fixes" },
    },
    {
      anchor: "run-open-downpipe",
      title: "Rerun it",
      body: "In this replica the cause is already cleared, so the rerun is the part you practise. Open the downpipe, press Run now, and watch the fresh run settle clean over the failure. The failed row stays in the history. That is an honest record, not an embarrassment to be swept away.",
      task: {
        label: "Open the downpipe, rerun it, and watch it settle clean",
        done: () => Object.values(world.historyByDownpipe).some((ring) => ring[0]?.status === "ok" && ring.some((e) => e.status === "failed")),
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
      body: "You stood up Downpipes the way a real operator does. Keys and posture first. Then a verified destination, a read-only connect, an attached source, a scheduled downpipe, a completed run, and a failure you diagnosed and reran. This is the only course written so far. What would come next is already documented: a second destination for redundancy, retention you arm yourself, notifications, and restore end to end.",
      doc: { href: "https://docs.downpipes.io/start-here/quickstart", label: "The quickstart, for the real thing" },
    },
  ],
  ctaLead: "This replica ran entirely in your browser and resets on reload. When you are ready to do it for real, the quickstart walks the same path against your own Cloudflare account.",
  ctas: [
    { label: "Do it for real: the quickstart", href: "https://docs.downpipes.io/start-here/quickstart", kind: "training-quickstart", primary: true },
    { label: "About Downpipes", href: "https://downpipes.io", kind: "training-site" },
  ],
};

// TRAINING_BEGINNER is the walk the training launcher hands the director: the 30-minute standup path,
// task-gated end to end.
export const TRAINING_BEGINNER: ReadonlyArray<TypedTourChapter> = [
  welcomeKeysChapter,
  destinationChapter,
  connectChapter,
  sourcesChapter,
  downpipeChapter,
  firstRunChapter,
  failureChapter,
  wrapChapter,
];
