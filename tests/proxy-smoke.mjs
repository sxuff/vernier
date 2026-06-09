import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdir, readdir, rm, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { gzipSync } from "node:zlib";
import path from "node:path";

const root = process.cwd();
const targetPort = 4187;
const proxyPort = 4188;
const feedbackRoot = path.join(root, ".ui-feedback");
const nestedFeedbackRoot = path.join(root, "examples", "react-vite", ".ui-feedback");

await rm(feedbackRoot, { recursive: true, force: true });
await rm(nestedFeedbackRoot, { recursive: true, force: true });

const targetServer = createServer((request, response) => {
  if (request.url === "/compressed") {
    response.setHeader("Content-Type", "text/plain");
    response.setHeader("Content-Encoding", "gzip");
    response.end(gzipSync("compressed upstream response"));
    return;
  }

  if (request.url === "/host") {
    response.setHeader("Content-Type", "text/plain");
    response.end(request.headers.host ?? "");
    return;
  }

  response.setHeader("Content-Type", "text/html");
  response.end(`<!doctype html>
    <html>
      <head>
        <style>
          body { margin: 0; font-family: system-ui, sans-serif; }
          main { padding: 64px; }
          .card { width: 360px; height: 120px; padding: 24px; border-radius: 8px; background: #fff; color: #172033; box-sizing: border-box; border: 1px solid #d8dde8; }
          .usage-card { margin-left: 0; }
          .revenue-card { margin-top: 20px; margin-left: 12px; }
        </style>
      </head>
      <body>
        <main>
          <section class="usage-card card" data-testid="usage-card">Usage</section>
          <section class="revenue-card card" data-testid="revenue-card">Revenue</section>
        </main>
        <script type="module" src="/@vite/client"></script>
      </body>
    </html>`);
});

await verifyUnavailableTarget();

await listen(targetServer, targetPort);

const proxy = spawn(
  process.execPath,
  ["dist/cli.js", "proxy", "--target", `http://127.0.0.1:${targetPort}`, "--port", String(proxyPort)],
  { cwd: root, stdio: ["ignore", "pipe", "pipe"] }
);

try {
  await waitForOutput(proxy, "proxy listening");
  await verifyInvalidSessionRequests(proxyPort);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.goto(`http://127.0.0.1:${proxyPort}/`, { waitUntil: "networkidle" });
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

  const usage = await page.locator(".usage-card").boundingBox();
  const revenue = await page.locator(".revenue-card").boundingBox();
  if (!usage || !revenue) {
    throw new Error("Missing card bounding boxes.");
  }

  await page.mouse.move(usage.x + usage.width / 2, usage.y + usage.height / 2);
  await page.mouse.click(usage.x + usage.width / 2, usage.y + usage.height / 2);
  await page.locator("[data-vernier-note]").fill("align these cards");
  await page.locator("[data-vernier-add-issue]").click();
  await page.locator("[data-vernier-status]").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelector("[data-vernier-status]")?.textContent === "Added issue 1");

  await page.mouse.move(usage.x + usage.width / 2, usage.y + usage.height / 2);
  await page.mouse.click(usage.x + usage.width / 2, usage.y + usage.height / 2);
  await page.mouse.move(revenue.x + revenue.width / 2, revenue.y + revenue.height / 2);
  await page.mouse.click(revenue.x + revenue.width / 2, revenue.y + revenue.height / 2);
  await page.locator("[data-vernier-note]").fill("align these cards");
  await page.locator("[data-vernier-add-issue]").click();
  await page.waitForFunction(() => document.querySelector("[data-vernier-status]")?.textContent === "Added issue 2");
  await page.locator("[data-vernier-issue-id='2']").click();
  await page.locator("[data-vernier-note]").fill("edited delta note");
  await page.locator("[data-vernier-save-issue]").click();
  await page.waitForFunction(() => document.querySelector("[data-vernier-status]")?.textContent === "Saved issue 2");

  await page.locator("[data-vernier-mode]").selectOption("pen");
  await page.mouse.move(160, 160);
  await page.mouse.down();
  await page.mouse.move(220, 190);
  await page.mouse.up();
  await page.locator("[data-vernier-note]").fill("freehand annotation");
  await page.locator("[data-vernier-add-issue]").click();
  await page.waitForFunction(() => document.querySelector("[data-vernier-status]")?.textContent === "Added issue 3");

  await page.locator("[data-vernier-export]").click();
  await page.locator("[data-vernier-status]").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelector("[data-vernier-status]")?.textContent === "Exported");
  await page.locator("[data-vernier-export]").click();
  await page.waitForFunction(() => document.querySelector("[data-vernier-status]")?.textContent === "Exported");
  await browser.close();

  const sessionDirectories = await readdir(path.join(feedbackRoot, "sessions"));
  if (sessionDirectories.length !== 2) {
    throw new Error(`Expected two durable same-route sessions, got ${sessionDirectories.length}`);
  }

  const compressedResponse = await fetch(`http://127.0.0.1:${proxyPort}/compressed`);
  const compressedBody = await compressedResponse.text();
  if (compressedResponse.headers.has("content-encoding") || compressedBody !== "compressed upstream response") {
    throw new Error(`Expected decoded proxy response without stale content-encoding, got ${compressedBody}`);
  }

  const hostResponse = await fetch(`http://127.0.0.1:${proxyPort}/host`);
  const hostBody = await hostResponse.text();
  if (hostBody !== `127.0.0.1:${targetPort}`) {
    throw new Error(`Expected proxy to rewrite Host header to target host, got ${hostBody}`);
  }

  const sessionMarkdown = await readFile(path.join(feedbackRoot, "latest", "session.md"), "utf8");
  if (!sessionMarkdown.includes("Left edge delta: +12px")) {
    throw new Error(`Expected proxy session to contain +12px delta:\n${sessionMarkdown}`);
  }
  if (!sessionMarkdown.includes("Annotation: pen")) {
    throw new Error(`Expected proxy session to contain pen annotation:\n${sessionMarkdown}`);
  }
  if (!sessionMarkdown.includes("Issue count: 3") || !sessionMarkdown.includes("edited delta note")) {
    throw new Error(`Expected cleaner edited session output:\n${sessionMarkdown}`);
  }

  const latestOutput = await runNode(["dist/cli.js", "latest"]);
  const promptOutput = await runNode(["dist/cli.js", "prompt"]);
  const helpOutput = await runNode(["dist/cli.js", "--help"]);
  const detectOutput = await runNode(["dist/cli.js", "detect", "--ports", String(targetPort)]);

  await writeNestedSessionFixture(JSON.parse(await readFile(path.join(feedbackRoot, "latest", "session.json"), "utf8")));

  const issuesOutput = await runNode(["dist/cli.js", "issues"]);
  const stableIssueId = issuesOutput.match(/i-[a-f0-9]{6}/)?.[0];

  if (!stableIssueId) {
    throw new Error(`Expected issues command to print stable IDs:\n${issuesOutput}`);
  }

  const showOutput = await runNode(["dist/cli.js", "show", stableIssueId]);
  const copyOutput = await runNode(["dist/cli.js", "copy", stableIssueId, "--print"]);
  const verifyOutput = await runNode([
    "dist/cli.js",
    "verify",
    stableIssueId,
    "--target",
    `http://127.0.0.1:${targetPort}`
  ]);
  const sendOutput = await runNode(["dist/cli.js", "send", stableIssueId, "--to", "codex", "--print"]);
  const sendAllOutput = await runNode(["dist/cli.js", "send", "--to", "codex", "--print"]);
  const markOutput = await runNode(["dist/cli.js", "mark", stableIssueId, "fixed"]);
  const todoIssuesOutput = await runNode(["dist/cli.js", "issues", "--todo"]);
  const fixedIssuesOutput = await runNode(["dist/cli.js", "issues", "--fixed"]);
  const sendTodoOutput = await runNode(["dist/cli.js", "send", "--to", "codex", "--print"]);
  const sendAllAfterFixedOutput = await runNode(["dist/cli.js", "send", "--to", "codex", "--all", "--print"]);

  if (!latestOutput.includes("Issue count: 3")) {
    throw new Error(`Expected latest command to print session markdown:\n${latestOutput}`);
  }
  if (!promptOutput.includes("Use the Vernier UI feedback session below.") || !promptOutput.includes("Issue count: 3")) {
    throw new Error(`Expected prompt command to print handoff prompt:\n${promptOutput}`);
  }
  if (!helpOutput.includes("vernier [--target http://localhost:5173]") || !helpOutput.includes("vernier http://localhost:5173")) {
    throw new Error(`Expected help command to document CLI shorthand:\n${helpOutput}`);
  }
  if (!detectOutput.includes(`http://127.0.0.1:${targetPort}`) || !detectOutput.includes("Vite")) {
    throw new Error(`Expected detect command to find target app:\n${detectOutput}`);
  }
  if (!issuesOutput.includes("Latest session:") || !issuesOutput.includes("todo") || !issuesOutput.includes("make it red")) {
    throw new Error(`Expected issues command to list newest nested app-root session:\n${issuesOutput}`);
  }
  if (!showOutput.includes(`ID: ${stableIssueId}`) || !showOutput.includes("Status: todo") || !showOutput.includes("Screenshot:")) {
    throw new Error(`Expected show command to print issue detail:\n${showOutput}`);
  }
  if (!copyOutput.includes("Fix the UI issue captured by Vernier.") || !copyOutput.includes(stableIssueId)) {
    throw new Error(`Expected copy --print to produce issue task:\n${copyOutput}`);
  }
  if (
    !verifyOutput.includes(`Verify Vernier issue ${stableIssueId}.`) ||
    !verifyOutput.includes(`URL: http://127.0.0.1:${targetPort}/`) ||
    !verifyOutput.includes(`vernier mark ${stableIssueId} fixed`)
  ) {
    throw new Error(`Expected verify command to produce inspection instructions:\n${verifyOutput}`);
  }
  if (!sendOutput.includes("Fix the UI issue captured by Vernier.") || !sendOutput.includes(stableIssueId)) {
    throw new Error(`Expected send --print to produce issue task:\n${sendOutput}`);
  }
  if (!sendAllOutput.includes("Fix the UI issues captured by Vernier.") || !sendAllOutput.includes(stableIssueId)) {
    throw new Error(`Expected send --to codex --print to produce all-issues task:\n${sendAllOutput}`);
  }
  if (!markOutput.includes(`Marked ${stableIssueId} fixed.`)) {
    throw new Error(`Expected mark command to update issue status:\n${markOutput}`);
  }
  if (todoIssuesOutput.includes(stableIssueId)) {
    throw new Error(`Expected fixed issue to be hidden from --todo filter:\n${todoIssuesOutput}`);
  }
  if (!fixedIssuesOutput.includes(stableIssueId) || !fixedIssuesOutput.includes("fixed")) {
    throw new Error(`Expected fixed issue to appear in --fixed filter:\n${fixedIssuesOutput}`);
  }
  if (!sendTodoOutput.includes("No todo issues in latest Vernier session.")) {
    throw new Error(`Expected default send to skip fixed issues:\n${sendTodoOutput}`);
  }
  if (!sendAllAfterFixedOutput.includes(stableIssueId) || !sendAllAfterFixedOutput.includes("Status: fixed")) {
    throw new Error(`Expected send --all to include fixed issues:\n${sendAllAfterFixedOutput}`);
  }

  console.log("proxy smoke verified");
} finally {
  proxy.kill();
  await close(targetServer);
}

async function writeNestedSessionFixture(baseSession) {
  const sessionDirectory = path.join(nestedFeedbackRoot, "sessions", "2026-06-07-root");
  const session = {
    ...baseSession,
    createdAt: new Date().toISOString(),
    issueCount: 1,
    issues: [
      {
        ...baseSession.issues[0],
        id: 1,
        note: "make it red",
        screenshotName: "issue-1.png"
      }
    ]
  };

  await mkdir(path.join(sessionDirectory, "screenshots"), { recursive: true });
  await writeFile(path.join(sessionDirectory, "session.json"), `${JSON.stringify(session, null, 2)}\n`);
  await writeFile(path.join(sessionDirectory, "session.md"), "# nested fixture\nmake it red\n");
}

async function verifyInvalidSessionRequests(port) {
  const badJsonResponse = await fetch(`http://127.0.0.1:${port}/__vernier/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{"
  });

  if (badJsonResponse.status !== 400) {
    throw new Error(`Expected bad JSON to return 400, got ${badJsonResponse.status}`);
  }

  const traversalResponse = await fetch(`http://127.0.0.1:${port}/__vernier/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(createSessionPayload({ screenshotName: "../escape.png" }))
  });

  if (traversalResponse.status !== 400) {
    throw new Error(`Expected unsafe screenshot path to return 400, got ${traversalResponse.status}`);
  }

  const countResponse = await fetch(`http://127.0.0.1:${port}/__vernier/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(createSessionPayload({ issueCount: 2 }))
  });

  if (countResponse.status !== 400) {
    throw new Error(`Expected mismatched issueCount to return 400, got ${countResponse.status}`);
  }
}

function createSessionPayload(overrides = {}) {
  const png = "data:image/png;base64,iVBORw0KGgo=";

  return {
    schemaVersion: 1,
    toolVersion: "0.0.0",
    sessionId: "s-testsession1",
    route: "/",
    url: "http://127.0.0.1/",
    viewport: {
      width: 1280,
      height: 720,
      devicePixelRatio: 1
    },
    createdAt: new Date().toISOString(),
    issueCount: overrides.issueCount ?? 1,
    issues: [
      {
        id: 1,
        stableId: "i-testissue1",
        kind: "single",
        measured: "Selector: body",
        selector: "body",
        source: "unresolved",
        note: "invalid request fixture",
        createdAt: new Date().toISOString(),
        screenshotName: overrides.screenshotName ?? "issue-1.png",
        screenshotDataUrl: png
      }
    ],
    fullPageScreenshotName: "full-page.png",
    fullPageScreenshotDataUrl: png
  };
}

function listen(server, port) {
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", resolve);
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

function waitForOutput(process, text) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${text}`)), 30_000);

    process.stdout.on("data", (chunk) => {
      if (String(chunk).includes(text)) {
        clearTimeout(timeout);
        resolve();
      }
    });
    process.stderr.on("data", (chunk) => {
      const message = String(chunk);
      if (message.toLowerCase().includes("error")) {
        clearTimeout(timeout);
        reject(new Error(message));
      }
    });
    process.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Proxy exited early with code ${code}`));
    });
  });
}

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }

      reject(new Error(stderr || `Command failed with ${code}`));
    });
  });
}

async function verifyUnavailableTarget() {
  const deadProxyPort = 4310;
  const deadProxy = spawn(
    process.execPath,
    ["dist/cli.js", "--target", "http://127.0.0.1:4311", "--port", String(deadProxyPort)],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] }
  );

  try {
    await waitForOutput(deadProxy, "proxy listening");
    const response = await fetch(`http://127.0.0.1:${deadProxyPort}/`);
    const html = await response.text();

    if (response.status !== 502 || !html.includes("Vernier cannot reach the target app")) {
      throw new Error(`Expected 502 dead target page, got ${response.status}: ${html}`);
    }
    if (deadProxy.exitCode !== null) {
      throw new Error("Dead target should not terminate the proxy process.");
    }
  } finally {
    deadProxy.kill();
  }
}
