import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
    },
    passWithNoTests: false,
    restoreMocks: true,
    setupFiles: [fileURLToPath(new URL("./test/setup.ts", import.meta.url))],
  },
});
