import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/**
 * Present so `svelte-check` can find the preprocessor without evaluating
 * `vite.config.ts` (which reads `process.env` and registers a dev-only
 * middleware it has no business loading).
 */
export default { preprocess: vitePreprocess() };
