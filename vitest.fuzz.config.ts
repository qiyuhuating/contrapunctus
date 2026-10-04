import { defineConfig } from "vitest/config";

// Full chaos fuzz suites. Run via `npm run fuzz`.
export default defineConfig({
  test: {
    include: ["tests/**/*.suite.ts"],
    testTimeout: 120000,
  },
});
