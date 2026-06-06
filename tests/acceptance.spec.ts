import { expect, test } from "@playwright/test";
import { rm, readFile } from "node:fs/promises";
import path from "node:path";

const exampleRoot = path.join(process.cwd(), "examples", "react-vite");
const feedbackRoot = path.join(exampleRoot, ".ui-feedback");

test.beforeEach(async () => {
  await rm(feedbackRoot, { recursive: true, force: true });
});

test("exports measured UI feedback session", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.locator("[data-vernier-root]").waitFor({ state: "attached" });
  await page.evaluate(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "F",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true
      })
    );
  });
  await expect(page.locator("[data-vernier-toolbar]")).toBeVisible();

  const usage = await page.locator(".usage-card").boundingBox();
  const revenue = await page.locator(".revenue-card").boundingBox();

  expect(usage).not.toBeNull();
  expect(revenue).not.toBeNull();

  if (!usage || !revenue) {
    throw new Error("Card bounding boxes were not available.");
  }

  await page.mouse.move(usage.x + usage.width / 2, usage.y + usage.height / 2);
  await page.mouse.click(usage.x + usage.width / 2, usage.y + usage.height / 2);
  await page.locator("[data-vernier-note]").fill("should share left edge with the card above");
  await page.locator("[data-vernier-add-issue]").click();
  await expect(page.locator("[data-vernier-status]")).toHaveText("Added issue 1");

  await page.mouse.move(revenue.x + revenue.width / 2, revenue.y + revenue.height / 2);
  await page.mouse.click(usage.x + usage.width / 2, usage.y + usage.height / 2);
  await page.mouse.move(revenue.x + revenue.width / 2, revenue.y + revenue.height / 2);
  await page.mouse.click(revenue.x + revenue.width / 2, revenue.y + revenue.height / 2);
  await page.locator("[data-vernier-note]").fill("align these card edges");
  await page.locator("[data-vernier-add-issue]").click();
  await expect(page.locator("[data-vernier-status]")).toHaveText("Added issue 2");
  await page.locator("[data-vernier-export]").click();

  await expect(page.locator("[data-vernier-status]")).toHaveText("Exported");

  const sessionMarkdown = await readFile(path.join(feedbackRoot, "latest", "session.md"), "utf8");

  expect(sessionMarkdown).toContain("12px");
  expect(sessionMarkdown).toMatch(/Source: (src\/.*RevenueCard\.tsx:\d+|unresolved)/);
});
