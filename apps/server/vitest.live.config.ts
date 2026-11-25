import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The live provider checks (live/live.test.ts). They spend real money, so
 * they run only on request: `pnpm test:live`, never in CI or `pnpm test`.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@roai-us/roi-core": fileURLToPath(
        new URL("../../packages/roi-core/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["live/**/*.test.ts"],
    // One provider at a time, with time for real networks.
    fileParallelism: false,
    testTimeout: 60_000,
  },
});
