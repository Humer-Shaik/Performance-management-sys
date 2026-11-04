import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Database test files create shared roles; run files one at a time.
    fileParallelism: false,
  },
});
