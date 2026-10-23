import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/** Drizzle database tests: real PostgreSQL (PGlite + pgvector) migrated from ./drizzle by drizzle-orm's migrator. */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./node_modules/server-only/empty.js", import.meta.url)),
    },
  },
  test: { include: ["tests/db/**/*.test.ts"], environment: "node", testTimeout: 60_000, hookTimeout: 120_000 },
});
