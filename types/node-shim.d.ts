/*
 * Minimal ambient declarations so `tsc --allowJs --checkJs` can type-check this
 * package without adding @types/node as a dependency (Z6: zero third-party
 * runtime deps; dev tooling stays to tsc + node:test). Builtins used by the
 * package are declared as `any` on purpose: this shim catches typos and
 * undefined identifiers in our own code, not Node API misuse.
 */
declare module 'node:*';
declare module 'node:test';
declare module 'node:assert/strict';

declare var process: any;
declare var console: any;
declare var Buffer: any;
declare var TextEncoder: any;
declare var TextDecoder: any;
declare var URL: any;
declare var URLSearchParams: any;
declare var fetch: any;
declare var WebSocket: any;
declare var structuredClone: any;
declare var AbortController: any;
declare var setTimeout: any;
declare var clearTimeout: any;
declare var setInterval: any;
declare var clearInterval: any;
declare var queueMicrotask: any;
declare var SharedArrayBuffer: any;
declare var Int32Array: any;
declare var Uint8Array: any;
declare var Atomics: any;
declare var document: any;
declare var window: any;
declare var location: any;
declare var localStorage: any;

interface ImportMeta {
  url: string;
}

// Browser globals used by page-side functions in the CDP verification scripts
// (they are stringified and executed inside the real client).
declare var getComputedStyle: any;
declare var Event: any;
declare var matchMedia: any;
declare var location: any;
declare var history: any;
declare var fetch: any;
declare var encodeURIComponent: any;
declare var requestAnimationFrame: any;
declare var cancelAnimationFrame: any;
declare var IntersectionObserver: any;
declare var ResizeObserver: any;
declare var DOMRect: any;
