// The Apply checklist's current stage, mirrored on the plan's Installed line while it runs. Kept in its own
// module so the page and the Apply question share it without an import cycle.

let liveInstall: string | null = null;
const listeners = new Set<() => void>();

export function setLiveInstall(v: string | null): void {
  if (v === liveInstall) return;
  liveInstall = v;
  for (const fn of [...listeners]) fn();
}

export function getLiveInstall(): string | null {
  return liveInstall;
}

export function onLiveInstall(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
