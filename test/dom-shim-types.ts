// Shared interface declarations for the console's DOM shim (split out of dom-shim.ts so the
// shim stays under the per-file size budget). These are type-only contracts with no runtime;
// dom-shim.ts re-exports them so importers are unchanged.

import type { ShimElement, ShimNode } from "./dom-shim-core.ts";

export interface ShimEventInit {
  type: string;
  bubbles?: boolean;
  cancelable?: boolean;
}

export interface ShimEvent {
  type: string;
  target: ShimNode | null;
  currentTarget: ShimNode | null;
  defaultPrevented: boolean;
  bubbles: boolean;
  preventDefault(): void;
  stopPropagation(): void;
  key?: string;
  shiftKey?: boolean;
  // Mouse-event fields, for the delegated click handlers (app-external-link.ts's interstitial reads
  // all four before it reads target/key at all).
  button?: number;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}

export interface ShimDocument {
  __shim: boolean;
  body: ShimNode;
  documentElement: ShimNode;
  readyState: string;
  activeElement: ShimNode | null;
  createElement(tag: string): ShimElement;
  createElementNS(ns: string, tag: string): ShimElement;
  createTextNode(t: string): ShimNode;
  createDocumentFragment(): ShimNode;
  getElementById(id: string): ShimNode | null;
  querySelector(sel: string): ShimNode | null;
  querySelectorAll(sel: string): ShimNode[];
  contains(node: ShimNode | null): boolean;
  addEventListener(type: string, fn: (ev: ShimEvent) => void, capture?: boolean): void;
  removeEventListener(type: string, fn: (ev: ShimEvent) => void, capture?: boolean): void;
  dispatchKey(ev: ShimEvent): void;
}

export interface MemoryStorage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
  clear(): void;
}
