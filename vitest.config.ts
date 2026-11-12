import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["shared.ts", "contract.ts", "server.ts", "host.ts"],
      reportsDirectory: "coverage",
    },
  },
});
