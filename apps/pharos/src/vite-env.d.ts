/// <reference types="vite/client" />

// Declaration merging with Vite's own interfaces needs `interface`.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
interface ImportMetaEnv {
  /** Set to `1` to build the page with `window.__apeironTest` (the resilience suite's read-only hooks). */
  readonly VITE_TEST_HOOKS?: string;
}
