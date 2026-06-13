import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  renderGitHubIssueBody,
  renderIssuePacket,
  renderIssueTask,
} from "../dist/index.js";

const indexed = createIndexedIssue();

await assertGolden("issue-task.codex.md", renderIssueTask(indexed, "codex"));
await assertGolden("issue-packet.md", renderIssuePacket(indexed));
await assertGolden("github-body.md", renderGitHubIssueBody(indexed));

console.log("handoff golden outputs verified");

async function assertGolden(name, actual) {
  const expected = await readFile(
    path.join("tests", "fixtures", "handoff", name),
    "utf8",
  );
  const normalizedActual = `${normalizeOutput(actual).trimEnd()}\n`;

  if (normalizedActual !== expected) {
    throw new Error(
      [
        `golden fixture mismatch: ${name}`,
        "",
        "Actual:",
        normalizedActual,
        "Expected:",
        expected,
      ].join("\n"),
    );
  }
}

function normalizeOutput(value) {
  const normalizedCwd = process.cwd().replaceAll("\\", "/");
  return value.replaceAll("\\", "/").replaceAll(normalizedCwd, "<cwd>");
}

function createIndexedIssue() {
  const screenshotPath = path.join(
    process.cwd(),
    ".ui-feedback",
    "latest",
    "screenshots",
    "issue-i-golden1.png",
  );
  const screenshot = {
    name: "issue-i-golden1.png",
    kind: "element",
    width: 360,
    height: 120,
    devicePixelRatio: 1,
    captureStrategy: "html2canvas",
    mimeType: "image/png",
    byteLength: 8,
    hash: "sha256-0000000000000000000000000000000000000000000000000000000000000000",
  };
  const issue = {
    id: 1,
    stableId: "i-golden1",
    kind: "single",
    measured: [
      'Selector: [data-testid="checkout-button"]',
      "Source: src/components/CheckoutButton.tsx:42",
      "Bbox: x=120, y=240, w=180, h=44",
      "Styles:",
      "  padding: 12px 16px",
      "  background-color: #1f6feb",
    ].join("\n"),
    selector: '[data-testid="checkout-button"]',
    source: "src/components/CheckoutButton.tsx:42",
    target: {
      selector: '[data-testid="checkout-button"]',
      fallbackSelector: "main > section:nth-of-type(2) > button",
      selectorConfidence: "high",
      selectorReason: "unique data-testid",
      tag: "button",
      id: "checkout-button",
      classes: ["btn", "btn-primary", "px-4"],
      text: "Upgrade now",
      role: "button",
      accessibleName: "Upgrade now",
      testId: "checkout-button",
      nearestTestId: "pricing-card",
      nearestLandmark: "main",
      source: "src/components/CheckoutButton.tsx:42",
      sourceConfidence: "high",
      sourceResolver: "data-vernier-source",
      componentName: "CheckoutButton",
      ownerChain: ["PricingPage", "PricingCard", "CheckoutButton"],
      ancestry: [
        { tag: "main", classes: [], role: "main" },
        { tag: "section", classes: ["pricing-card"], testId: "pricing-card" },
        {
          tag: "button",
          id: "checkout-button",
          classes: ["btn", "btn-primary", "px-4"],
          role: "button",
          testId: "checkout-button",
          text: "Upgrade now",
        },
      ],
    },
    measurement: {
      kind: "single",
      bbox: {
        x: 120,
        y: 240,
        width: 180,
        height: 44,
        top: 240,
        right: 300,
        bottom: 284,
        left: 120,
      },
      computedStyle: {
        padding: "12px 16px",
        "background-color": "#1f6feb",
        color: "#ffffff",
        "font-size": "16px",
      },
      text: "Upgrade now",
      role: "button",
      accessibleName: "Upgrade now",
      inlineStyle: {},
      authoredHints: [
        {
          selector: ".btn-primary",
          property: "background-color",
          value: "var(--color-primary)",
          source: "src/styles/buttons.css",
        },
      ],
      classHints: ["btn-primary", "px-4"],
      designTokenHints: [
        {
          property: "background-color",
          computed: "#1f6feb",
          token: "--color-primary",
          value: "#1f6feb",
          distance: 0,
        },
      ],
    },
    redaction: { autoRedactedElements: 1, manualRedaction: false },
    note: "Button should align with the pricing card CTA.",
    createdAt: "2026-06-12T10:01:00.000Z",
    screenshotName: "issue-i-golden1.png",
    screenshotDataUrl: "data:image/png;base64,iVBORw0KGgo=",
    screenshot,
  };
  const session = {
    schemaVersion: 1,
    toolVersion: "0.0.0",
    sessionId: "s-golden123456",
    title: "golden handoff",
    route: "/pricing",
    url: "http://127.0.0.1:5173/pricing",
    viewport: { width: 1440, height: 900, devicePixelRatio: 1 },
    createdAt: "2026-06-12T10:00:00.000Z",
    issueCount: 1,
    issues: [issue],
    fullPageScreenshotName: "full-page.png",
    fullPageScreenshotDataUrl: "data:image/png;base64,iVBORw0KGgo=",
    fullPageScreenshot: {
      ...screenshot,
      name: "full-page.png",
      kind: "full-page",
      width: 1440,
      height: 2200,
    },
  };

  return {
    stableId: issue.stableId,
    status: "todo",
    session,
    issue,
    sessionDirectory: path.join(process.cwd(), ".ui-feedback", "latest"),
    screenshotPath,
  };
}
