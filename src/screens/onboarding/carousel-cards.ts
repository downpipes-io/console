// The onboarding card deck data: the OB_CARDS array. The deck is split across two sibling data
// modules to keep each one under the size budget; this module concatenates them so OB_CARDS keeps
// one order and one set of contents. Every card is the production realisation of one bite-size
// onboarding step, grouped into the five chapters the chassis renders. The cards reuse shared
// helpers and step renderers.

import type { CardDef } from "./shared.ts";
import { OB_CARDS_CONNECT_KEYS } from "./carousel-cards-connect-keys.ts";
import { OB_CARDS_CONFIGURE_READY } from "./carousel-cards-configure-ready.ts";

// Chapters 0 (Connect) and 1 (Your keys), then chapters 2 (Configure), 3 (Your team) and 4
// (Ready), concatenated in chapter order.
export const OB_CARDS: CardDef[] = [...OB_CARDS_CONNECT_KEYS, ...OB_CARDS_CONFIGURE_READY];
