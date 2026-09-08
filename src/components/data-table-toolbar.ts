// The TOOLBAR builders behind the configurable data table (data-table.ts): buildToolbar
// (the /-focusable filter input, the faceted chips, and the right-hand count + density
// slot, assembled once into ctx.toolbar), buildDensityToggle (the comfortable/compact
// toggle group), and applyToolbarVisibility (the progressive-chrome show/hide). Split out
// as a dependency-light sibling so the component module stays under the size budget. The
// bodies are moved verbatim from the dataTable() factory; the only change is reading the
// live state and callbacks through the shared ctx instead of the closure, so the move is
// behaviour-preserving.
//
// House rules: Australian English, no em dashes, precise claims.

import { h, svgIcon } from "../lib/dom.ts";
import { ICON_SEARCH } from "../lib/icons.ts";
import type { DataTableCtx } from "./data-table-context.ts";

// buildToolbar assembles the filter input, the facet chips, and the right-hand count +
// density slot into ctx.toolbar, exactly as the factory did inline. It mutates ctx
// (ctx.filterInput) and appends to ctx.toolbar.
export function buildToolbar<Row>(ctx: DataTableCtx<Row>): void {
  const { opts, toolbar, countEl } = ctx;

  if (opts.filter) {
    const input = h("input", { "data-dp": "components-data-table-toolbar.search.clear-timeout",
      class: "input dt-filter",
      type: "search",
      placeholder: opts.filter.placeholder,
      "aria-label": opts.filter.placeholder,
      value: ctx.query,
    }) as HTMLInputElement;
    let timer: number | undefined;
    input.addEventListener("input", () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        ctx.query = input.value.trim();
        ctx.onChange();
      }, 120);
    });
    ctx.filterInput = input;
    const search = h("div", { class: "dt-filter-wrap" }, svgIcon(ICON_SEARCH, { size: 16 }), input);
    toolbar.appendChild(search);
  }

  if (opts.facets?.length) {
    const facetWrap = h("div", { class: "dt-facets", role: "group", "aria-label": "Filters" });
    for (const facet of opts.facets) {
      const chip = h(
        "button",
        { "data-dp": "components-data-table-toolbar.toggle.chip",
          class: "dt-facet",
          type: "button",
          "aria-pressed": ctx.activeFacets.has(facet.id) ? "true" : "false",
        },
        facet.tone ? h("span", { class: `dot dot--${facet.tone}`, "aria-hidden": "true" }) : false,
        h("span", facet.label),
      );
      chip.addEventListener("click", () => {
        if (ctx.activeFacets.has(facet.id)) ctx.activeFacets.delete(facet.id);
        else ctx.activeFacets.add(facet.id);
        chip.setAttribute("aria-pressed", ctx.activeFacets.has(facet.id) ? "true" : "false");
        ctx.onChange();
      });
      facetWrap.appendChild(chip);
    }
    toolbar.appendChild(facetWrap);
  }

  const toolbarRight = h("div", { class: "dt-toolbar__right" }, countEl);
  if (opts.density) toolbarRight.appendChild(buildDensityToggle(ctx));
  toolbar.appendChild(toolbarRight);
}

export function buildDensityToggle<Row>(ctx: DataTableCtx<Row>): HTMLElement {
  const group = h("div", { class: "dt-density", role: "group", "aria-label": "Row density" });
  // The change is visual (row heights), so announce it politely for assistive
  // tech (WCAG 4.1.3): aria-pressed alone does not say what happened.
  const live = h("span", { class: "visually-hidden", role: "status", "aria-live": "polite" });
  const make = (value: "comfortable" | "compact", label: string) => {
    const btn = h(
      "button",
      { "data-dp": "components-data-table-toolbar.toggle.render", class: "dt-density__btn", type: "button", "aria-pressed": ctx.density === value ? "true" : "false" },
      label,
    );
    btn.addEventListener("click", () => {
      ctx.density = value;
      ctx.root.dataset.density = ctx.density;
      group.querySelectorAll<HTMLElement>(".dt-density__btn").forEach((b) => {
        b.setAttribute("aria-pressed", "false");
      });
      btn.setAttribute("aria-pressed", "true");
      live.textContent = `${label} density`;
      ctx.render(); // re-render so windowing row-height maths use the new density
    });
    return btn;
  };
  group.appendChild(make("comfortable", "Comfortable"));
  group.appendChild(make("compact", "Compact"));
  group.appendChild(live);
  return group;
}

// Progressive chrome: no filter/facet/density strip over a handful of
// rows, unless a restored filter or facet is ACTIVE (hiding the strip then would
// orphan visible state the operator needs to see and clear).
const TOOLBAR_MIN_ROWS = 8;
export function applyToolbarVisibility<Row>(ctx: DataTableCtx<Row>): void {
  ctx.toolbar.hidden = ctx.allRows.length < TOOLBAR_MIN_ROWS && ctx.query === "" && ctx.activeFacets.size === 0;
}
