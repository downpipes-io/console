// Focus Flow questions for step 2, Destination: provider, bucket, lock, credentials (Verify and save runs
// the live probe) and storage prices. The lock question comes BEFORE the credentials for S3, Google Cloud
// and Azure, so the secret is typed on the view that saves it and never has to outlive that view. R2 folds
// the lock into the credentials view as a fixed line (R2 cannot lock objects).

import { wholeNumberBetween } from "../../../components/field-bounds.ts";
import type { Provider } from "../../../lib/api/types/destinations.ts";
import { h } from "../../../lib/dom.ts";
import { ICON_LOCK, ICON_SHIELD_CHECK } from "../../../lib/icons.ts";
import {
  ADDRESSING_CHOICES, ENTRA_FIELDS, type ImmutabilityMode, immutabilityChoices, PROVIDERS_INFO, pricingDefaults,type SetupSnapshot,STORAGE_CLASS_CHOICES, STS_FIELDS, 
  saveDestination, setupModel, 
} from "../../../lib/setup-flow/index.ts";
import { saveAnswer, stepDone } from "./flow.ts";
import { CF_R2_TOKENS, externalLink, type Field, field, line, message, openSheet, textButton, tileGroup } from "./kit.ts";
import type { QCtx, QId, QView } from "./types.ts";

const PROVIDER_LINES: Record<Provider, string[]> = {
  r2: ["Your engine's Cloudflare account, unless you name another.", "Cannot lock objects."],
  s3: ["Off your Cloudflare account.", "Can lock objects with Object Lock."],
  gcs: ["Off your Cloudflare account.", "Can lock objects with retention."],
  azure: ["Off your Cloudflare account.", "Can lock objects with immutability."],
};
const LOCK_PREREQ: Record<Provider, string> = {
  r2: "R2 cannot lock objects. Pick another provider to use a lock.",
  s3: "The bucket must have been created with Object Lock. You cannot add it later.",
  gcs: "The bucket must have been created with per-object retention. You cannot add it later.",
  azure: "The container needs version-level immutability. You can turn it on in Azure at any time.",
};

// After the destination is saved, a CHANGED answer needs a new Verify and save, so the question then leads
// to the next one in the step instead of skipping past a saved step. An unchanged answer just goes back.
function onward(c: QCtx, s: SetupSnapshot, nextInStep: QId, changed: boolean): void {
  if (changed && stepDone(s, "destination")) c.go(nextInStep, { ret: c.ret });
  else c.next();
}

// ---- Provider ---------------------------------------------------------------------------------------------------

export function provider(c: QCtx): QView {
  const m = setupModel();
  const tiles = tileGroup<Provider>({
    name: "provider",
    labelledBy: "fb-h1",
    choices: PROVIDERS_INFO.map((p) => ({ id: p.id, label: p.label, lines: PROVIDER_LINES[p.id] })),
    selected: c.s.draft.provider,
    columns: 2,
  });
  return {
    title: "Where should your backups land?",
    lede: ["You can add more after setup."],
    body: [tiles.el],
    primary: {
      label: "Continue",
      reason: () => null,
      run: () => {
        const id = tiles.value() ?? "r2";
        const d = m.get().draft;
        const changed = id !== d.provider;
        if (changed) {
          m.update({ provider: id, immutability: "off", immutabilityDays: "", bucket: "", bucketTyped: false, otherAccount: false, endpoint: id === "gcs" ? "https://storage.googleapis.com" : "", region: "auto", pricing: null });
          saveAnswer("lock", false);
        }
        c.flight(tiles.chosenTitle(), "provider");
        c.answer("provider");
        onward(c, m.get(), "bucket", changed);
      },
    },
  };
}

// ---- Bucket -----------------------------------------------------------------------------------------------------

export function bucket(c: QCtx): QView {
  const m = setupModel();
  const s = c.s;
  const d = s.draft;
  if (d.provider !== "r2") return bucketOther(c);
  const acct = s.facts.accounts.find((a) => a.isEngineAccount)?.name ?? s.facts.accounts[0]?.name ?? "your account";
  const listed = s.facts.engineR2Buckets;
  const needAcct = s.facts.engineAccountId === null;
  const typed = field({ id: "setup-r2-bucket", label: "Bucket name", value: d.bucketTyped && !d.otherAccount ? d.bucket : "", placeholder: "backups-archive", doc: { href: "https://docs.downpipes.io/backing-up/choosing-a-destination", anchor: "r2-s3-compatible-google-cloud-or-azure-blob" } });
  const otherAcct = field({ id: "setup-r2-account-id", label: "Account ID", value: d.r2AccountId, placeholder: "0f2ac7c1b6e0470a9d3c5e8b1f4a7c20", hint: "32 characters, from the account's R2 overview.", validate: accountIdRule, doc: { href: "https://docs.downpipes.io/backing-up/multiple-destinations", anchor: "putting-an-r2-bucket-in-a-different-cloudflare-account" } });
  const otherName = field({ id: "setup-r2-other-bucket", label: "Bucket name", value: d.otherAccount ? d.bucket : "", placeholder: "backups-archive", doc: { href: "https://docs.downpipes.io/backing-up/multiple-destinations", anchor: "putting-an-r2-bucket-in-a-different-cloudflare-account" } });
  const label = field({ id: "setup-r2-label", label: "Name in downpipes (optional)", value: d.label, placeholder: "Primary archive", doc: { href: "https://docs.downpipes.io/backing-up/multiple-destinations", anchor: "naming-a-destination" } });
  const typedTile = { id: "__typed", label: "Type a bucket name", lines: [] as string[], extra: () => h("div", { class: "fb-extra" }, typed.el, needAcct ? otherAcct.el : null) };
  const otherTile = { id: "__other", label: "Use a bucket in another account", lines: ["The endpoint comes from the account ID."], extra: () => h("div", { class: "fb-extra" }, otherAcct.el, otherName.el) };
  const sel = d.otherAccount ? "__other" : d.bucketTyped || listed.length === 0 ? "__typed" : d.bucket !== "" && listed.includes(d.bucket) ? d.bucket : null;
  const tiles = tileGroup<string>({
    name: "bucket",
    labelledBy: "fb-h1",
    choices: [...listed.map((b) => ({ id: b, label: b, lines: [] as string[] })), typedTile, otherTile],
    selected: sel,
    columns: 2,
  });
  return {
    title: "Which bucket should hold your backups?",
    lede: [listed.length > 0 ? `These R2 buckets are in ${acct}. Pick one that holds nothing else.` : "Your buckets appear here after the token. You can type a bucket name now."],
    body: [tiles.el, label.el],
    primary: {
      label: "Continue",
      run: () => {
        const v = tiles.value();
        const before = JSON.stringify([m.get().draft.bucket, m.get().draft.otherAccount, m.get().draft.r2AccountId]);
        for (const f of [typed, otherAcct, otherName]) f.setError(null);
        if (v === null) return tiles.setError("Pick a bucket, or type its name.");
        if (v === "__typed") {
          if (typed.input.value.trim() === "") return focusErr(typed, "Type the bucket name.");
          if (needAcct && otherAcct.check() !== null) return otherAcct.input.focus();
          m.update({ bucket: typed.input.value.trim(), bucketTyped: true, otherAccount: false, ...(needAcct ? { r2AccountId: otherAcct.input.value.trim() } : {}) });
        } else if (v === "__other") {
          if (otherAcct.check() !== null) return otherAcct.input.focus();
          if (otherName.input.value.trim() === "") return focusErr(otherName, "Type the bucket name.");
          m.update({ bucket: otherName.input.value.trim(), bucketTyped: true, otherAccount: true, r2AccountId: otherAcct.input.value.trim() });
        } else m.update({ bucket: v, bucketTyped: false, otherAccount: false });
        m.update({ label: label.input.value.trim() });
        c.flight(v.startsWith("__") ? null : tiles.chosenTitle(), "bucket");
        onward(c, m.get(), "credentials", before !== JSON.stringify([m.get().draft.bucket, m.get().draft.otherAccount, m.get().draft.r2AccountId]));
      },
    },
  };
}

function focusErr(f: Field, msg: string): void {
  f.setError(msg);
  f.input.focus();
}

// The field rules each question runs when it commits (kit.ts field validate, through check()).
const accountIdRule = (v: string): string | null => (/^[0-9a-f]{32}$/.test(v.trim()) ? null : "An account ID has 32 characters, 0 to 9 and a to f.");
const lockDaysRule = (v: string): string | null => (/^[1-9]\d*$/.test(v.trim()) ? null : "Type a whole number of days, 1 or more.");
const priceRule = (v: string): string | null => (v.trim() !== "" && Number.isFinite(Number(v)) && Number(v) >= 0 ? null : "Type a price of 0 or more.");
// The same bound, words and remedy as the Destinations form's field (destination-form-fields.ts buildStsBlock);
// destination-submit.ts parseAssumeRolePolicy refuses the same values again at save.
const stsDurationRule = wholeNumberBetween({ noun: "The session duration", min: 900, max: 43200, unit: "seconds", remedy: "Type a duration in that range, or leave it blank for the default of 3600." });

function bucketOther(c: QCtx): QView {
  const m = setupModel();
  const d = c.s.draft;
  const gcs = d.provider === "gcs";
  const azure = d.provider === "azure";
  const endpoint = field({ id: "setup-dest-endpoint", label: azure ? "Blob endpoint" : "Endpoint", type: "url", value: gcs ? "https://storage.googleapis.com" : d.endpoint, placeholder: azure ? "https://mystorageaccount.blob.core.windows.net" : "https://s3.example.com", doc: { href: "https://docs.downpipes.io/day-2/data-residency", anchor: "you-choose-the-destination-the-engine-reports-it" } });
  if (gcs) endpoint.input.readOnly = true;
  const region = field({ id: "setup-dest-region", label: "Region", value: d.region, placeholder: "us-east-1", hint: "Use auto unless your provider needs a region.", doc: { href: "https://docs.downpipes.io/backing-up/choosing-a-destination", anchor: "region" } });
  const name = field({ id: "setup-dest-bucket", label: azure ? "Container" : "Bucket name", value: d.bucket, placeholder: "backups-archive", doc: { href: "https://docs.downpipes.io/day-2/data-residency", anchor: "you-choose-the-destination-the-engine-reports-it" } });
  const label = field({ id: "setup-dest-label", label: "Name in downpipes (optional)", value: d.label, placeholder: "Primary archive", doc: { href: "https://docs.downpipes.io/backing-up/multiple-destinations", anchor: "naming-a-destination" } });
  return {
    title: "Where is your bucket?",
    lede: ["Type the details from your provider's console."],
    body: [h("div", { class: "fb-fields" }, endpoint.el, azure ? null : region.el, name.el, label.el)],
    focus: () => (gcs ? name.input : endpoint.input),
    primary: {
      label: "Continue",
      run: () => {
        endpoint.setError(null);
        name.setError(null);
        const before = JSON.stringify([d.endpoint, d.region, d.bucket]);
        if (!/^https:\/\/[^\s/]+/.test(endpoint.input.value.trim())) return focusErr(endpoint, "Endpoint must be an https URL with a host, for example https://s3.example.com.");
        if (name.input.value.trim() === "") return focusErr(name, azure ? "Type the container name." : "Type the bucket name.");
        m.update({ endpoint: endpoint.input.value.trim(), region: azure ? "auto" : region.input.value.trim() || "auto", bucket: name.input.value.trim(), bucketTyped: true, label: label.input.value.trim() });
        const nd = m.get().draft;
        onward(c, m.get(), "lock", before !== JSON.stringify([nd.endpoint, nd.region, nd.bucket]));
      },
    },
  };
}

// ---- Lock -------------------------------------------------------------------------------------------------------

export function lock(c: QCtx): QView {
  const m = setupModel();
  const d = c.s.draft;
  const days = field({ id: "setup-lock-days", label: "Lock each archive for (days)", type: "number", inputmode: "numeric", size: "lg", value: d.immutabilityDays || "30", placeholder: "30", validate: lockDaysRule, doc: { href: "https://docs.downpipes.io/assurance-audit/immutability-and-attestation", anchor: "the-three-worm-states" } });
  const tiles = tileGroup<ImmutabilityMode>({
    name: "lock",
    labelledBy: "fb-h1",
    choices: immutabilityChoices(d.provider).map((x) => ({ id: x.id, label: x.label, lines: [x.consequence], ...(x.unavailable !== undefined ? { unavailable: x.unavailable } : {}), ...(x.id !== "off" ? { extra: () => days.el } : {}) })),
    selected: d.immutability,
    showChosen: true,
    columns: 3,
  });
  return {
    title: "Lock archives against deletion?",
    lede: ["A lock blocks delete and overwrite until its time ends."],
    body: [line(ICON_LOCK, LOCK_PREREQ[d.provider], "fb-line--muted"), tiles.el],
    primary: {
      label: "Continue",
      run: () => {
        const v = tiles.value() ?? "off";
        days.setError(null);
        if (v !== "off" && days.check() !== null) return days.input.focus();
        const before = JSON.stringify([d.immutability, d.immutabilityDays]);
        m.update({ immutability: v, immutabilityDays: v === "off" ? "" : days.input.value.trim() });
        c.flight(tiles.chosenTitle(), "lock");
        c.answer("lock");
        const nd = m.get().draft;
        onward(c, m.get(), "credentials", before !== JSON.stringify([nd.immutability, nd.immutabilityDays]));
      },
    },
  };
}

// ---- Credentials (Verify and save) ------------------------------------------------------------------------------

export function credentials(c: QCtx): QView {
  const m = setupModel();
  const s = c.s;
  const d = s.draft;
  const info = PROVIDERS_INFO.find((p) => p.id === d.provider)!;
  const saved = stepDone(s, "destination");
  const alert = message("error");
  const warn = message("warn");
  const keyId = field({ id: "setup-dest-key-id", label: info.credentialLabels.keyId, placeholder: d.provider === "azure" ? "mystorageaccount" : "AKIAIOSFODNN7EXAMPLE", doc: { href: "https://docs.downpipes.io/backing-up/multiple-destinations", anchor: "creating-the-destination-credential" } });
  const secret = field({ id: "setup-dest-secret", label: info.credentialLabels.secret, type: "password", doc: { href: "https://docs.downpipes.io/backing-up/multiple-destinations", anchor: "creating-the-destination-credential" } });
  const fields: Record<string, Field> = { accessKeyId: keyId, secretAccessKey: secret };
  const body: Node[] = [];

  // Sign-in method: a choice on the face of the view, so a bucket that trusts only a role (S3) or a service
  // principal (Azure) can pass the probe on the first save.
  let externalId: Field | null = null;
  if (d.provider === "s3" || d.provider === "azure") {
    const s3 = d.provider === "s3";
    const role = s3
      ? field({ id: "setup-dest-role-arn", label: STS_FIELDS[0].label, value: d.roleArn, placeholder: "arn:aws:iam::123456789012:role/Backup", hint: STS_FIELDS[0].hint, doc: { href: "https://docs.downpipes.io/backing-up/multiple-destinations", anchor: "creating-the-destination-credential" }, onInput: (v) => m.update({ roleArn: v.trim() }) })
      : field({ id: "setup-dest-entra-tenant", label: ENTRA_FIELDS[0].label, value: d.entraTenantId, placeholder: "72f988bf-86f1-41af-91ab-2d7cd011db47", hint: ENTRA_FIELDS[0].hint, doc: { href: "https://docs.downpipes.io/backing-up/choosing-a-destination", anchor: "the-three-azure-credential-kinds" }, onInput: (v) => m.update({ entraTenantId: v.trim() }) });
    const second = s3
      ? field({ id: "setup-dest-sts-duration", label: STS_FIELDS[2].label, value: d.stsDuration, placeholder: "3600", hint: STS_FIELDS[2].hint, inputmode: "numeric", validate: stsDurationRule, doc: { href: "https://docs.downpipes.io/backing-up/multiple-destinations", anchor: "creating-the-destination-credential" }, onInput: (v) => m.update({ stsDuration: v.trim() }) })
      : field({ id: "setup-dest-entra-client", label: ENTRA_FIELDS[1].label, value: d.entraClientId, placeholder: "d290f1ee-6c54-4b01-90e6-d701748f0851", hint: ENTRA_FIELDS[1].hint, doc: { href: "https://docs.downpipes.io/backing-up/choosing-a-destination", anchor: "the-three-azure-credential-kinds" }, onInput: (v) => m.update({ entraClientId: v.trim() }) });
    if (s3) externalId = field({ id: "setup-dest-external-id", label: STS_FIELDS[1].label, type: "password", hint: STS_FIELDS[1].hint, doc: { href: "https://docs.downpipes.io/backing-up/multiple-destinations", anchor: "creating-the-destination-credential" } });
    fields[s3 ? "roleArn" : "entraTenantId"] = role;
    fields[s3 ? "stsDuration" : "entraClientId"] = second;
    const usesRole = s3 ? d.roleArn !== "" : d.entraTenantId !== "";
    const signIn = tileGroup<"key" | "role">({
      name: "signin",
      legend: "Sign in with",
      choices: [
        { id: "key", label: s3 ? "Access key" : "Account key", lines: [s3 ? "The engine signs with the key directly." : "The engine uses the key you paste."] },
        { id: "role", label: s3 ? "AWS role" : "Microsoft Entra", lines: [s3 ? "The key assumes a role per session." : "The engine signs in as your app."], extra: () => h("div", { class: "fb-extra" }, role.el, externalId?.el ?? null, second.el) },
      ],
      selected: usesRole ? "role" : "key",
      columns: 2,
      onChange: (id) => {
        if (id === "key") m.update(s3 ? { roleArn: "", stsDuration: "" } : { entraTenantId: "", entraClientId: "" });
      },
    });
    body.push(signIn.el);
  }
  body.push(h("div", { class: "fb-fields fb-fields--2" }, keyId.el, secret.el));
  if (d.provider === "r2") {
    // R2 shows every lock mode, with the two it cannot enforce unavailable and the reason on their face.
    body.push(tileGroup<ImmutabilityMode>({
      name: "lock-r2",
      legend: "Object lock",
      choices: immutabilityChoices("r2").map((x) => ({ id: x.id, label: x.label, lines: x.unavailable !== undefined ? [] : [x.consequence], ...(x.unavailable !== undefined ? { unavailable: x.unavailable } : {}) })),
      selected: "off",
      columns: 3,
      numberKeys: false,
    }).el);
  }
  if (d.provider === "s3") {
    const addr = ADDRESSING_CHOICES.find((a) => a.id === d.addressing)?.label ?? "Auto";
    const cls = STORAGE_CLASS_CHOICES.find((a) => a.id === d.storageClass)?.label ?? "Bucket default";
    body.push(h("p", { class: "fb-row fb-row--muted" }, `Addressing: ${addr}. Storage class: ${cls}.`, textButton("Change", () => transportSheet(c), { "aria-label": "Change addressing and storage class" })));
  }
  body.push(line(ICON_SHIELD_CHECK, "Your engine keeps this key in your Cloudflare account.", "fb-line--trust"), alert.el, warn.el);

  const lede: Array<string | Node> =
    saved ? ["Your engine holds a key for this bucket. Paste a new one to save your changes."]
    : d.provider === "r2" ? ["In Cloudflare, open R2, then Manage R2 API Tokens. Make a token with Object Read and Write for this bucket only. ", externalLink("Open R2 API tokens", CF_R2_TOKENS)]
    : ["The key needs read and write on this bucket only."];
  return {
    title: d.provider === "r2" ? `Paste the access key for ${d.bucket || "your bucket"}` : "Paste the access key for your bucket",
    lede,
    body,
    focus: () => keyId.input,
    primary: {
      label: "Verify and save",
      busyLabel: "Verifying",
      busyText: "Your engine is checking it can reach your bucket, writing a test file, then removing it.",
      run: async () => {
        for (const f of Object.values(fields)) f.setError(null);
        alert.set(null);
        warn.set(null);
        if (keyId.input.value.trim() === "") return focusErr(keyId, `Paste the ${info.credentialLabels.keyId}.`);
        if (secret.input.value === "") return focusErr(secret, `Paste the ${info.credentialLabels.secret}.`);
        const ruled = Object.values(fields).find((f) => f.check() !== null);
        if (ruled) return ruled.input.focus();
        c.setBusy(true);
        const r = await saveDestination({ accessKeyId: keyId.input.value, secretAccessKey: secret.input.value, ...(externalId && externalId.input.value !== "" ? { externalId: externalId.input.value } : {}) });
        c.setBusy(false);
        if (!r.ok) {
          const f = r.error.field !== undefined ? fields[r.error.field] : undefined;
          if (r.error.kind === "queued") return warn.set("Not saved yet. A second Owner must approve this change first.");
          if (r.error.kind === "cancelled") return;
          if (f) return focusErr(f, r.error.message);
          const hint = d.provider === "s3" ? " Check the sign-in method and the addressing style if your bucket needs them." : d.provider === "azure" ? " Check the sign-in method if your container needs Microsoft Entra." : "";
          return alert.set(r.error.kind === "refused" ? `The engine refused this destination: ${r.error.message}${hint}` : r.error.message);
        }
        keyId.input.value = "";
        secret.input.value = "";
        if (externalId) externalId.input.value = "";
        c.answer("credentials");
        c.next();
      },
    },
    secondary: saved ? [textButton("Keep the saved key", () => c.next())] : [],
  };
}

// transportSheet is the one-level sheet for S3 addressing and storage class.
function transportSheet(c: QCtx): void {
  const m = setupModel();
  const d = m.get().draft;
  const addr = tileGroup({ name: "addr", legend: "Addressing", choices: ADDRESSING_CHOICES.map((a) => ({ id: a.id, label: a.label, lines: [a.consequence] })), selected: d.addressing, columns: 3, onChange: (id) => m.update({ addressing: id }) });
  const cls = tileGroup({ name: "class", legend: "Storage class", choices: STORAGE_CLASS_CHOICES.map((a) => ({ id: a.id === "" ? "default" : a.id, label: a.label, lines: [a.consequence] })), selected: d.storageClass === "" ? "default" : d.storageClass, columns: 2, onChange: (id) => m.update({ storageClass: id === "default" ? "" : id }) });
  openSheet({ title: "How the engine reaches the bucket", body: [addr.el, cls.el], opener: document.activeElement as HTMLElement | null, onClose: () => c.rerender() });
}

// ---- Storage prices ---------------------------------------------------------------------------------------------

export function pricing(c: QCtx): QView {
  const m = setupModel();
  const d = c.s.draft;
  const def = pricingDefaults(d.provider);
  const cur = d.pricing ?? def;
  const mk = (id: string, label: string, v: number): Field => field({ id, label, type: "number", inputmode: "decimal", value: String(v), placeholder: "0.015", validate: priceRule, doc: { href: "https://docs.downpipes.io/day-2/cost-prediction", anchor: "where-the-rates-come-from" } });
  const storage = mk("setup-price-storage", "Storage, per GB each month", cur.storagePerGBMonth);
  const writes = mk("setup-price-writes", "Writes, per million", cur.classAPerMillion);
  const reads = mk("setup-price-reads", "Reads, per million", cur.classBPerMillion);
  const egress = mk("setup-price-egress", "Egress, per GB", cur.egressPerGB);
  const all = [storage, writes, reads, egress];
  return {
    title: "What does your storage cost?",
    lede: ["downpipes uses these prices for cost estimates only. Prices are in US dollars."],
    body: [
      h("p", { class: "fb-note" }, d.provider === "r2" ? "The prefill is the R2 list price. Change it to your own rates." : "The prefill is the Amazon S3 Standard list price, not your provider's. Change it to your own rates."),
      h("div", { class: "fb-fields fb-fields--2" }, ...all.map((f) => f.el)),
    ],
    focus: () => storage.input,
    primary: {
      label: c.ret !== null ? "Save and go back" : "Save prices",
      run: () => {
        const vals = all.map((f) => Number(f.input.value));
        for (const f of all) f.setError(null);
        const bad = all.find((f) => f.check() !== null);
        if (bad) return bad.input.focus();
        const same = vals[0] === def.storagePerGBMonth && vals[1] === def.classAPerMillion && vals[2] === def.classBPerMillion && vals[3] === def.egressPerGB;
        const before = JSON.stringify(m.get().draft.pricing);
        m.update({ pricing: same ? null : { storagePerGBMonth: vals[0]!, classAPerMillion: vals[1]!, classBPerMillion: vals[2]!, egressPerGB: vals[3]! } });
        // Prices travel with the destination save: after a save, new prices lead to Verify and save.
        onward(c, m.get(), "credentials", before !== JSON.stringify(m.get().draft.pricing));
      },
    },
    secondary: [textButton("Use list prices", () => { const had = m.get().draft.pricing !== null; m.update({ pricing: null }); onward(c, m.get(), "credentials", had); })],
  };
}
