import { test, expect } from "@playwright/test";

test.describe("Navigation", () => {
  test("loads the dashboard", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/Ollama Admin/);
  });

  test("sidebar navigates to all main pages", async ({ page }) => {
    await page.goto("/");

    await page.click('a[href="/chat"]');
    await expect(page).toHaveURL(/\/chat/);

    await page.click('a[href="/discover"]');
    await expect(page).toHaveURL(/\/discover/);
  });

  // AUTH_DISABLED has no session, so the sidebar hides the admin group; visit the pages directly.
  for (const path of ["/admin/models", "/admin/servers", "/admin/logs", "/admin/metrics", "/admin/users", "/admin/api-keys", "/gpu"]) {
    test(`admin page ${path} loads`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await expect(page.getByRole("heading").first()).toBeVisible();
    });
  }

  test("settings page loads", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.locator("h1")).toContainText(/Settings|Ajustes/);
  });
});
