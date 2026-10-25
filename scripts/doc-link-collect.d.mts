// Types for doc-link-collect.mjs, which is plain JavaScript. Same arrangement as workspace-root.d.mts beside it.

export interface DocLink { url: string; line: number; edit: { from: number; to: number } | null }
export interface Unresolved { line: number; why: string }
export interface ScanOptions { templateValues?: Record<string, string[]> }

/** Every docs.downpipes.io link in `text` with its line, and every place the docs host is written in a form the scanner does not accept. */
export function scanDocLinks(text: string, opts?: ScanOptions): { urls: DocLink[]; unresolved: Unresolved[] };

/** Every docs.downpipes.io URL in `text`, with the anchor from the href's own object literal appended. */
export function collectDocLinks(text: string, opts?: ScanOptions): string[];

/** True for a file name the gate reads: TypeScript or JavaScript, never a declaration file. */
export function isSourceFile(name: string): boolean;

/** True for a directory the gate does not read: installed packages anywhere, build output at src's top level. */
export function isSkippedDir(name: string, topLevel?: boolean): boolean;

/** The edit that would remove the anchor of one docs link. Nothing is written. */
export function proposeFix(text: string, url: string, opts?: ScanOptions): Array<{ line: number; before: string; after: string }>;
