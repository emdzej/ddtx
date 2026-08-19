import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig, type Plugin } from "vite";

/**
 * Serve the split database tree at `/db` straight off disk in development.
 *
 * The tree is 1.19 GB, so it cannot live in `public/`. It is read straight from
 * `data/tree` — where `pnpm db:split` puts it — with no copying, no symlinks, and
 * no separate server, so `pnpm dev` needs no environment at all. `DDTX_DB_TREE`
 * overrides the location.
 *
 * In production `/db` is a static tree on whatever host serves the app, so this
 * plugin is development-only and the client code is identical either way.
 */
function serveDatabaseTree(): Plugin {
  // `pnpm db:split` writes here, so the common case needs no environment at all.
  // `data/` is git-ignored, which is where the un-redistributable database
  // belongs anyway.
  const defaultRoot = fileURLToPath(new URL("../../data/tree", import.meta.url));
  const root = process.env.DDTX_DB_TREE ?? defaultRoot;

  return {
    name: "ddtx-serve-db-tree",
    apply: "serve",
    configureServer(server) {
      if (!existsSync(join(root, "index.json"))) {
        server.config.logger.warn(
          `[ddtx] no database tree at ${root} — /db will 404. Run \`pnpm db:split\`.`,
        );
        return;
      }
      server.config.logger.info(`[ddtx] serving /db from ${root}`);

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

/**
 * Serve the built translation bundles at `/i18n`.
 *
 * Separate from the database tree because they have different lifecycles: the
 * tree is a fixed upstream snapshot, the bundles are ours and change whenever a
 * translation is edited. In production both are static directories.
 */
function serveTranslations(): Plugin {
  const root = fileURLToPath(new URL("../../i18n", import.meta.url));
  return {
    name: "ddtx-serve-i18n",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/i18n", (req, res, next) => {
        const requested = (req.url ?? "/").split("?")[0] ?? "/";
        const path = resolve(root, normalize(`.${sep}${requested}`));
        if (path !== root && !path.startsWith(root.endsWith(sep) ? root : root + sep)) {
          res.statusCode = 403;
          res.end("outside the translation directory");
          return;
        }
        try {
          if (!statSync(path).isFile()) return next();
          res.setHeader("content-type", "application/json; charset=utf-8");
          // Edited far more often than the tree, so no caching here.
          res.setHeader("cache-control", "no-cache");
          res.end(readFileSync(path));
        } catch {
          next();
        }
      });
    },
  };
}

/**
 * Emit the built translation bundles as build assets.
 *
 * `serveTranslations` is development-only, so without this a production build ships no
 * translations at all — and the failure is silent: `Overlay` falls back to the original
 * French, which looks like missing translation work rather than a missing file. That is
 * exactly the failure mode docs/i18n-overlay.md warns about, arriving by a different
 * route.
 *
 * Emitted rather than copied into `public/` because `i18n/` is generated output: it is
 * rebuilt by `pnpm i18n:build`, and duplicating it into a tracked directory would leave
 * two copies to disagree.
 */
function bundleTranslations(): Plugin {
  const root = fileURLToPath(new URL("../../i18n", import.meta.url));
  return {
    name: "ddtx-bundle-i18n",
    apply: "build",
    generateBundle() {
      if (!existsSync(root)) return;
      for (const locale of readdirSync(root, { withFileTypes: true })) {
        if (!locale.isDirectory() || locale.name === "source") continue;
        for (const file of ["bundle.json", "manifest.json"]) {
          const path = join(root, locale.name, file);
          if (!existsSync(path)) continue;
          this.emitFile({
            type: "asset",
            // Kept at the same path the dev middleware serves, so the client fetches
            // one URL either way.
            fileName: `i18n/${locale.name}/${file}`,
            source: readFileSync(path),
          });
        }
      }
    },
  };
}

/**
 * The app's own version and repository, surfaced in the UI.
 *
 * Read here and injected with `define`, so the bundle carries a string literal rather
 * than importing `package.json` at runtime. That keeps the manifest out of the browser
 * and keeps the displayed version identical to the one `release.yml` checks against the
 * git tag — the two cannot disagree.
 */
const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
) as { version: string; repository?: { url?: string } };

const REPO_URL = "https://github.com/emdzej/ddtx";

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(manifest.version),
    __REPO_URL__: JSON.stringify(manifest.repository?.url ?? REPO_URL),
  },
  // GitHub Pages serves under /<repo>/. Everything the client fetches at runtime goes
  // through `import.meta.env.BASE_URL`, which Vite derives from this.
  base: process.env.BASE_PATH ?? "/",
  plugins: [svelte(), serveDatabaseTree(), serveTranslations(), bundleTranslations()],
  server: { host: "0.0.0.0" },
});
