import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: [],
    exclude: ["e2e/**", "node_modules/**"],
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
    // UI pages are exercised by Playwright; unit coverage targets server-side code.
    coverage: {
      provider: "v8",
      include: ["lib/**", "app/api/**", "proxy.ts"],
      exclude: ["**/__tests__/**", "**/*.test.ts"],
      reporter: ["text-summary", "json-summary"],
      // Ratchet: autoUpdate raises these floors whenever coverage improves.
      thresholds: {
        autoUpdate: true,
        lines: 87.39,
        statements: 87.39,
        functions: 87.91,
        branches: 87.24,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});