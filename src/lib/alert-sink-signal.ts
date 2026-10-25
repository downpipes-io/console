// The Notifications screen's one-line signal that the channel list changed: a channel was saved or removed.
// The shell's update strip asks for an alert destination while none is enabled, so it re-reads the list at
// once instead of waiting for its next scheduled refresh. app.ts registers the listener; a screen only calls
// requestAlertSinkRefresh. With no listener registered the call does nothing.

let listener: (() => void) | null = null;

export function onAlertSinkRefresh(fn: () => void): void {
  listener = fn;
}

export function requestAlertSinkRefresh(): void {
  if (listener) listener();
}
