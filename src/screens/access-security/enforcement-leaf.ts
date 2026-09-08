// Leaf helper shared by the enforcement sub-view's IdP-guidance and setup-wizard
// modules. Kept here (a dependency-free leaf) so neither of those two modules has
// to import the other just to share this one builder, which would couple two
// peers. Extracted verbatim from enforcement.ts (finding console-src-024-01).

import { h } from "../../lib/dom.ts";
import { codeBlock } from "../../components/code-block.ts";

// labelledCopy is a label + a copy block whose value renders literally (textContent,
// via codeBlock). The hostname comes from location/the connection, never guessed.
export function labelledCopy(label: string, value: string): HTMLElement {
  return h(
    "div",
    { style: "display:grid;gap:var(--space-2)" },
    h("span", { class: "field__label" }, label),
    codeBlock(value, { copyLabel: `Copy ${label.toLowerCase()}` }),
  );
}
