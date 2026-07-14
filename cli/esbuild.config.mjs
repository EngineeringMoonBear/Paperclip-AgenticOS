/**
 * esbuild configuration for building the paperclipai CLI.
 *
 * AgenticOS self-hosting note: this builds a *self-contained* CLI for the
 * Docker image. It bundles the workspace packages (@paperclipai/* except
 * `server`) AND third-party npm deps (zod, drizzle-orm, commander, …) into a
 * single dist/index.js, so the CLI runs via `node dist/index.js` without
 * relying on pnpm's non-flat node_modules symlinks — transitive deps like
 * `zod` have no symlink at the CLI package level and otherwise fail at runtime
 * with ERR_MODULE_NOT_FOUND.
 *
 * Only packages that cannot be bundled stay external:
 *   - @paperclipai/server — resolved at runtime via dynamic import (+ own deps)
 *   - embedded-postgres + its per-platform binaries — dynamic platform imports
 *     (never invoked when DATABASE_URL is set; resolved from node_modules if so)
 *   - native addons — resolved from node_modules at runtime if present
 */

// Only packages esbuild cannot bundle stay external. Unlike the upstream
// config (v2026.707.0), we do NOT externalize third-party npm deps (zod,
// drizzle-orm, commander, …) — they must be bundled so the CLI runs in the
// pnpm-symlinked Docker image without ERR_MODULE_NOT_FOUND (see header note).
const EXTERNAL = [
  "@paperclipai/server",
  "embedded-postgres",
  "@embedded-postgres/*",
  "better-sqlite3",
  "pg-native",
  "bufferutil",
  "utf-8-validate",
  "fsevents",
  "cpu-features",
];

/** @type {import('esbuild').BuildOptions} */
export default {
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "dist/index.js",
  // Shebang + createRequire shim so bundled CJS deps can call require() under ESM.
  banner: {
    js: "#!/usr/bin/env node\nimport{createRequire as ___createRequire}from'module';const require=___createRequire(import.meta.url);",
  },
  external: EXTERNAL,
  treeShaking: true,
  sourcemap: true,
};
