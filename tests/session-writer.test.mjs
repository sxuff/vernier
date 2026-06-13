import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveFeedbackDirectory, writeSession } from "../dist/index.js";

const root = await mkdtemp(path.join(os.tmpdir(), "vernier-session-writer-"));
const createdAt = "2026-06-11T12:34:56.789Z";

const first = createSession("s-testsession1", "i-testissue1", createdAt);
const second = createSession("s-testsession2", "i-testissue2", createdAt);

const firstDirectory = await writeSession(root, first);
const secondDirectory = await writeSession(root, second);

assert(
  firstDirectory !== secondDirectory,
  "same-route sessions should write to unique directories",
);
await assertFile(
  path.join(firstDirectory, "session.json"),
  "first session should not be overwritten",
);
await assertFile(
  path.join(secondDirectory, "session.json"),
  "second session should be written",
);

const sessions = await readdir(path.join(root, ".ui-feedback", "sessions"));
assert(
  sessions.length === 2,
  `expected two session directories, got ${sessions.length}`,
);

const latestSession = JSON.parse(
  await readFile(
    path.join(root, ".ui-feedback", "latest", "session.json"),
    "utf8",
  ),
);
assert(
  latestSession.sessionId === second.sessionId,
  "latest should point at the newest session",
);
assert(
  !("fullPageScreenshotDataUrl" in latestSession),
  "session.json should not embed the full-page screenshot data URL",
);
assert(
  !("screenshotDataUrl" in latestSession.issues[0]),
  "session.json should not embed issue screenshot data URLs",
);

const latestMetadata = JSON.parse(
  await readFile(path.join(root, ".ui-feedback", "latest.json"), "utf8"),
);
assert(
  latestMetadata.kind === "junction" || latestMetadata.kind === "copy",
  "latest metadata should record link strategy",
);
assert(
  latestMetadata.target.startsWith("sessions"),
  "latest metadata target should be relative to .ui-feedback",
);

const markdown = await readFile(
  path.join(root, ".ui-feedback", "latest", "session.md"),
  "utf8",
);
assert(
  markdown.includes("Schema version: 1"),
  "markdown should include schema version",
);
assert(
  markdown.includes(`Session ID: ${second.sessionId}`),
  "markdown should include session id",
);

const inventory = JSON.parse(
  await readFile(
    path.join(root, ".ui-feedback", "latest", "screenshots.json"),
    "utf8",
  ),
);
assert(
  inventory.length === 2,
  "screenshot inventory should include full-page and issue screenshots",
);

const customDirectory = await writeSession(
  root,
  createSession("s-customsession", "i-customissue", createdAt),
  { outDir: ".vernier-feedback" },
);
assert(
  customDirectory.includes(".vernier-feedback"),
  "custom outDir should be used for session writes",
);
await assertFile(
  path.join(root, ".vernier-feedback", "latest", "session.json"),
  "custom outDir should have a latest session",
);
assertStructuredError(
  () => resolveFeedbackDirectory(root, "../escape"),
  "VERNIER_INVALID_CONFIG",
);

console.log("session writer verified");

async function assertFile(filePath, message) {
  const file = await stat(filePath).catch(() => null);
  assert(file?.isFile(), message);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertStructuredError(action, code) {
  try {
    action();
  } catch (error) {
    assert(error?.code === code, `expected ${code}, got ${error?.code}`);
    return;
  }

  throw new Error(`expected ${code}`);
}

function createSession(sessionId, issueId, timestamp) {
  const png = "data:image/png;base64,iVBORw0KGgo=";
  const issueScreenshot = createScreenshotArtifact(
    "issue-1.png",
    "element",
    png,
  );
  const fullPageScreenshot = createScreenshotArtifact(
    "full-page.png",
    "full-page",
    png,
  );

  return {
    schemaVersion: 1,
    toolVersion: "0.0.0",
    sessionId,
    route: "/",
    url: "http://127.0.0.1:5173/",
    viewport: {
      width: 1280,
      height: 720,
      devicePixelRatio: 1,
    },
    createdAt: timestamp,
    issueCount: 1,
    issues: [
      {
        id: 1,
        stableId: issueId,
        kind: "single",
        measured: "Selector: body",
        selector: "body",
        source: "unresolved",
        target: {
          selector: "body",
          selectorConfidence: "medium",
          selectorReason: "unique DOM selector",
          tag: "body",
          classes: [],
          source: "unresolved",
          sourceConfidence: "low",
          sourceResolver: "fallback-dom",
          ownerChain: [],
          ancestry: [],
        },
        note: "session writer fixture",
        createdAt: timestamp,
        screenshotName: "issue-1.png",
        screenshotDataUrl: png,
        screenshot: issueScreenshot,
      },
    ],
    fullPageScreenshotName: "full-page.png",
    fullPageScreenshotDataUrl: png,
    fullPageScreenshot,
  };
}

function createScreenshotArtifact(name, kind, dataUrl) {
  return {
    name,
    kind,
    width: 1,
    height: 1,
    devicePixelRatio: 1,
    captureStrategy: "html2canvas",
    mimeType: "image/png",
    byteLength: Buffer.byteLength(dataUrl.split(",")[1], "base64"),
    hash: "sha256-0000000000000000000000000000000000000000000000000000000000000000",
  };
}
