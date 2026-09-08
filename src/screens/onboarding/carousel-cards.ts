// The onboarding card deck data: the OB_CARDS array, moved verbatim out of carousel.ts to keep the
// chassis file under the size budget. The deck itself was then split
// across two sibling data modules to keep each one under the size budget too;
// this module re-concatenates them so OB_CARDS keeps the EXACT same order and
// contents. Every card is the production realisation of one bite-size onboarding step, grouped into
// the five chapters the chassis renders. The cards reuse the exact shared helpers and step
// renderers unchanged; only their host module moved. House rules: Australian English, no em dashes,
// precise claims.

import type { CardDef } from "./shared.ts";
import { OB_CARDS_CONNECT_KEYS } from "./carousel-cards-connect-keys.ts";
import { OB_CARDS_CONFIGURE_READY } from "./carousel-cards-configure-ready.ts";

// Chapters 0 (Connect) and 1 (Your keys), then chapters 2 (Configure), 3 (Your team) and 4
// (Ready). The order and contents are identical to the single-array form they were split from.
export const OB_CARDS: CardDef[] = [...OB_CARDS_CONNECT_KEYS, ...OB_CARDS_CONFIGURE_READY];
