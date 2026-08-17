import { readFileSync, statSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig, type Plugin } from "vite";

/**
 * Serve the split database tree at `/db` straight off disk in development.
 *
 * The tree is 1.19 GB, so it cannot live in `public/`. Point `DDTX_DB_TREE` at
 * the output of `tools/db-split` and `pnpm dev` finds it with no copying, no
 * symlinks, and no separate server:
 *
 *   node tools/db-split/dist/index.js data/ecu.zip /tmp/ddtx-tree
 *   DDTX_DB_TREE=/tmp/ddtx-tree pnpm --filter @ddtx/web dev
 *
 * In production `/db` is a static tree on whatever host serves the app, so this
 * plugin is development-only and the client code is identical either way.
 */
function serveDatabaseTree(): Plugin {
  const root = process.env.DDTX_DB_TREE;

  return {
    name: "ddtx-serve-db-tree",
    apply: "serve",
    configureServer(server) {
      if (root === undefined) {
        server.config.logger.warn(
          "[ddtx] DDTX_DB_TREE is not set — /db will 404. Run tools/db-split and point it at the output.",
        );
        return;
      }

      // Resolved once so the containment check compares absolute paths, and with
      // a trailing separator so a sibling directory like `/tmp/ddtx-tree-evil`
      // can't satisfy a plain `startsWith` against `/tmp/ddtx-tree`.
      const base = resolve(root);
      const prefix = base.endsWith(sep) ? base : base + sep;

      server.middlewares.use("/db", (req, res, next) => {
        // Decode before normalising: `%2e%2e%2f` is a `../` that a check against
        // the raw URL would miss. Malformed escapes are a rejection, not a crash.
        let requested: string;
        try {
          requested = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
        } catch {
          res.statusCode = 400;
          res.end("undecodable path");
          return;
        }

        const path = resolve(base, normalize(`.${sep}${requested}`));
        if (path !== base && !path.startsWith(prefix)) {
          res.statusCode = 403;
          res.end("outside the database tree");
          return;
        }

        try {
          if (!statSync(path).isFile()) return next();
          res.setHeader("content-type", "application/json; charset=utf-8");
          // The tree is immutable for a given snapshot, so let the browser keep it.
          res.setHeader("cache-control", "public, max-age=3600");
          res.end(readFileSync(path));
        } catch {
          next();
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [svelte(), serveDatabaseTree()],
  server: { host: "0.0.0.0" },
});
