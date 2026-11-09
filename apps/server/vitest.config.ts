import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // The CLI is a thin shell over the admin API and is smoke-tested by hand.
      exclude: ["src/**/*.test.ts", "src/test/**", "src/cli.ts"],
      thresholds: { lines: 95, functions: 95, branches: 90, statements: 95 },
    },
  },
});
