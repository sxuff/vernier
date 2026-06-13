import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listLatestIssues, updateLatestIssueNote } from "../dist/index.js";

const root = await mkdtemp(path.join(os.tmpdir(), "vernier-core-errors-"));

try {
  await listLatestIssues(root);
  throw new Error("expected missing session to fail");
} catch (error) {
  assert(
    error?.code === "VERNIER_NO_SESSION",
    `expected VERNIER_NO_SESSION, got ${error?.code}`,
  );
  assert(
    error?.hint?.includes("export a session"),
    "missing session error should include hint",
  );
}

const sessionDirectory = path.join(root, ".ui-feedback", "sessions", "legacy");
await mkdir(sessionDirectory, { recursive: true });
await writeFile(
  path.join(sessionDirectory, "session.json"),
  `${JSON.stringify(createLegacySession(), null, 2)}\n`,
);

const [legacyIssue] = await listLatestIssues(root);
await updateLatestIssueNote(root, legacyIssue.stableId, "edited note");
const [editedIssue] = await listLatestIssues(root);

assert(
  editedIssue.stableId === legacyIssue.stableId,
  "fallback stable ID should survive note edits",
);
assert(editedIssue.issue.note === "edited note", "note edit should persist");

console.log("core errors verified");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function createLegacySession() {
  const png = "data:image/png;base64,iVBORw0KGgo=";
  const screenshot = {
    name: "issue-1.png",
    kind: "element",
    width: 1,
    height: 1,
    devicePixelRatio: 1,
    captureStrategy: "html2canvas",
    mimeType: "image/png",
    byteLength: 8,
    hash: "sha256-0000000000000000000000000000000000000000000000000000000000000000",
  };

  return {
    schemaVersion: 1,
    toolVersion: "0.0.0",
    sessionId: "s-legacy",
    route: "/",
    url: "http://127.0.0.1:5173/",
    viewport: { width: 800, height: 600, devicePixelRatio: 1 },
    createdAt: "2026-06-12T00:00:00.000Z",
    issueCount: 1,
    fullPageScreenshotName: "full-page.png",
    fullPageScreenshotDataUrl: png,
    fullPageScreenshot: {
      ...screenshot,
      name: "full-page.png",
      kind: "full-page",
    },
    issues: [
      {
        id: 1,
        kind: "single",
        measured: 'Selector: [data-testid="legacy"]',
        selector: '[data-testid="legacy"]',
        source: "src/Legacy.tsx:1",
        target: {
          selector: '[data-testid="legacy"]',
          selectorConfidence: "high",
          selectorReason: "unique data-testid",
          tag: "button",
          classes: [],
          source: "src/Legacy.tsx:1",
          sourceConfidence: "high",
          sourceResolver: "data-vernier-source",
          ownerChain: [],
          ancestry: [],
        },
        note: "initial note",
        createdAt: "2026-06-12T00:00:00.000Z",
        screenshotName: "issue-1.png",
        screenshotDataUrl: png,
        screenshot,
      },
    ],
  };
}
