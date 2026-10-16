import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/tests/**/*.ts", "**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    testTimeout: 20000,
  },
});
