import { test, expect } from "@playwright/test";

test.describe("continue gate", () => {
  test("Approve & Continue is enabled when rerun passed", async ({ page }) => {
    await page.goto("/?e2e=1&e2eCurrentRun=paused&e2eRerun=passed");

    const button = page.getByRole("button", { name: "Approve & Continue" });
    await expect(button).toBeVisible();
    await expect(button).toBeEnabled();
  });

  test("Approve & Continue is disabled when rerun failed", async ({ page }) => {
    await page.goto("/?e2e=1&e2eCurrentRun=paused&e2eRerun=failed");

    const button = page.getByRole("button", { name: "Approve & Continue" });
    await expect(button).toBeVisible();
    await expect(button).toBeDisabled();
    await expect(page.getByText(/Continue Gate blockiert/i)).toBeVisible();
  });
});
