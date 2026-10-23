import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/** Live model tests. Network + ANTHROPIC_API_KEY required; skipped otherwise. */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./node_modules/server-only/empty.js", import.meta.url)),
    },
  },
  test: { include: ["tests/live/**/*.live.test.ts"], environment: "node", testTimeout: 180_000 },
});
