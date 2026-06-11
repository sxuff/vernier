import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { handleVernierSessionRequest } from "../dist/index.js";

const root = await mkdtemp(path.join(os.tmpdir(), "vernier-session-handler-"));
const server = createServer((request, response) => {
  void handleVernierSessionRequest(root, request, response).then((handled) => {
    if (!handled) {
      response.statusCode = 404;
      response.end("not found");
    }
  });
});
const port = await listen(server);

try {
  await expectJsonResponse("GET", "/__vernier/session", undefined, 405, "Method not allowed");
  await expectJsonResponse("POST", "/__vernier/session", "{", 400, "Session payload must be valid JSON");
  await expectJsonResponse("POST", "/__vernier/session", createSessionPayload({ schemaVersion: 2 }), 400, "schemaVersion must be 1");
  await expectJsonResponse("POST", "/__vernier/session", createSessionPayload({ screenshotName: "../escape.png" }), 400, "safe filename");
  await expectJsonResponse("POST", "/__vernier/session", createSessionPayload({ issueCount: 2 }), 400, "issueCount must match");
  await expectJsonResponse("POST", "/__vernier/session", createSessionPayload({ hash: "sha256-nope" }), 400, "sha256");

  const ok = await requestJson("POST", "/__vernier/session", createSessionPayload());
  assert(ok.status === 200, `expected valid session to write, got ${ok.status}: ${ok.text}`);
  assert(ok.json.ok === true, "expected success payload");

  const session = JSON.parse(await readFile(path.join(root, ".ui-feedback", "latest", "session.json"), "utf8"));
  assert(session.sessionId === "s-testsession1", "expected latest session to be written");

  console.log("session handler verified");
} finally {
  await close(server);
}

async function expectJsonResponse(method, requestPath, body, status, messagePart) {
  const result = await requestJson(method, requestPath, body);

  assert(result.status === status, `expected ${status}, got ${result.status}: ${result.text}`);
  assert(result.json.error?.includes(messagePart), `expected error to include ${messagePart}, got ${result.text}`);
}

async function requestJson(method, requestPath, body) {
  const response = await fetch(`http://127.0.0.1:${port}${requestPath}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body)
  });
  const text = await response.text();

  return {
    status: response.status,
    text,
    json: JSON.parse(text)
  };
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address === "object", "expected TCP server address");
      resolve(address.port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function createSessionPayload(overrides = {}) {
  const png = overrides.screenshotDataUrl ?? "data:image/png;base64,iVBORw0KGgo=";
  const screenshotName = overrides.screenshotName ?? "issue-1.png";
  const hash = overrides.hash ?? "sha256-0000000000000000000000000000000000000000000000000000000000000000";
  const screenshot = {
    name: screenshotName,
    kind: "element",
    width: 1,
    height: 1,
    devicePixelRatio: 1,
    captureStrategy: "html2canvas",
    mimeType: "image/png",
    byteLength: Buffer.byteLength(png.split(",")[1] ?? "", "base64"),
    hash
  };

  return {
    schemaVersion: overrides.schemaVersion ?? 1,
    toolVersion: "0.0.0",
    sessionId: "s-testsession1",
    route: "/",
    url: "http://127.0.0.1/",
    viewport: {
      width: 1280,
      height: 720,
      devicePixelRatio: 1
    },
    createdAt: "2026-06-11T12:34:56.789Z",
    issueCount: overrides.issueCount ?? 1,
    issues: [
      {
        id: 1,
        stableId: "i-testissue1",
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
          ancestry: []
        },
        note: "handler fixture",
        createdAt: "2026-06-11T12:34:56.789Z",
        screenshotName,
        screenshotDataUrl: png,
        screenshot
      }
    ],
    fullPageScreenshotName: "full-page.png",
    fullPageScreenshotDataUrl: png,
    fullPageScreenshot: {
      ...screenshot,
      name: "full-page.png",
      kind: "full-page"
    }
  };
}
