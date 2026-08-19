/// <reference types="svelte" />
/// <reference types="vite/client" />

/**
 * The version from `package.json`, replaced at build time by Vite's `define`.
 *
 * A literal in the bundle, not a runtime import of the manifest — so the app reports its
 * version without shipping `package.json` to the browser, and the number cannot drift
 * from the one the release workflow checks against the tag.
 */
declare const __APP_VERSION__: string;

/** The repository the About link points at, also from `package.json`. */
declare const __REPO_URL__: string;
