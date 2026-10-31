import { test, expect } from "@playwright/test";

test.describe("Settings Page", () => {
  test("displays theme selector", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.locator('[role="radiogroup"]').first()).toBeVisible();
  });

  test("displays density selector", async ({ page }) => {
    await page.goto("/settings");
    const radioGroups = page.locator('[role="radiogroup"]');
    await expect(radioGroups.nth(1)).toBeVisible();
  });

  test("displays language selector", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.locator('select[aria-label]').first()).toBeVisible();
  });

  test("explains automatic log retention", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByText(/Logging & Privacy/)).toBeVisible();
    await expect(page.getByText(/deleted automatically every 6 hours/)).toBeVisible();
  });

  test("displays rate limit section", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByText(/Rate Limiting|Limitación/)).toBeVisible();
  });

  test("displays database status", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByText(/Connected|Conectado/)).toBeVisible();
  });
});
