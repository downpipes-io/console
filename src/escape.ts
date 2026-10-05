// HTML-escape untrusted text before it is interpolated into innerHTML. Downpipe names
// and run ids come from the engine and must never be able to inject markup into the
// in-account console.
const HTML_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHTML(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPE_MAP[c]!);
}
