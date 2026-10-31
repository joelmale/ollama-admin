import { defineConfig, devices } from "@playwright/test";

// A dedicated port so the suite never attaches to another app on :3000.
const port = Number(process.env.E2E_PORT ?? 3100);
const dbUrl = `file:${process.cwd().replace(/\\/g, "/")}/e2e/.tmp/e2e.db`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `node e2e/prepare-db.mjs && npx next dev -p ${port}`,
    port,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
    env: {
      DATABASE_URL: dbUrl,
      AUTH_DISABLED: "true",
      NEXTAUTH_SECRET: "e2e-only-secret",
      NEXTAUTH_URL: `http://localhost:${port}`,
    },
  },
});
