// Focus Flow question for step 3, Protect: one flat checklist grouped by type, in the user's own names, with
// the type glyphs, a count and All or None per group. The backup bucket shows as unavailable with its reason.
// Token sources (configuration, Workers, Stream, Images) count as picks.

import { databaseIdFieldValidator, databaseNameFieldValidator, kvNamespaceIdFieldValidator, r2BucketNameFieldValidator, secretNameFieldValidator, secretsStoreIdFieldValidator } from "../../../lib/add-source.ts";
import { h, svgIcon } from "../../../lib/dom.ts";
import { type BindingKind, type ManualResource, manualBindingFor, type PickKind, type Resource, type ResourceGroup, type SetupSnapshot, setupModel } from "../../../lib/setup-flow/index.ts";
import { storeIcon, tokenSourceIcon } from "../../add-source-glyphs.ts";
import { type CheckRow, checkRow, type Field, field, message, openSheet, textButton, tileGroup } from "./kit.ts";
import type { QCtx, QView } from "./types.ts";

function kindIcon(k: PickKind): string {
  return k === "kv" || k === "r2" || k === "d1" || k === "secrets" ? storeIcon(k) : tokenSourceIcon(k);
}

// displayName drops the account prefix from a token source when the token sees one account, so the row reads
// "Workers" rather than "Northwind Trading Co: Workers". The model keeps the full name for the downpipe.
function displayName(r: Resource, single: boolean): string {
  if (!single) return r.name;
  if (!r.name.startsWith(`${r.accountName}: `)) return r.name;
  const cut = r.name.slice(r.accountName.length + 2);
  return cut.charAt(0).toUpperCase() + cut.slice(1);
}

// byIdSheet is the one-level sheet for a binding resource discovery does not list: the type first, then only
// the identifiers that type needs. The resource joins the list, ticked.
function byIdSheet(c: QCtx): void {
  const m = setupModel();
  const alert = message("error");
  const kv = {
    id: field({ id: "setup-byid-kv-ns", label: "Namespace ID", placeholder: "0f2ac7c1b6e0470a9d3c5e8b1f4a7c20", validate: kvNamespaceIdFieldValidator, doc: { href: "https://docs.downpipes.io/sources/connect-a-source", anchor: "finding-the-ids-for-a-manual-attach" } }),
    name: field({ id: "setup-byid-kv-name", label: "Name in downpipes (optional)", placeholder: "uploads", doc: { href: "https://docs.downpipes.io/sources/connect-a-source", anchor: "binding-names-and-the-secrets-store" } }),
  };
  const r2 = { name: field({ id: "setup-byid-r2-bucket", label: "Bucket name", placeholder: "media-uploads", validate: r2BucketNameFieldValidator, doc: { href: "https://docs.downpipes.io/sources/connect-a-source", anchor: "finding-the-ids-for-a-manual-attach" } }) };
  const d1 = {
    name: field({ id: "setup-byid-d1-name", label: "Database name", placeholder: "orders-db", validate: databaseNameFieldValidator, doc: { href: "https://docs.downpipes.io/sources/connect-a-source", anchor: "finding-the-ids-for-a-manual-attach" } }),
    id: field({ id: "setup-byid-d1-id", label: "Database ID", placeholder: "d290f1ee-6c54-4b01-90e6-d701748f0851", validate: databaseIdFieldValidator, doc: { href: "https://docs.downpipes.io/sources/connect-a-source", anchor: "finding-the-ids-for-a-manual-attach" } }),
  };
  const sec = {
    id: field({ id: "setup-byid-sec-store", label: "Store ID", placeholder: "0f2ac7c1b6e0470a9d3c5e8b1f4a7c20", validate: secretsStoreIdFieldValidator, doc: { href: "https://docs.downpipes.io/sources/connect-a-source", anchor: "finding-the-ids-for-a-manual-attach" } }),
    name: field({ id: "setup-byid-sec-name", label: "Secret name", placeholder: "stripe-api-key", validate: secretNameFieldValidator, doc: { href: "https://docs.downpipes.io/sources/connect-a-source", anchor: "binding-names-and-the-secrets-store" } }),
  };
  const types = tileGroup<BindingKind>({
    name: "byid",
    legend: "Type",
    choices: [
      { id: "kv", label: "KV namespace", lines: [], extra: () => h("div", { class: "fb-extra" }, kv.id.el, kv.name.el) },
      { id: "r2", label: "R2 bucket", lines: [], extra: () => h("div", { class: "fb-extra" }, r2.name.el) },
      { id: "d1", label: "D1 database", lines: [], extra: () => h("div", { class: "fb-extra" }, d1.name.el, d1.id.el) },
      { id: "secrets", label: "Secrets Store secret", lines: [], extra: () => h("div", { class: "fb-extra" }, sec.id.el, sec.name.el) },
    ],
    selected: null,
  });
  // need refuses an empty identifier, then its shape through the field's own rule: the validators the Sources
  // screen's manual attach uses (lib/add-source.ts). The engine's attach route checks that an id is present,
  // not its shape, so the console is the only place a malformed id is caught before Apply.
  const need = (f: Field, msg: string): string | null => {
    const v = f.input.value.trim();
    if (v === "") f.setError(msg);
    if (v === "" || f.check() !== null) {
      f.input.focus();
      return null;
    }
    return v;
  };
  const add = h("button", { "data-dp": "setup.button.add", class: "btn btn--primary", type: "button" }, "Add to the list");
  const sheet = openSheet({ title: "Add a resource by its id", body: [h("p", { class: "fb-note" }, "For a resource your token does not list. Its binding attaches at Apply."), types.el, alert.el], actions: [add], opener: document.activeElement as HTMLElement | null, onClose: () => c.rerender() });
  add.addEventListener("click", () => {
    alert.set(null);
    const kind = types.value();
    if (kind === null) return types.setError("Choose the type first.");
    let mr: ManualResource | null = null;
    if (kind === "kv") {
      const id = need(kv.id, "Type the namespace ID.");
      if (id !== null) mr = { kind, id, name: kv.name.input.value.trim() || id };
    } else if (kind === "r2") {
      const name = need(r2.name, "Type the bucket name.");
      if (name !== null) mr = { kind, name };
    } else if (kind === "d1") {
      const name = need(d1.name, "Type the database name.");
      const id = name !== null ? need(d1.id, "Type the database ID.") : null;
      if (name !== null && id !== null) mr = { kind, name, id };
    } else {
      const id = need(sec.id, "Type the store ID.");
      const name = id !== null ? need(sec.name, "Type the secret name.") : null;
      if (id !== null && name !== null) mr = { kind, id, name };
    }
    if (mr === null) return;
    // The resource attaches at Apply under SRC_<type>_<name>, and the engine's attach route refuses a binding
    // longer than 64 characters. Say so here, on the field whose value makes the binding.
    const binding = manualBindingFor(mr.kind, mr.name);
    if (binding.length > 64) {
      const named = mr.kind === "kv" ? (kv.name.input.value.trim() !== "" ? kv.name : kv.id) : mr.kind === "r2" ? r2.name : mr.kind === "d1" ? d1.name : sec.name;
      named.setError(`That makes the binding ${binding}, longer than the 64 characters the engine accepts. Use a shorter name.`);
      named.input.focus();
      return;
    }
    const d = m.get().draft;
    const key = `manual:${mr.kind}:${mr.id ?? ""}:${mr.name}`;
    m.update({ manual: [...d.manual, mr], picks: [...new Set([...d.picks, key])] });
    void m.refresh().then(() => sheet.close());
  });
}

export function protect(c: QCtx): QView {
  const m = setupModel();
  const s = c.s;
  const single = s.facts.accounts.length <= 1;
  const count = h("span", { class: "fb-count", "aria-live": "polite" });
  const groupsHost = h("div", { class: "fb-groups" });
  const total = s.facts.groups.reduce((n, g) => n + g.resources.length, 0);
  const rows = new Map<string, CheckRow>();
  const contentRows = new Map<string, HTMLElement>();

  const picked = (): Set<string> => new Set(m.get().draft.picks);
  const setPick = (key: string, on: boolean): void => {
    const next = picked();
    if (on) next.add(key);
    else next.delete(key);
    m.update({ picks: [...next] });
  };
  const paintCount = (): void => {
    const n = m.get().draft.picks.filter((k) => s.facts.groups.some((g) => g.resources.some((r) => r.key === k && r.unavailable === undefined))).length;
    count.textContent = n === 0 ? "" : `${n} picked`;
    for (const [key, row] of rows) row.input.checked = picked().has(key);
    for (const [key, el] of contentRows) el.hidden = !picked().has(key);
    c.refresh();
  };

  const groupEl = (g: ResourceGroup): HTMLElement => {
    const live = g.resources.filter((r) => r.unavailable === undefined);
    // A reason shared by two or more rows (a minimal token, another account) shows once, under the heading.
    const why = new Map<string, number>();
    for (const r of g.resources) if (r.unavailable !== undefined) why.set(r.unavailable, (why.get(r.unavailable) ?? 0) + 1);
    const shared = [...why.entries()].find(([, n]) => n >= 2)?.[0];
    const sharedId = shared !== undefined ? `fb-why-${g.kind}` : undefined;
    const all = h("button", { "data-dp": "setup.button.all", class: "fb-all", type: "button" }, "All") as HTMLButtonElement;
    const paintAll = (): void => {
      const every = live.length > 0 && live.every((r) => picked().has(r.key));
      all.textContent = every ? "None" : "All";
      all.setAttribute("aria-label", `${every ? "Untick" : "Tick"} all ${g.label}`);
      if (live.length === 0) all.hidden = true;
    };
    all.addEventListener("click", () => {
      const every = live.every((r) => picked().has(r.key));
      const next = picked();
      for (const r of live) {
        if (every) next.delete(r.key);
        else next.add(r.key);
      }
      m.update({ picks: [...next] });
      paintCount();
      paintAll();
    });
    const list = h("div", { class: "fb-group__rows" });
    for (const r of g.resources) {
      const row = checkRow({
        label: displayName(r, single),
        ...(r.bound ? { secondary: "Attached" } : {}),
        checked: picked().has(r.key),
        ...(r.unavailable !== undefined && r.unavailable === shared && sharedId !== undefined ? { reasonId: sharedId } : r.unavailable !== undefined ? { disabledReason: r.unavailable === "This is your backup destination." ? "Your backup bucket" : r.unavailable } : {}),
        onChange: (v) => {
          setPick(r.key, v);
          paintCount();
          paintAll();
        },
      });
      rows.set(r.key, row);
      list.appendChild(row.el);
      if ((r.kind === "stream" || r.kind === "images") && r.unavailable === undefined) {
        // The content toggle: the media bytes too, not only the list. Shown while the row is ticked.
        const content = checkRow({
          label: r.kind === "stream" ? "Also copy the video files" : "Also copy the image files",
          checked: m.get().draft.mediaContent.includes(r.key),
          onChange: (v) => {
            const cur = new Set(m.get().draft.mediaContent);
            if (v) cur.add(r.key);
            else cur.delete(r.key);
            m.update({ mediaContent: [...cur] });
          },
        });
        content.el.classList.add("fb-check--sub");
        content.el.hidden = !picked().has(r.key);
        contentRows.set(r.key, content.el);
        list.appendChild(content.el);
      }
    }
    paintAll();
    return h(
      "fieldset",
      { class: "fb-group" },
      h("legend", { class: "fb-group__head" }, h("span", { class: "fb-group__glyph", "aria-hidden": "true" }, svgIcon(kindIcon(g.kind), { size: 15 })), g.label, h("span", { class: "fb-group__n", "aria-hidden": "true" }, String(g.resources.length))),
      all,
      shared !== undefined && sharedId !== undefined ? h("p", { class: "fb-group__why", id: sharedId }, shared) : null,
      list,
    );
  };

  // Workers, Stream and Images are one display group ("Workers and media"), so the list stays one screen tall.
  const merged = (): ResourceGroup[] => {
    const media = s.facts.groups.filter((g) => g.kind === "workers" || g.kind === "stream" || g.kind === "images");
    const rest = s.facts.groups.filter((g) => !media.includes(g));
    return media.length === 0 ? rest : [...rest, { kind: "workers", label: "Workers and media", resources: media.flatMap((g) => g.resources) }];
  };
  const paintGroups = (filter: string): void => {
    const f = filter.trim().toLowerCase();
    const gs = merged().map((g) => ({ ...g, resources: f === "" ? g.resources : g.resources.filter((r) => r.name.toLowerCase().includes(f)) })).filter((g) => g.resources.length > 0);
    rows.clear();
    contentRows.clear();
    groupsHost.replaceChildren(...gs.map(groupEl));
  };
  paintGroups("");

  const body: Node[] = [];
  if (s.facts.groups.length === 0) {
    body.push(h("p", { class: "fb-note" }, s.facts.accounts.length === 0 ? "Your resources appear here after the token." : "Your token sees nothing to back up in this account. Check the token's Account Resources."));
  } else {
    if (total > 30) {
      const filter = field({ id: "setup-protect-filter", label: "Filter", onInput: (v) => paintGroups(v) });
      body.push(filter.el);
      groupsHost.classList.add("fb-groups--scroll");
    }
    body.push(groupsHost);
  }
  body.push(h("p", { class: "fb-row" }, textButton("Add a resource by its id", () => byIdSheet(c))));
  paintCount();
  return {
    title: "What should downpipes protect?",
    lede: ["Tick what to back up. You can add more later."],
    body,
    primary: {
      label: c.ret !== null ? "Save and go back" : "Continue",
      reason: () => (m.get().draft.picks.length === 0 ? "Tick at least one resource." : null),
      run: () => c.next(),
    },
    secondary: [count],
    onSnapshot: (snap: SetupSnapshot) => {
      if (snap.draft.picks.length !== picked().size) paintCount();
    },
    ...(s.facts.groups.length === 0 ? { secondary: [h("button", { "data-dp": "setup.button.go-connect", class: "fb-textbtn", type: "button", on: { click: () => c.go("connect") } }, "Paste the token")] } : {}),
  };
}
