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

  if (request.url === "/index.json") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({
      entries: {
        "button--primary": {
          id: "button--primary",
          title: "Button",
          name: "Primary",
          type: "story",
          importPath: "./Button.stories.tsx",
          tags: ["dev", "test"]
        },
        "button--docs": {
          id: "button--docs",
          title: "Button",
          name: "Docs",
          type: "docs"
        }
      }
    }));
    return;
  }

  if (request.url?.startsWith("/iframe.html")) {
    const url = new URL(request.url, `http://127.0.0.1:${targetPort}`);
    response.setHeader("Content-Type", "text/html");
    response.end(`<!doctype html>
      <html>
        <head>
          <title>Story ${url.searchParams.get("id")}</title>
          <style>
            body { margin: 0; padding: 32px; font-family: system-ui, sans-serif; }
            button { min-width: 120px; min-height: 44px; border: 0; border-radius: 8px; background: #1f6feb; color: #fff; font-weight: 700; }
          </style>
        </head>
        <body>
          <button data-testid="storybook-button">Primary</button>
        </body>
      </html>`);
    return;
  }

  response.setHeader("Content-Type", "text/html");
  response.end(`<!doctype html>
    <html>
      <head>
        <style>
          :root { --card-bg: #ffffff; --card-ink: #172033; --space-6: 24px; }
          body { margin: 0; font-family: system-ui, sans-serif; }
          main { padding: 64px; position: relative; z-index: 2; isolation: isolate; }
          .card { width: 360px; height: 120px; padding: var(--space-6); border-radius: 8px; background: var(--card-bg); color: var(--card-ink); box-sizing: border-box; border: 1px solid #d8dde8; line-height: 24px; font-weight: 600; letter-spacing: 0px; }
          .usage-card { margin-left: 0; }
          .revenue-card { margin-top: 20px; margin-left: 12px; }
        </style>
      </head>
      <body>
        <main>
          <section class="usage-card card px-6 text-slate-900" data-testid="usage-card">Usage <span data-vernier-redact>secret-token-123</span></section>
          <section class="revenue-card card px-6 text-slate-900" data-testid="revenue-card">Revenue</section>
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
  await page.evaluate(() => window.localStorage.removeItem("vernierExportWarningAcknowledged"));
  await page.locator("[data-vernier-root]").waitFor({ state: "attached" });
  const overlayMountedInShadow = await page.evaluate(() =>
    Boolean(document.querySelector("[data-vernier-host]")?.shadowRoot?.querySelector("[data-vernier-root]"))
  );
  if (!overlayMountedInShadow) {
    throw new Error("Expected Vernier overlay root to mount inside a Shadow DOM host.");
  }
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
  await waitForLocatorText(page, "[data-vernier-status]", "Added issue 1");

  await page.mouse.move(usage.x + usage.width / 2, usage.y + usage.height / 2);
  await page.mouse.click(usage.x + usage.width / 2, usage.y + usage.height / 2);
  await page.mouse.move(revenue.x + revenue.width / 2, revenue.y + revenue.height / 2);
  await page.mouse.click(revenue.x + revenue.width / 2, revenue.y + revenue.height / 2);
  await page.locator("[data-vernier-note]").fill("align these cards");
  await page.locator("[data-vernier-add-issue]").click();
  await waitForLocatorText(page, "[data-vernier-status]", "Added issue 2");
  await page.locator("[data-vernier-issue-id='2']").click();
  await page.locator("[data-vernier-note]").fill("edited delta note");
  await page.locator("[data-vernier-save-issue]").click();
  await waitForLocatorText(page, "[data-vernier-status]", "Saved issue 2");

  await page.locator("[data-vernier-mode]").selectOption("pen");
  await page.locator("[data-vernier-annotation-label]").selectOption("misaligned");
  await page.mouse.move(160, 160);
  await page.mouse.down();
  await page.mouse.move(220, 190);
  await page.mouse.up();
  await page.locator("[data-vernier-note]").fill("freehand annotation");
  await page.locator("[data-vernier-add-issue]").click();
  await waitForLocatorText(page, "[data-vernier-status]", "Added issue 3");

  await page.locator("[data-vernier-mode]").selectOption("redact");
  await page.mouse.move(260, 160);
  await page.mouse.down();
  await page.mouse.move(340, 210);
  await page.mouse.up();
  await page.locator("[data-vernier-note]").fill("manual redaction");
  await page.locator("[data-vernier-add-issue]").click();
  await waitForLocatorText(page, "[data-vernier-status]", "Added issue 4");

  await page.locator("[data-vernier-export]").click();
  await waitForLocatorText(page, "[data-vernier-status]", "Vernier will save local screenshots under .ui-feedback. Review sensitive data before committing.");
  await page.locator("[data-vernier-export]").click();
  await page.locator("[data-vernier-status]").waitFor({ state: "visible" });
  await waitForLocatorText(page, "[data-vernier-status]", "Exported");
  await page.locator("[data-vernier-export]").click();
  await waitForLocatorText(page, "[data-vernier-status]", "Exported");
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
  const screenshotInventory = JSON.parse(await readFile(path.join(feedbackRoot, "latest", "screenshots.json"), "utf8"));
  const sessionMetadata = JSON.parse(await readFile(path.join(feedbackRoot, "latest", "metadata.json"), "utf8"));
  if (!sessionMarkdown.includes("Left edge delta: +12px")) {
    throw new Error(`Expected proxy session to contain +12px delta:\n${sessionMarkdown}`);
  }
  if (!sessionMarkdown.includes("Structured evidence:")) {
    throw new Error(`Expected proxy session markdown to include structured evidence:\n${sessionMarkdown}`);
  }
  if (!sessionMarkdown.includes("Annotation: pen")) {
    throw new Error(`Expected proxy session to contain pen annotation:\n${sessionMarkdown}`);
  }
  if (!sessionMarkdown.includes("Issue count: 4") || !sessionMarkdown.includes("edited delta note")) {
    throw new Error(`Expected cleaner edited session output:\n${sessionMarkdown}`);
  }
  if (!sessionMarkdown.includes("Auto-redacted elements: 1") || !sessionMarkdown.includes("Manual redaction: yes")) {
    throw new Error(`Expected session markdown to include redaction evidence:\n${sessionMarkdown}`);
  }
  if (!sessionMarkdown.includes("Screenshot metadata:") || !sessionMarkdown.includes("html2canvas")) {
    throw new Error(`Expected session markdown to include screenshot metadata:\n${sessionMarkdown}`);
  }
  if (!sessionMarkdown.includes("Selector confidence:")) {
    throw new Error(`Expected session markdown to include target confidence:\n${sessionMarkdown}`);
  }
  if (
    sessionJson.fullPageScreenshot?.kind !== "full-page" ||
    sessionJson.fullPageScreenshot.captureStrategy !== "html2canvas" ||
    !/^sha256-[a-f0-9]{64}$/.test(sessionJson.fullPageScreenshot.hash)
  ) {
    throw new Error(`Expected full-page screenshot artifact metadata:\n${JSON.stringify(sessionJson.fullPageScreenshot, null, 2)}`);
  }
  if (
    sessionJson.issues[0]?.screenshot?.kind !== "element" ||
    sessionJson.issues[0].screenshot.name !== sessionJson.issues[0].screenshotName ||
    sessionJson.issues[0].screenshot.byteLength <= 0 ||
    !/^sha256-[a-f0-9]{64}$/.test(sessionJson.issues[0].screenshot.hash)
  ) {
    throw new Error(`Expected issue screenshot artifact metadata:\n${JSON.stringify(sessionJson.issues[0], null, 2)}`);
  }
  if (screenshotInventory.length !== sessionJson.issues.length + 1 || screenshotInventory[0]?.kind !== "full-page") {
    throw new Error(`Expected screenshots.json inventory for full page plus issues:\n${JSON.stringify(screenshotInventory, null, 2)}`);
  }
  if (sessionJson.issues[0]?.measurement?.kind !== "single" || !sessionJson.issues[0].measurement.bbox) {
    throw new Error(`Expected single issue to include structured bbox measurement:\n${JSON.stringify(sessionJson, null, 2)}`);
  }
  if (sessionJson.issues[1]?.measurement?.kind !== "delta" || sessionJson.issues[1].measurement.delta.left !== 12) {
    throw new Error(`Expected delta issue to include structured delta measurement:\n${JSON.stringify(sessionJson, null, 2)}`);
  }
  if (
    sessionJson.issues[1].measurement.alignment?.centerDelta !== 12 ||
    sessionJson.issues[1].measurement.alignment?.verticalGap !== 20 ||
    sessionJson.issues[1].measurement.alignment?.centerAligned !== false
  ) {
    throw new Error(`Expected delta issue to include structured alignment evidence:\n${JSON.stringify(sessionJson.issues[1], null, 2)}`);
  }
  if (!sessionJson.issues[1]?.measurement?.layoutContext?.parentDisplay) {
    throw new Error(`Expected delta issue to include layout context:\n${JSON.stringify(sessionJson.issues[1], null, 2)}`);
  }
  if (!sessionJson.issues[0]?.measurement?.classHints?.includes("px-6")) {
    throw new Error(`Expected single issue to include utility class hints:\n${JSON.stringify(sessionJson.issues[0], null, 2)}`);
  }
  if (!sessionJson.issues[0]?.measurement?.designTokenHints?.some((hint) => hint.token === "--card-bg" && hint.property === "background-color")) {
    throw new Error(`Expected single issue to include design token hints:\n${JSON.stringify(sessionJson.issues[0], null, 2)}`);
  }
  if (!sessionJson.issues[1]?.measurement?.designTokenHints?.some((hint) => hint.token === "--card-ink" && hint.property === "color")) {
    throw new Error(`Expected delta issue to include target design token hints:\n${JSON.stringify(sessionJson.issues[1], null, 2)}`);
  }
  if (sessionJson.issues[0]?.measurement?.textMetrics?.fontWeight !== "600") {
    throw new Error(`Expected single issue to include text metrics:\n${JSON.stringify(sessionJson.issues[0], null, 2)}`);
  }
  if (!sessionJson.issues[0]?.measurement?.stackingContext?.stackingAncestors?.some((ancestor) => ancestor.selector === "main" && ancestor.isolation === "isolate")) {
    throw new Error(`Expected single issue to include stacking context ancestors:\n${JSON.stringify(sessionJson.issues[0], null, 2)}`);
  }
  if (sessionJson.issues[2]?.measurement?.kind !== "annotation" || sessionJson.issues[2].measurement.points.length < 2) {
    throw new Error(`Expected annotation issue to include structured points:\n${JSON.stringify(sessionJson, null, 2)}`);
  }
  if (sessionJson.issues[2].measurement.label !== "misaligned" || !sessionJson.issues[2].measured.includes("Label: misaligned")) {
    throw new Error(`Expected annotation issue to include quick label evidence:\n${JSON.stringify(sessionJson.issues[2], null, 2)}`);
  }
  if (sessionJson.issues[0]?.redaction?.autoRedactedElements !== 1) {
    throw new Error(`Expected single issue to record automatic redaction:\n${JSON.stringify(sessionJson.issues[0], null, 2)}`);
  }
  if (sessionJson.issues[3]?.measurement?.kind !== "annotation" || sessionJson.issues[3].measurement.mode !== "redact" || sessionJson.issues[3].redaction?.manualRedaction !== true) {
    throw new Error(`Expected manual redact annotation issue:\n${JSON.stringify(sessionJson.issues[3], null, 2)}`);
  }
  if (sessionMetadata.localOnly !== true || sessionMetadata.networkUploads !== false || sessionMetadata.createdBy !== "vernier") {
    throw new Error(`Expected session metadata to document local-only behavior:\n${JSON.stringify(sessionMetadata, null, 2)}`);
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
  await readFile(path.join(artifactDirectory, "diff.png"));
  if (
    compareReport.selectorFound !== true ||
    compareReport.artifacts?.diff !== "diff.png" ||
    !compareMarkdown.includes(`Issue ${sessionJson.issues[1].stableId}`) ||
    !compareMarkdown.includes("Diff: diff.png")
  ) {
    throw new Error(`Expected verify --compare artifacts to include report data:\n${compareMarkdown}`);
  }
  const multiCompareOutput = await runNode([
    "dist/cli.js",
    "verify",
    sessionJson.issues[1].stableId,
    "--target",
    `http://127.0.0.1:${proxyPort}`,
    "--compare",
    "--viewports",
    "390x844,desktop"
  ]);
  const multiArtifactDirectory = multiCompareOutput.match(/Artifacts: (.+)/)?.[1]?.trim();
  if (!multiCompareOutput.includes("Viewports compared: 2") || !multiArtifactDirectory) {
    throw new Error(`Expected verify --compare --viewports to print multi-viewport summary:\n${multiCompareOutput}`);
  }
  const multiCompareReport = JSON.parse(await readFile(path.join(multiArtifactDirectory, "report.json"), "utf8"));
  if (multiCompareReport.viewports?.length !== 2) {
    throw new Error(`Expected multi-viewport report artifacts:\n${JSON.stringify(multiCompareReport, null, 2)}`);
  }
  const captureOutput = await runNode([
    "dist/cli.js",
    "capture",
    "--target",
    `http://127.0.0.1:${proxyPort}`,
    "--routes",
    "/",
    "--viewports",
    "390x844,desktop"
  ]);
  const captureDirectory = captureOutput.match(/Artifacts: (.+)/)?.[1]?.trim();
  if (!captureOutput.includes("Captured 2 screenshots.") || !captureDirectory) {
    throw new Error(`Expected capture command to report batch artifacts:\n${captureOutput}`);
  }
  const captureReport = JSON.parse(await readFile(path.join(captureDirectory, "capture.json"), "utf8"));
  if (captureReport.screenshotCount !== 2 || captureReport.records?.some((record) => !record.screenshotName)) {
    throw new Error(`Expected capture report to include two screenshot records:\n${JSON.stringify(captureReport, null, 2)}`);
  }
  const captureDiffOutput = await runNode(["dist/cli.js", "diff", captureDirectory, captureDirectory]);
  if (!captureDiffOutput.includes("Vernier capture diff") || !captureDiffOutput.includes("No differences.")) {
    throw new Error(`Expected diff command to compare capture artifacts:\n${captureDiffOutput}`);
  }
  const storybookOutput = await runNode([
    "dist/cli.js",
    "storybook",
    "--url",
    `http://127.0.0.1:${targetPort}`,
    "--stories",
    "button--primary",
    "--viewports",
    "390x844"
  ]);
  const storybookDirectory = storybookOutput.match(/Artifacts: (.+)/)?.[1]?.trim();
  if (!storybookOutput.includes("Captured 1 Storybook screenshot.") || !storybookDirectory) {
    throw new Error(`Expected storybook command to report capture artifacts:\n${storybookOutput}`);
  }
  const storybookReport = JSON.parse(await readFile(path.join(storybookDirectory, "storybook.json"), "utf8"));
  if (storybookReport.screenshotCount !== 1 || storybookReport.records?.[0]?.id !== "button--primary" || storybookReport.records[0].importPath !== "./Button.stories.tsx" || !storybookReport.records[0].screenshotName) {
    throw new Error(`Expected Storybook report to include selected story metadata:\n${JSON.stringify(storybookReport, null, 2)}`);
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
    const replayDiff = await fetch(`http://127.0.0.1:4342/verification/${sessionJson.issues[1].stableId}/diff.png`);

    if (!replayHtml.includes("Vernier Replay") || !replayHtml.includes(sessionJson.issues[1].stableId) || !replayHtml.includes("diff.png")) {
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
    if (!replayDiff.ok || replayDiff.headers.get("content-type") !== "image/png") {
      throw new Error(`Expected replay viewer to serve verification diff PNG.`);
    }
  } finally {
    replay.kill();
  }

  const latestOutput = await runNode(["dist/cli.js", "latest"]);
  const promptOutput = await runNode(["dist/cli.js", "prompt"]);
  const helpOutput = await runNode(["dist/cli.js", "--help"]);
  const snippetOutput = await runNode(["dist/cli.js", "snippet", "--port", "4344"]);
  const standalone = spawn(
    process.execPath,
    ["dist/cli.js", "serve", "--port", "4344"],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] }
  );
  try {
    await waitForOutput(standalone, "standalone overlay server listening");
    const standaloneScript = await (await fetch("http://127.0.0.1:4344/__vernier/overlay.js")).text();
    const standalonePreflight = await fetch("http://127.0.0.1:4344/__vernier/session", {
      method: "OPTIONS",
      headers: { Origin: `http://127.0.0.1:${targetPort}` }
    });

    if (
      !standaloneScript.includes('"sessionEndpoint":"http://127.0.0.1:4344/__vernier/session"') ||
      standalonePreflight.status !== 204 ||
      standalonePreflight.headers.get("access-control-allow-origin") !== "*"
    ) {
      throw new Error(`Expected standalone overlay server to serve cross-origin snippet assets.`);
    }
  } finally {
    standalone.kill();
  }
  const detectOutput = await runNode(["dist/cli.js", "detect", "--ports", String(targetPort)]);
  const detectJson = JSON.parse(await runNode(["dist/cli.js", "detect", "--ports", String(targetPort), "--json"]));
  const doctorOutput = await runNode(["dist/cli.js", "doctor"]);
  const cleanDryRunOutput = await runNode(["dist/cli.js", "clean", "--keep", "1", "--dry-run"]);
  const configPath = path.join(feedbackRoot, "vernier.config.json");

  await writeFile(configPath, `${JSON.stringify({
    target: `http://127.0.0.1:${targetPort}`,
    port: "auto",
    detectPorts: [targetPort],
    verification: { bboxTolerancePx: 5 },
    overlay: { captureFullPage: false },
    agents: { default: "codex" }
  }, null, 2)}\n`);

  await writeNestedSessionFixture(JSON.parse(await readFile(path.join(feedbackRoot, "latest", "session.json"), "utf8")));

  const issuesOutput = await runNode(["dist/cli.js", "issues"]);
  const issuesJson = JSON.parse(await runNode(["dist/cli.js", "issues", "--json"]));
  const statusOutput = await runNode(["dist/cli.js", "status"]);
  const statusJson = JSON.parse(await runNode(["dist/cli.js", "status", "--json"]));
  const auditOutput = await runNode(["dist/cli.js", "audit", "a11y"]);
  const auditJson = JSON.parse(await runNode(["dist/cli.js", "audit", "a11y", "--json"]));
  const layoutAuditOutput = await runNode(["dist/cli.js", "audit", "layout"]);
  const layoutAuditJson = JSON.parse(await runNode(["dist/cli.js", "audit", "layout", "--json"]));
  const stableIssueId = issuesOutput.match(/i-[a-f0-9]{6}/)?.[0];

  if (!stableIssueId) {
    throw new Error(`Expected issues command to print stable IDs:\n${issuesOutput}`);
  }

  const showOutput = await runNode(["dist/cli.js", "show", stableIssueId]);
  const copyOutput = await runNode(["dist/cli.js", "copy", stableIssueId, "--print"]);
  const packetOutput = await runNode(["dist/cli.js", "copy", stableIssueId, "--format", "packet", "--print"]);
  const noteOutput = await runNode(["dist/cli.js", "note", stableIssueId, "make it blue instead"]);
  const renameOutput = await runNode(["dist/cli.js", "rename-session", "pricing mobile pass"]);
  const notedShowOutput = await runNode(["dist/cli.js", "show", stableIssueId]);
  const notedMarkdown = await readFile(path.join(nestedFeedbackRoot, "sessions", "2026-06-07-root", "session.md"), "utf8");
  const renamedJson = JSON.parse(await readFile(path.join(nestedFeedbackRoot, "sessions", "2026-06-07-root", "session.json"), "utf8"));
  const planOutput = await runNode(["dist/cli.js", "plan", stableIssueId]);
  const exportMarkdownOutput = await runNode(["dist/cli.js", "export", "--format", "md"]);
  const exportedJsonPath = path.join(feedbackRoot, "latest-session.json");
  const exportJsonOutput = await runNode(["dist/cli.js", "export", "--format", "json", "--out", exportedJsonPath]);
  const exportedZipPath = path.join(feedbackRoot, "latest-session.zip");
  const exportZipOutput = await runNode(["dist/cli.js", "export", "--format", "zip", "--out", exportedZipPath]);
  const exportedJson = JSON.parse(await readFile(exportedJsonPath, "utf8"));
  const exportedZipEntries = readZipEntryNames(await readFile(exportedZipPath));
  const importOutput = await runNode(["dist/cli.js", "import", exportedZipPath, "--out-dir", ".ui-feedback-imported"]);
  const importedJson = JSON.parse(await readFile(path.join(root, ".ui-feedback-imported", "latest", "session.json"), "utf8"));
  const githubBodyOutput = await runNode(["dist/cli.js", "github", "body", stableIssueId]);
  const githubDryRunOutput = await runNode(["dist/cli.js", "github", "create", "all", "--label", "ui-feedback", "--dry-run"]);
  const fixLoopOutput = await runNode(["dist/cli.js", "fix-loop", stableIssueId, "--to", "codex", "--target", `http://127.0.0.1:${targetPort}`, "--print"]);
  const configDetectOutput = await runNode(["dist/cli.js", "detect", "--config", configPath]);
  const configVerifyOutput = await runNode(["dist/cli.js", "verify", stableIssueId, "--config", configPath]);
  const configSendOutput = await runNode(["dist/cli.js", "send", stableIssueId, "--config", configPath, "--print"]);
  const invalidOptionOutput = await runNodeFailure(["dist/cli.js", "--port", "nope"]);
  const verifyOutput = await runNode([
    "dist/cli.js",
    "verify",
    stableIssueId,
    "--target",
    `http://127.0.0.1:${targetPort}`
  ]);
  const sendOutput = await runNode(["dist/cli.js", "send", stableIssueId, "--to", "codex", "--print"]);
  const templatedSendOutput = await runNode(["dist/cli.js", "send", stableIssueId, "--to", "codex", "--template", "codex", "--print"]);
  const sendAllOutput = await runNode(["dist/cli.js", "send", "--to", "codex", "--print"]);
  const markOutput = await runNode(["dist/cli.js", "mark", stableIssueId, "fixed"]);
  const todoIssuesOutput = await runNode(["dist/cli.js", "issues", "--todo"]);
  const fixedIssuesOutput = await runNode(["dist/cli.js", "issues", "--fixed"]);
  const sendTodoOutput = await runNode(["dist/cli.js", "send", "--to", "codex", "--print"]);
  const sendAllAfterFixedOutput = await runNode(["dist/cli.js", "send", "--to", "codex", "--all", "--print"]);
  const mcp = await runMcpExchange([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 3, method: "resources/list", params: {} },
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "get_vernier_issue", arguments: { id: stableIssueId } }
    },
    {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "mark_vernier_issue_todo", arguments: { id: stableIssueId } }
    },
    {
      jsonrpc: "2.0",
      id: 6,
      method: "resources/read",
      params: { uri: `vernier://issue/${stableIssueId}` }
    }
  ]);

  if (!latestOutput.includes("Issue count: 4")) {
    throw new Error(`Expected latest command to print session markdown:\n${latestOutput}`);
  }
  if (!promptOutput.includes("Use the Vernier UI feedback session below.") || !promptOutput.includes("Issue count: 4")) {
    throw new Error(`Expected prompt command to print handoff prompt:\n${promptOutput}`);
  }
  if (!helpOutput.includes("vernier [--target http://localhost:5173]") || !helpOutput.includes("vernier http://localhost:5173")) {
    throw new Error(`Expected help command to document CLI shorthand:\n${helpOutput}`);
  }
  if (!helpOutput.includes("vernier serve [--port 3333|auto]") || !helpOutput.includes("vernier snippet [--port 3333]")) {
    throw new Error(`Expected help command to document standalone injection commands:\n${helpOutput}`);
  }
  if (!helpOutput.includes("vernier detect [--ports 5173,3000,6006] [--json]") || !helpOutput.includes("vernier issues [--todo|--fixed|--all] [--json]") || !helpOutput.includes("vernier status [--json]")) {
    throw new Error(`Expected help command to document JSON output flags:\n${helpOutput}`);
  }
  if (!snippetOutput.includes('<script type="module" src="http://127.0.0.1:4344/__vernier/overlay.js"></script>')) {
    throw new Error(`Expected snippet command to print standalone script tag:\n${snippetOutput}`);
  }
  if (!helpOutput.includes("vernier.config.json") || !helpOutput.includes("VERNIER_TARGET")) {
    throw new Error(`Expected help command to document config and environment defaults:\n${helpOutput}`);
  }
  if (!helpOutput.includes("overlay.captureFullPage")) {
    throw new Error(`Expected help command to document overlay capture config:\n${helpOutput}`);
  }
  if (!helpOutput.includes("vernier github body|create") || !helpOutput.includes("[--dry-run]") || !helpOutput.includes("vernier copy <issue-id> [--format task|packet]") || !helpOutput.includes("vernier rename-session \"short title\"") || !helpOutput.includes("vernier storybook [--url http://localhost:6006]") || !helpOutput.includes("vernier plan <issue-id>") || !helpOutput.includes("vernier export [--format md|json|zip]") || !helpOutput.includes("vernier import <session-directory-or-zip>") || !helpOutput.includes("vernier fix-loop [all|<issue-id>]") || !helpOutput.includes("--template generic|codex")) {
    throw new Error(`Expected help command to document GitHub export, rename-session, export, import, plan, fix-loop, and templates:\n${helpOutput}`);
  }
  if (!detectOutput.includes(`http://127.0.0.1:${targetPort}`) || !detectOutput.includes("Vite")) {
    throw new Error(`Expected detect command to find target app:\n${detectOutput}`);
  }
  if (detectJson.appCount !== 1 || detectJson.apps[0]?.url !== `http://127.0.0.1:${targetPort}` || detectJson.apps[0]?.label !== "Vite") {
    throw new Error(`Expected detect --json to emit machine-readable apps:\n${JSON.stringify(detectJson, null, 2)}`);
  }
  if (!doctorOutput.includes("OK: .ui-feedback is ignored") || !doctorOutput.includes("no network uploads")) {
    throw new Error(`Expected doctor command to report privacy hygiene:\n${doctorOutput}`);
  }
  if (!cleanDryRunOutput.includes("Dry run: would remove Vernier sessions") || !cleanDryRunOutput.includes("would be removed")) {
    throw new Error(`Expected clean --dry-run to report removable sessions:\n${cleanDryRunOutput}`);
  }
  if (!issuesOutput.includes("Latest session:") || !issuesOutput.includes("todo") || !issuesOutput.includes("make it red")) {
    throw new Error(`Expected issues command to list newest nested app-root session:\n${issuesOutput}`);
  }
  if (issuesJson.issueCount < 1 || issuesJson.issues[0]?.id !== stableIssueId || issuesJson.issues[0]?.status !== "todo") {
    throw new Error(`Expected issues --json to emit machine-readable issue data:\n${JSON.stringify(issuesJson, null, 2)}`);
  }
  if (!statusOutput.includes("Issues: 1") || !statusOutput.includes("Todo: 1") || !statusOutput.includes(`Next todo: ${stableIssueId}`)) {
    throw new Error(`Expected status command to summarize latest issue state:\n${statusOutput}`);
  }
  if (statusJson.total !== 1 || statusJson.todo !== 1 || statusJson.fixed !== 0 || statusJson.nextTodo?.id !== stableIssueId) {
    throw new Error(`Expected status --json to emit machine-readable status:\n${JSON.stringify(statusJson, null, 2)}`);
  }
  if (
    !auditOutput.includes("A11y audit:") ||
    !auditOutput.includes("tap-target") ||
    !auditOutput.includes("accessible-name") ||
    !auditOutput.includes("focus-ring") ||
    auditJson.findingCount < 3
  ) {
    throw new Error(`Expected audit a11y to flag fixture accessibility findings:\n${auditOutput}\n${JSON.stringify(auditJson, null, 2)}`);
  }
  if (
    !layoutAuditOutput.includes("Layout audit:") ||
    !layoutAuditOutput.includes("layout-context") ||
    !layoutAuditOutput.includes("text-overflow") ||
    !layoutAuditOutput.includes("stacking-context") ||
    layoutAuditJson.findingCount < 3
  ) {
    throw new Error(`Expected audit layout to flag fixture layout findings:\n${layoutAuditOutput}\n${JSON.stringify(layoutAuditJson, null, 2)}`);
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
  if (!configDetectOutput.includes(`http://127.0.0.1:${targetPort}`)) {
    throw new Error(`Expected detect to use configured ports:\n${configDetectOutput}`);
  }
  if (!configVerifyOutput.includes(`URL: http://127.0.0.1:${targetPort}/`)) {
    throw new Error(`Expected verify to use configured target:\n${configVerifyOutput}`);
  }
  if (!configSendOutput.includes("Fix the UI issue captured by Vernier.") || !configSendOutput.includes(stableIssueId)) {
    throw new Error(`Expected send to use configured default agent with --print:\n${configSendOutput}`);
  }
  if (!invalidOptionOutput.includes("VERNIER_INVALID_OPTION") || !invalidOptionOutput.includes("Invalid --port value")) {
    throw new Error(`Expected invalid CLI options to produce structured errors:\n${invalidOptionOutput}`);
  }
  if (!copyOutput.includes("Fix the UI issue captured by Vernier.") || !copyOutput.includes(stableIssueId)) {
    throw new Error(`Expected copy --print to produce issue task:\n${copyOutput}`);
  }
  if (!packetOutput.includes("Vernier Reproduction Packet") || !packetOutput.includes(`vernier verify ${stableIssueId} --compare`) || !packetOutput.includes("Screenshot:")) {
    throw new Error(`Expected copy --format packet --print to produce reproduction packet:\n${packetOutput}`);
  }
  if (!noteOutput.includes(`Updated ${stableIssueId} note.`) || !notedShowOutput.includes("make it blue instead") || !notedMarkdown.includes("make it blue instead")) {
    throw new Error(`Expected note command to update JSON and markdown:\n${noteOutput}\n${notedShowOutput}\n${notedMarkdown}`);
  }
  if (!renameOutput.includes('Renamed latest session') || renamedJson.title !== "pricing mobile pass" || !notedMarkdown.includes("Title: pricing mobile pass")) {
    throw new Error(`Expected rename-session to update latest session title:\n${renameOutput}\n${JSON.stringify(renamedJson, null, 2)}\n${notedMarkdown}`);
  }
  if (!planOutput.includes(`Vernier patch plan for ${stableIssueId}`) || !planOutput.includes("Likely change type:") || !planOutput.includes("Suggested checks:")) {
    throw new Error(`Expected plan command to print a patch plan:\n${planOutput}`);
  }
  if (!exportMarkdownOutput.includes("make it blue instead") || exportedJson.issues[0]?.note !== "make it blue instead") {
    throw new Error(`Expected export md/json to include latest edited session:\n${exportMarkdownOutput}\n${JSON.stringify(exportedJson, null, 2)}`);
  }
  if (!exportJsonOutput.includes(exportedJsonPath) || !exportZipOutput.includes(exportedZipPath) || !exportedZipEntries.includes("session.md") || !exportedZipEntries.includes("session.json") || !exportedZipEntries.some((entry) => entry.startsWith("screenshots/"))) {
    throw new Error(`Expected export zip to include session files:\n${exportZipOutput}\n${exportedZipEntries.join("\n")}`);
  }
  if (!importOutput.includes("Imported Vernier session") || importedJson.issues[0]?.note !== "make it blue instead") {
    throw new Error(`Expected import to restore exported session as latest:\n${importOutput}\n${JSON.stringify(importedJson, null, 2)}`);
  }
  if (
    !githubBodyOutput.includes(`Title: [Vernier] make it blue instead`) ||
    !githubBodyOutput.includes("## Vernier UI Feedback") ||
    !githubBodyOutput.includes("Selector: `[data-testid=\"bad-button\"]`") ||
    !githubBodyOutput.includes(`vernier verify ${stableIssueId} --compare`)
  ) {
    throw new Error(`Expected github body to print GitHub-ready issue content:\n${githubBodyOutput}`);
  }
  if (!githubDryRunOutput.includes("Dry run: would create") || !githubDryRunOutput.includes("GitHub issue") || !githubDryRunOutput.includes("Label: ui-feedback") || !githubDryRunOutput.includes("Issue: i-")) {
    throw new Error(`Expected github create --dry-run to preview GitHub creation:\n${githubDryRunOutput}`);
  }
  if (
    !fixLoopOutput.includes("Fix-loop contract:") ||
    !fixLoopOutput.includes(`vernier verify ${stableIssueId} --compare --target http://127.0.0.1:${targetPort} --tolerance 2`) ||
    !fixLoopOutput.includes("Vernier will remeasure after the agent exits")
  ) {
    throw new Error(`Expected fix-loop --print to include agent task and verification contract:\n${fixLoopOutput}`);
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
  if (!templatedSendOutput.includes("Template: codex") || !templatedSendOutput.includes("Codex instructions:") || !templatedSendOutput.includes(stableIssueId)) {
    throw new Error(`Expected send --template codex to produce Codex-specific task:\n${templatedSendOutput}`);
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
  if (
    !mcp.byId[1]?.result?.serverInfo ||
    !JSON.stringify(mcp.byId[2]).includes("get_vernier_issue") ||
    !JSON.stringify(mcp.byId[3]).includes(`vernier://issue/${stableIssueId}`) ||
    !JSON.stringify(mcp.byId[4]).includes("Fix the UI issue captured by Vernier.") ||
    !JSON.stringify(mcp.byId[5]).includes(`Marked ${stableIssueId} todo.`) ||
    !JSON.stringify(mcp.byId[6]).includes(stableIssueId)
  ) {
    throw new Error(`Expected MCP server to expose Vernier resources/tools:\n${JSON.stringify(mcp.responses, null, 2)}`);
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
        stableId: undefined,
        id: 1,
        note: "make it red",
        selector: "[data-testid=\"bad-button\"]",
        source: "src/components/BadButton.tsx:7",
        target: {
          ...baseSession.issues[0].target,
          selector: "[data-testid=\"bad-button\"]",
          tag: "button",
          text: undefined,
          accessibleName: undefined,
          role: "button",
          testId: "bad-button",
          nearestTestId: "bad-button",
          source: "src/components/BadButton.tsx:7"
        },
        measurement: {
          kind: "single",
          bbox: {
            x: 10,
            y: 10,
            width: 24,
            height: 24,
            top: 10,
            right: 34,
            bottom: 34,
            left: 10
          },
          computedStyle: {
            color: "rgb(120, 120, 120)",
            "background-color": "rgb(130, 130, 130)",
            "font-size": "14px",
            outline: "0px none",
            "outline-style": "none",
            "outline-width": "0px",
            "box-shadow": "none"
          },
          authoredHints: [],
          classHints: [],
          designTokenHints: [],
          textMetrics: {
            fontFamily: "system-ui",
            fontSize: "14px",
            fontWeight: "400",
            lineHeight: "20px",
            letterSpacing: "0px",
            textTransform: "none",
            textOverflow: "clip",
            whiteSpace: "normal",
            renderedLineCount: 1
          },
          stackingContext: {
            position: "relative",
            zIndex: "10",
            opacity: "1",
            transform: "none",
            isolation: "auto",
            stackingAncestors: []
          },
          layoutContext: {
            parentSelector: "main",
            parentDisplay: "grid",
            parentGap: "24px",
            parentPadding: "16px",
            overflow: {
              x: "hidden",
              y: "hidden",
              clippedByParent: true,
              horizontalPageScroll: false
            }
          }
        },
        screenshotName: "issue-1.png",
        screenshot: {
          name: "issue-1.png",
          kind: "element",
          width: 24,
          height: 24,
          devicePixelRatio: 1,
          captureStrategy: "html2canvas",
          mimeType: "image/png",
          byteLength: Buffer.byteLength(baseSession.issues[0].screenshotDataUrl.split(",")[1], "base64"),
          hash: "sha256-0000000000000000000000000000000000000000000000000000000000000000"
        }
      }
    ]
  };

  await mkdir(path.join(sessionDirectory, "screenshots"), { recursive: true });
  await writeFile(path.join(sessionDirectory, "session.json"), `${JSON.stringify(session, null, 2)}\n`);
  await writeFile(path.join(sessionDirectory, "session.md"), "# nested fixture\nmake it red\n");
  await writeFile(path.join(sessionDirectory, "screenshots", "issue-1.png"), Buffer.from(baseSession.issues[0].screenshotDataUrl.split(",")[1], "base64"));
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
  const screenshot = {
    name: overrides.screenshotName ?? "issue-1.png",
    kind: "element",
    width: 1,
    height: 1,
    devicePixelRatio: 1,
    captureStrategy: "html2canvas",
    mimeType: "image/png",
    byteLength: 8,
    hash: "sha256-0000000000000000000000000000000000000000000000000000000000000000"
  };

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

async function waitForLocatorText(page, selector, expectedText) {
  const deadline = Date.now() + 30_000;
  const locator = page.locator(selector);

  while (Date.now() < deadline) {
    const text = await locator.textContent().catch(() => null);

    if (text === expectedText) {
      return;
    }

    await page.waitForTimeout(50);
  }

  throw new Error(`Timed out waiting for ${selector} to equal ${expectedText}`);
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

function readZipEntryNames(buffer) {
  const names = [];
  let offset = 0;

  while (offset + 4 <= buffer.byteLength) {
    const signature = buffer.readUInt32LE(offset);

    if (signature !== 0x04034b50) {
      break;
    }

    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    names.push(buffer.subarray(nameStart, nameStart + nameLength).toString("utf8"));
    offset = nameStart + nameLength + extraLength + compressedSize;
  }

  return names;
}

function runNodeFailure(args) {
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
        reject(new Error(`Expected command to fail: ${args.join(" ")}\n${stdout}`));
        return;
      }

      resolve(`${stdout}${stderr}`);
    });
  });
}

function runMcpExchange(messages) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["dist/cli.js", "mcp"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    const responses = [];
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Timed out waiting for MCP responses:\n${stdout}\n${stderr}`));
    }, 30_000);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";

      for (const line of lines) {
        if (line.trim()) {
          responses.push(JSON.parse(line));
        }
      }

      if (responses.length === messages.length) {
        clearTimeout(timeout);
        child.stdin.end();
        child.kill();
        resolve({
          responses,
          byId: Object.fromEntries(responses.map((response) => [response.id, response]))
        });
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.stdin.end(messages.map((message) => JSON.stringify(message)).join("\n") + "\n");
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
