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
  await page.locator("[data-vernier-issue-id='1']").click();
  await page.locator("[data-vernier-note]").fill("edited exploratory note");
  await page.locator("[data-vernier-save-issue]").click();
  await expect(page.locator("[data-vernier-status]")).toHaveText("Saved issue 1");
  await page.locator("[data-vernier-delete-issue]").click();
  await expect(page.locator("[data-vernier-status]")).toHaveText("Deleted issue");
  await expect(page.locator("[data-vernier-issue-list]")).toHaveAttribute("data-vernier-issue-count", "0");

  await page.mouse.move(revenue.x + revenue.width / 2, revenue.y + revenue.height / 2);
  await page.mouse.click(usage.x + usage.width / 2, usage.y + usage.height / 2);
  await page.mouse.move(revenue.x + revenue.width / 2, revenue.y + revenue.height / 2);
  await page.mouse.click(revenue.x + revenue.width / 2, revenue.y + revenue.height / 2);
  await page.locator("[data-vernier-note]").fill("align these card edges");
  await page.locator("[data-vernier-add-issue]").click();
  await expect(page.locator("[data-vernier-status]")).toHaveText("Added issue 1");
  await page.locator("[data-vernier-copy-markdown]").click();
  await expect(page.locator("[data-vernier-status]")).toHaveText("Copy from selected text");
  await expect(page.locator("[data-vernier-copy-fallback]")).toBeVisible();
  await page.evaluate(() => {
    const clipboard = { value: "" };
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: function () {
          const value = String(arguments[0]);
          clipboard.value = value;
          window.localStorage.setItem("vernierClipboard", value);
          return Promise.resolve();
        }
      }
    });
  });
  await page.locator("[data-vernier-copy-prompt]").click();
  await expect(page.locator("[data-vernier-status]")).toHaveText("Copied prompt");
  const copiedPrompt = await page.evaluate(() => window.localStorage.getItem("vernierClipboard") ?? "");
  expect(copiedPrompt).toContain("Use the Vernier UI feedback session below.");
  expect(copiedPrompt).toContain("align these card edges");
  await page.locator("[data-vernier-export]").click();

  await expect(page.locator("[data-vernier-status]")).toHaveText("Exported");

  const sessionMarkdown = await readFile(path.join(feedbackRoot, "latest", "session.md"), "utf8");
  const sessionJson = JSON.parse(await readFile(path.join(feedbackRoot, "latest", "session.json"), "utf8")) as {
    schemaVersion: number;
    sessionId: string;
    issueCount: number;
    issues: Array<{
      stableId: string;
      note: string;
      target: {
        selectorConfidence: string;
        tag: string;
        nearestTestId?: string;
        ancestry: unknown[];
      };
    }>;
  };

  expect(sessionMarkdown).toContain("12px");
  expect(sessionMarkdown).toContain("Instruction:");
  expect(sessionMarkdown).toContain("Measured:");
  expect(sessionMarkdown).toContain("Issue count: 1");
  expect(sessionMarkdown).not.toContain("edited exploratory note");
  expect(sessionMarkdown).toMatch(/Source: (src\/.*RevenueCard\.tsx:\d+|unresolved)/);
  expect(sessionJson.issueCount).toBe(1);
  expect(sessionJson.schemaVersion).toBe(1);
  expect(sessionJson.sessionId).toMatch(/^s-/);
  expect(sessionJson.issues[0]?.stableId).toMatch(/^i-/);
  expect(sessionJson.issues[0]?.note).toBe("align these card edges");
  expect(sessionJson.issues[0]?.target.selectorConfidence).toBe("high");
  expect(sessionJson.issues[0]?.target.tag).toBe("article");
  expect(sessionJson.issues[0]?.target.nearestTestId).toBe("revenue-card");
  expect(sessionJson.issues[0]?.target.ancestry.length).toBeGreaterThan(0);
});
