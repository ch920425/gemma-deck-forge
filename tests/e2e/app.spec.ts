import { test, expect } from "@playwright/test";

test("loads the deck workspace and handles Supabase context fallback", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Gemma Deck Forge" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Generate deck/i })).toBeVisible();

  await page.getByRole("button", { name: /Fetch gbrain context/i }).click();
  await expect(page.getByTestId("gbrain-status")).toHaveText(/hits|cli unavailable/i, { timeout: 30_000 });
});

test("can generate a deck board through the app flow", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Generate deck/i }).click();
  await expect(page.getByRole("heading", { name: /Gemma Deck Forge|Instant Deck Forge/i })).toBeVisible({
    timeout: 90_000
  });
  await expect(page.locator(".slideCard")).toHaveCount(6, { timeout: 90_000 });
});

test("prepares the parallel Figma finalizer script from the UI", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Generate deck/i }).click();
  await expect(page.locator(".slideCard")).toHaveCount(6, { timeout: 90_000 });
  await page.getByRole("button", { name: /Build in Figma/i }).click();
  await expect(page.getByRole("heading", { name: "Parallel Figma Finalizer" })).toBeVisible();
  await expect(page.locator(".stageCard")).toHaveCount(50);
  await expect(page.getByText(/actionsPerSecond/)).toBeVisible();
});
