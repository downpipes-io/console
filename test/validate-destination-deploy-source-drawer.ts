// Once a second destination joins a deploy-time-bound one, the
// engine registers the deploy-time binding as a real, permanent destination (source:"deploy",
// engine's ensureDeployDestSeeded/DEPLOY_DEST_ID) rather than silently reassigning its runs to
// whichever destination becomes the new default. That row now appears in the console's
// multi-destination LIST like any other, and this drives what the drawer must get right about it:
//
//   - a "deploy-time" provider badge, never a guessed S3/R2/GCS/Azure badge derived from a blank
//     endpoint host (providerBadge's host-sniff would otherwise default to "s3", which is a real,
//     specific, WRONG claim about where the bytes live rather than an honest "we cannot say").
//   - a note explaining there is no console-stored credential to replace.
//   - NO "Replace" lever in the drawer footer (the engine refuses that id outright: putDest's
//     "that destination id is reserved"), so the button is omitted rather than left to surface a
//     raw refusal on click. Verify now, Make default and Remove stay present and unchanged: this
//     destination is still a first-class member of the collection, fully governed by the SAME
//     3-2-1 removal guard as any other (the point of the fix -- "add", never "replace").
//
// Drives the REAL renderList + the REAL row-activation drawer (destination-cards.ts's
// openDestinationDrawer, private; opened via the real dataTable row click, the same path an
// operator's click takes, mirroring validate-r20-drawer-key-propagation.ts's own destination case).
//
// Run with: node test/validate-destination-deploy-source-drawer.ts

import { installDomShim, qs, qsa, flushAsync, markConnected } from "./dom-shim.ts";
installDomShim();

const { renderList } = await import("../src/screens/destination-cards.ts");
const { closeAllOverlays } = await import("../src/components/dialog.ts");

import type { EngineClient } from "../src/api.ts";
import type { DestinationList, DestinationStatus } from "../src/lib/api/types/destinations.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

function stubEngine(): EngineClient {
  return {} as unknown as EngineClient;
}

// Button text is matched by PREFIX, not equality: a disabled-with-reason lever (this stub sets up
// no identity/role context, so every owner-gated action renders disabled) appends its gate reason
// straight onto the label's own text node ("Verify nowRequires the Owner role..."), and the drawer's
// disabled-with-reason accessible-name pairing can carry the same label on a second, sr-only node.
// Either way, the label itself is a PREFIX of every text node that carries it, which is the one
// thing a real, gate-off render and this stub's gated-off render still have in common.
function footerHasButtonLabelled(label: string): boolean {
  return qsa(document.body, ".dialog--drawer .dialog__footer button").some((b) => (b.textContent ?? "").trim().startsWith(label));
}

async function main(): Promise<void> {
  const engine = stubEngine();

  console.log("\n-- the deploy-time binding, listed alongside a real second destination --");
  {
    closeAllOverlays();
    const deploy: DestinationStatus = { present: true, id: "deploy", label: "Deploy-time destination", source: "deploy", isDefault: true };
    const archive2: DestinationStatus = { present: true, id: "dest-archive2", label: "archive-2", bucket: "archive-2", endpointHost: "acct.r2.cloudflarestorage.com", source: "console" };
    const list: DestinationList = { destinations: [deploy, archive2], defaultId: "deploy" };

    const root = renderList(engine, list, () => undefined);
    document.body.appendChild(root as unknown as Node);
    markConnected(root as unknown as HTMLElement);

    const deployRow = qs(document.body, 'tr[data-key="deploy"]');
    ok("the deploy-time row rendered in the multi-destination list", deployRow !== null);
    ok('its provider cell reads "deploy-time", never a guessed S3/R2 badge from a blank endpoint', (deployRow?.textContent ?? "").includes("deploy-time"));

    (deployRow as unknown as { click(): void }).click();
    await flushAsync();
    ok("activating the row opens exactly one drawer", qsa(document.body, ".overlay--drawer").length === 1);

    const drawerText = qs(document.body, ".dialog--drawer")?.textContent ?? "";
    ok("the drawer names it as the deploy-time binding badge", drawerText.includes("configured at deploy"));
    ok("the drawer states there is nothing here to replace", drawerText.includes("nothing here to replace"));

    ok('the footer offers "Verify now"', footerHasButtonLabelled("Verify now"));
    ok('the footer offers "Remove" (the SAME 3-2-1 guard governs it, unchanged)', footerHasButtonLabelled("Remove"));
    ok('the footer does NOT offer "Replace" (there is no stored credential to replace)', !footerHasButtonLabelled("Replace"));
    closeAllOverlays();
  }

  console.log("\n-- a REAL console-set destination in the same list keeps its Replace lever --");
  {
    closeAllOverlays();
    const deploy: DestinationStatus = { present: true, id: "deploy", label: "Deploy-time destination", source: "deploy", isDefault: true };
    const archive2: DestinationStatus = { present: true, id: "dest-archive2", label: "archive-2", bucket: "archive-2", endpointHost: "acct.r2.cloudflarestorage.com", source: "console" };
    const list: DestinationList = { destinations: [deploy, archive2], defaultId: "deploy" };
    const root = renderList(engine, list, () => undefined);
    document.body.appendChild(root as unknown as Node);
    markConnected(root as unknown as HTMLElement);

    const row = qs(document.body, 'tr[data-key="dest-archive2"]');
    (row as unknown as { click(): void }).click();
    await flushAsync();
    ok('a real console-set destination still offers "Replace" (this fix narrows the omission to source:"deploy" only)', footerHasButtonLabelled("Replace"));
    closeAllOverlays();
  }

  console.log(failures === 0 ? "\nDESTINATION DEPLOY-SOURCE DRAWER VECTORS PASS" : `\n${failures} FAILURE(S)`);
  if (failures > 0) process.exitCode = 1;
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\nVALIDATE-DESTINATION-DEPLOY-SOURCE-DRAWER THREW:", err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
