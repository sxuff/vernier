import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdir, readdir, rm, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { connect } from "node:net";
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

  if (request.url === "/redirect-local") {
    response.statusCode = 302;
    response.setHeader("Location", `http://127.0.0.1:${targetPort}/login?from=target`);
    response.end();
    return;
  }

  if (request.url === "/redirect-external") {
    response.statusCode = 302;
    response.setHeader("Location", "https://example.com/login");
    response.end();
    return;
  }

  if (request.url === "/events") {
    response.setHeader("Content-Type", "text/event-stream");
    response.write("event: ready\n");
    response.write("data: one\n\n");
    response.end();
    return;
  }

  if (request.url === "/cookies") {
    response.setHeader("Set-Cookie", [
      "session=abc; Domain=127.0.0.1; Path=/; HttpOnly",
      "theme=dark; Path=/"
    ]);
    response.setHeader("Content-Type", "text/plain");
    response.end("cookies");
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

targetServer.on("upgrade", (request, socket) => {
  if (request.url !== "/hmr") {
    socket.destroy();
    return;
  }

  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      "X-Forwarded-Host: " + (request.headers.host ?? ""),
      "",
      ""
    ].join("\r\n")
  );
  socket.end();
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

  const localRedirect = await fetch(`http://127.0.0.1:${proxyPort}/redirect-local`, { redirect: "manual" });
  if (localRedirect.headers.get("location") !== "/login?from=target") {
    throw new Error(`Expected local redirect to stay on proxy origin, got ${localRedirect.headers.get("location")}`);
  }

  const externalRedirect = await fetch(`http://127.0.0.1:${proxyPort}/redirect-external`, { redirect: "manual" });
  if (externalRedirect.headers.get("location") !== "https://example.com/login") {
    throw new Error(`Expected external redirect to remain untouched, got ${externalRedirect.headers.get("location")}`);
  }

  const eventResponse = await fetch(`http://127.0.0.1:${proxyPort}/events`);
  const eventBody = await eventResponse.text();
  if (eventResponse.headers.get("content-type") !== "text/event-stream" || !eventBody.includes("data: one")) {
    throw new Error(`Expected SSE passthrough, got ${eventResponse.headers.get("content-type")}: ${eventBody}`);
  }

  const cookieResponse = await readRawHttpResponse(proxyPort, "/cookies");
  const normalizedCookieResponse = cookieResponse.toLowerCase();
  if (
    !normalizedCookieResponse.includes("set-cookie: session=abc; path=/; httponly") ||
    !normalizedCookieResponse.includes("set-cookie: theme=dark; path=/")
  ) {
    throw new Error(`Expected proxy to preserve separate rewritten Set-Cookie headers:\n${cookieResponse}`);
  }

  const upgradeResponse = await readRawUpgradeResponse(proxyPort, "/hmr");
  if (
    !upgradeResponse.includes("101 Switching Protocols") ||
    !upgradeResponse.includes(`X-Forwarded-Host: 127.0.0.1:${targetPort}`)
  ) {
    throw new Error(`Expected WebSocket upgrade to reach target with rewritten Host:\n${upgradeResponse}`);
  }

  await verifyPortFallback(targetPort);

  const attach = spawn(
    process.execPath,
    [
      "dist/cli.js",
      "attach",
      "--target",
      `http://127.0.0.1:${targetPort}`,
      "--port",
      "auto",
      "--no-open"
    ],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] }
  );
  try {
    await waitForOutput(attach, "proxy listening");
    attach.kill();
  } finally {
    attach.kill();
  }

  const sessionMarkdown = await readFile(path.join(feedbackRoot, "latest", "session.md"), "utf8");
  const sessionJson = JSON.parse(await readFile(path.join(feedbackRoot, "latest", "session.json"), "utf8"));
  if (!sessionMarkdown.includes("Left edge delta: +12px")) {
    throw new Error(`Expected proxy session to contain +12px delta:\n${sessionMarkdown}`);
  }
  if (!sessionMarkdown.includes("Structured evidence:")) {
    throw new Error(`Expected proxy session markdown to include structured evidence:\n${sessionMarkdown}`);
  }
  if (!sessionMarkdown.includes("Annotation: pen")) {
    throw new Error(`Expected proxy session to contain pen annotation:\n${sessionMarkdown}`);
  }
  if (!sessionMarkdown.includes("Issue count: 3") || !sessionMarkdown.includes("edited delta note")) {
    throw new Error(`Expected cleaner edited session output:\n${sessionMarkdown}`);
  }
  if (!sessionMarkdown.includes("Selector confidence:")) {
    throw new Error(`Expected session markdown to include target confidence:\n${sessionMarkdown}`);
  }
  if (sessionJson.issues[0]?.measurement?.kind !== "single" || !sessionJson.issues[0].measurement.bbox) {
    throw new Error(`Expected single issue to include structured bbox measurement:\n${JSON.stringify(sessionJson, null, 2)}`);
  }
  if (sessionJson.issues[1]?.measurement?.kind !== "delta" || sessionJson.issues[1].measurement.delta.left !== 12) {
    throw new Error(`Expected delta issue to include structured delta measurement:\n${JSON.stringify(sessionJson, null, 2)}`);
  }
  if (sessionJson.issues[2]?.measurement?.kind !== "annotation" || sessionJson.issues[2].measurement.points.length < 2) {
    throw new Error(`Expected annotation issue to include structured points:\n${JSON.stringify(sessionJson, null, 2)}`);
  }
  const compareOutput = await runNode([
    "dist/cli.js",
    "verify",
    sessionJson.issues[1].stableId,
    "--target",
    `http://127.0.0.1:${proxyPort}`,
    "--compare"
  ]);
  const artifactDirectory = compareOutput.match(/Artifacts: (.+)/)?.[1]?.trim();
  if (!compareOutput.includes("Selector found: yes") || !artifactDirectory) {
    throw new Error(`Expected verify --compare to remeasure and print artifact path:\n${compareOutput}`);
  }
  const compareReport = JSON.parse(await readFile(path.join(artifactDirectory, "report.json"), "utf8"));
  const compareMarkdown = await readFile(path.join(artifactDirectory, "report.md"), "utf8");
  if (compareReport.selectorFound !== true || !compareMarkdown.includes(`Issue ${sessionJson.issues[1].stableId}`)) {
    throw new Error(`Expected verify --compare artifacts to include report data:\n${compareMarkdown}`);
  }

  const replay = spawn(
    process.execPath,
    ["dist/cli.js", "replay", "latest", "--port", "4342", "--no-open"],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] }
  );
  try {
    await waitForOutput(replay, "replay viewer listening");
    const replayHtml = await (await fetch("http://127.0.0.1:4342/")).text();
    const replaySession = await (await fetch("http://127.0.0.1:4342/session.json")).json();
    const replayScreenshot = await fetch(`http://127.0.0.1:4342/screenshots/${sessionJson.issues[0].screenshotName}`);
    const replayReport = await (await fetch(`http://127.0.0.1:4342/verification/${sessionJson.issues[1].stableId}/report.json`)).json();

    if (!replayHtml.includes("Vernier Replay") || !replayHtml.includes(sessionJson.issues[1].stableId)) {
      throw new Error(`Expected replay viewer HTML to include latest session issues:\n${replayHtml}`);
    }
    if (replaySession.sessionId !== sessionJson.sessionId) {
      throw new Error(`Expected replay /session.json to serve latest session.`);
    }
    if (!replayScreenshot.ok || replayScreenshot.headers.get("content-type") !== "image/png") {
      throw new Error(`Expected replay viewer to serve screenshot PNG.`);
    }
    if (replayReport.selectorFound !== true) {
      throw new Error(`Expected replay viewer to serve verification report.`);
    }
  } finally {
    replay.kill();
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
  if (
    !showOutput.includes(`ID: ${stableIssueId}`) ||
    !showOutput.includes("Status: todo") ||
    !showOutput.includes("Selector confidence:") ||
    !showOutput.includes("Element:") ||
    !showOutput.includes("Screenshot:")
  ) {
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

function readRawHttpResponse(port, requestPath) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let response = "";

    socket.on("connect", () => {
      socket.write(`GET ${requestPath} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    });
    socket.on("data", (chunk) => {
      response += String(chunk);
    });
    socket.on("end", () => resolve(response));
    socket.on("error", reject);
  });
}

function readRawUpgradeResponse(port, requestPath) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let response = "";

    socket.on("connect", () => {
      socket.write(
        [
          `GET ${requestPath} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version: 13",
          "",
          ""
        ].join("\r\n")
      );
    });
    socket.on("data", (chunk) => {
      response += String(chunk);
    });
    socket.on("end", () => resolve(response));
    socket.on("error", reject);
  });
}

async function verifyPortFallback(targetPort) {
  const busyPort = 4330;
  const busyServer = createServer((_request, response) => {
    response.end("busy");
  });
  await listen(busyServer, busyPort);

  const fallbackProxy = spawn(
    process.execPath,
    ["dist/cli.js", "proxy", "--target", `http://127.0.0.1:${targetPort}`, "--port", String(busyPort)],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] }
  );

  try {
    await waitForOutput(fallbackProxy, "Port 4330 is busy");
    await waitForOutput(fallbackProxy, "proxy listening on http://127.0.0.1:4331");
  } finally {
    fallbackProxy.kill();
    await close(busyServer);
  }
}

function waitForOutput(process, text) {
  return new Promise((resolve, reject) => {
    process.__vernierOutput ??= "";
    if (process.__vernierOutput.includes(text)) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${text}`)), 30_000);

    process.stdout.on("data", (chunk) => {
      process.__vernierOutput += String(chunk);
      if (process.__vernierOutput.includes(text)) {
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
