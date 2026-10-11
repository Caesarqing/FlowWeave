import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["tests/setup-transaction-authority.ts"],
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000
  }
});
