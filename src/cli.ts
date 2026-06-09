#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { access, copyFile, mkdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { connect as connectNet } from "node:net";
import { spawn } from "node:child_process";
import { Duplex, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { connect as connectTls } from "node:tls";
import path from "node:path";
import type { Browser, Page } from "playwright";
import type { BoundingBox, VernierIssue } from "./schema";
import { createAgentPrompt, latestSessionMarkdownPath, readLatestSessionMarkdown } from "./core/handoff";
import { injectVernierOverlay } from "./core/html";
import {
  filterIssuesByStatus,
  findLatestIssue,
  type IssueStatus,
  listLatestIssues,
  markLatestIssue,
  renderIssueDetail,
  renderIssueList,
  renderIssueTask,
  renderIssueVerification,
  renderIssuesTask
} from "./core/issues";
import {
  createVernierOverlayScript,
  vernierHtml2CanvasPath,
  vernierOverlayPath
} from "./core/overlay-script";
import { handleVernierSessionRequest } from "./core/session-handler";

interface ProxyOptions {
  target: URL;
  port: number | "auto";
  root: string;
}

interface DetectedApp {
  url: string;
  label: string;
  status: number;
}

const require = createRequire(import.meta.url);
const defaultTarget = "http://localhost:5173";
const defaultPort = 3333;
const defaultDetectPorts = [5173, 3000, 3001, 4173, 4200, 4321, 5000, 5174, 6006, 8000, 8080];
const maxProxyBodyBytes = 30 * 1024 * 1024;
const maxPortFallbackAttempts = 20;

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (!command || command === "proxy" || command === "start" || isUrlLike(command) || command.startsWith("--")) {
    const proxyArgs =
      command && command !== "proxy" && command !== "start" ? [command, ...args] : args;
    const options = parseProxyOptions(proxyArgs);
    await startProxyServer(options, { open: false });
    return;
  }

  if (command === "attach") {
    await attachToLocalApp(args);
    return;
  }

  if (command === "detect") {
    await detectLocalApps(args);
    return;
  }

  if (command === "issues") {
    console.log(renderIssueList(filterIssuesByStatus(await listLatestIssues(process.cwd()), readIssueStatusFilter(args))));
    return;
  }

  if (command === "show") {
    console.log(renderIssueDetail(await findLatestIssue(process.cwd(), readRequiredReference(args, "show"))));
    return;
  }

  if (command === "copy") {
    const task = renderIssueTask(await findLatestIssue(process.cwd(), readRequiredReference(args, "copy")));

    if (args.includes("--print")) {
      console.log(task);
      return;
    }

    await copyToClipboard(task);
    console.log("Copied Vernier issue task to clipboard.");
    return;
  }

  if (command === "send") {
    await sendIssueToAgent(args);
    return;
  }

  if (command === "mark") {
    await markIssue(args);
    return;
  }

  if (command === "verify") {
    await verifyIssue(args);
    return;
  }

  if (command === "latest") {
    console.log(await readLatestSessionMarkdown(process.cwd()));
    return;
  }

  if (command === "prompt") {
    console.log(createAgentPrompt(await readLatestSessionMarkdown(process.cwd())));
    return;
  }

  if (command === "open") {
    await openLatestSessionDirectory(process.cwd());
    return;
  }

  printHelp();
  process.exit(command ? 1 : 0);
}

async function verifyIssue(args: string[]): Promise<void> {
  const reference = readRequiredReference(args, "verify");
  const issue = await findLatestIssue(process.cwd(), reference);
  const targetUrl = createIssueTargetUrl(readOption(args, "--target") ?? defaultTarget, issue.session.route);

  if (args.includes("--compare")) {
    console.log(await compareIssue(issue, targetUrl, readTolerance(args)));
    return;
  }

  const verification = renderIssueVerification(issue, targetUrl);

  console.log(verification);

  if (args.includes("--open")) {
    await openUrl(targetUrl);
  }
}

async function compareIssue(
  indexed: Awaited<ReturnType<typeof findLatestIssue>>,
  targetUrl: string,
  tolerancePx: number
): Promise<string> {
  if (!indexed.issue.measurement || indexed.issue.measurement.kind === "annotation") {
    return [
      renderIssueVerification(indexed, targetUrl),
      "",
      "Compare result:",
      "Structured element measurement is required for automatic comparison."
    ].join("\n");
  }

  const { chromium } = await import("playwright");
  let browser: Browser | null = null;

  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: {
        width: indexed.session.viewport.width,
        height: indexed.session.viewport.height
      },
      deviceScaleFactor: indexed.session.viewport.devicePixelRatio
    });

    await page.goto(targetUrl, { waitUntil: "networkidle" });
    const report = await remeasureIssue(page, indexed.issue, tolerancePx);
    const artifactDirectory = path.join(indexed.sessionDirectory, "verification", indexed.stableId);
    await writeVerificationArtifacts(artifactDirectory, indexed, report, page);

    return renderCompareReport(indexed.stableId, targetUrl, artifactDirectory, report);
  } finally {
    await browser?.close();
  }
}

interface CompareReport {
  selectorFound: boolean;
  referenceFound?: boolean;
  original?: Record<string, unknown>;
  current?: Record<string, unknown>;
  differences: Array<{ field: string; original: unknown; current: unknown; delta?: number; withinTolerance?: boolean }>;
  tolerancePx: number;
  suggestedStatus: IssueStatus;
}

async function remeasureIssue(page: Page, issue: VernierIssue, tolerancePx: number): Promise<CompareReport> {
  const measurement = issue.measurement;

  if (!measurement || measurement.kind === "annotation") {
    throw new Error("Cannot compare an issue without element measurement data.");
  }

  const selector = measurement.kind === "delta" ? measurement.target.selector : issue.selector;
  const current = await measureSelectorOnPage(page, selector);

  if (!current) {
    return {
      selectorFound: false,
      differences: [{ field: "selector", original: selector, current: "not found" }],
      tolerancePx,
      suggestedStatus: "todo"
    };
  }

  if (measurement.kind === "single") {
    const differences = compareBoundingBoxes(measurement.bbox, current.bbox, tolerancePx);
    compareStyleValue(differences, "color", measurement.computedStyle.color, current.computedStyle.color);
    compareStyleValue(
      differences,
      "background-color",
      measurement.computedStyle["background-color"],
      current.computedStyle["background-color"]
    );
    compareStyleValue(differences, "font-size", measurement.computedStyle["font-size"], current.computedStyle["font-size"]);

    return {
      selectorFound: true,
      original: { bbox: measurement.bbox, computedStyle: measurement.computedStyle },
      current,
      differences,
      tolerancePx,
      suggestedStatus: hasMeaningfulChange(differences) ? "fixed" : "todo"
    };
  }

  const currentReference = await measureSelectorOnPage(page, measurement.reference.selector);

  if (!currentReference) {
    return {
      selectorFound: true,
      referenceFound: false,
      current,
      differences: [{ field: "reference", original: measurement.reference.selector, current: "not found" }],
      tolerancePx,
      suggestedStatus: "todo"
    };
  }

  const currentDelta = {
    left: roundNumber(current.bbox.left - currentReference.bbox.left),
    top: roundNumber(current.bbox.top - currentReference.bbox.top),
    width: roundNumber(current.bbox.width - currentReference.bbox.width),
    height: roundNumber(current.bbox.height - currentReference.bbox.height)
  };
  const differences = compareNumericRecord(measurement.delta, currentDelta, tolerancePx, ["left", "top", "width", "height"]);

  compareStyleValue(differences, "color", measurement.delta.color?.[1], current.computedStyle.color);
  compareStyleValue(differences, "background-color", measurement.delta.backgroundColor?.[1], current.computedStyle["background-color"]);
  compareStyleValue(differences, "font-size", measurement.delta.fontSize?.[1], current.computedStyle["font-size"]);

  return {
    selectorFound: true,
    referenceFound: true,
    original: { delta: measurement.delta, targetBbox: measurement.targetBbox, referenceBbox: measurement.referenceBbox },
    current: { delta: currentDelta, target: current, reference: currentReference },
    differences,
    tolerancePx,
    suggestedStatus: hasMeaningfulChange(differences) ? "fixed" : "todo"
  };
}

async function measureSelectorOnPage(page: Page, selector: string): Promise<{ bbox: BoundingBox; computedStyle: Record<string, string> } | null> {
  return page.evaluate((candidateSelector) => {
    const element = document.querySelector(candidateSelector);

    if (!element) {
      return null;
    }

    const rect = element.getBoundingClientRect();
    const styles = window.getComputedStyle(element);
    const round = (value: number) => Math.round(value * 100) / 100;

    return {
      bbox: {
        x: round(rect.x),
        y: round(rect.y),
        width: round(rect.width),
        height: round(rect.height),
        top: round(rect.top),
        right: round(rect.right),
        bottom: round(rect.bottom),
        left: round(rect.left)
      },
      computedStyle: {
        color: styles.color,
        "background-color": styles.backgroundColor,
        "font-size": styles.fontSize,
        padding: styles.padding,
        margin: styles.margin,
        width: styles.width,
        height: styles.height,
        "border-radius": styles.borderRadius
      }
    };
  }, selector);
}

function compareBoundingBoxes(
  original: BoundingBox,
  current: BoundingBox,
  tolerancePx: number
): CompareReport["differences"] {
  return compareNumericRecord(original, current, tolerancePx, ["x", "y", "width", "height", "top", "right", "bottom", "left"]);
}

function compareNumericRecord(
  original: object,
  current: object,
  tolerancePx: number,
  fields: string[]
): CompareReport["differences"] {
  const originalRecord = original as Record<string, unknown>;
  const currentRecord = current as Record<string, unknown>;

  return fields.map((field) => {
    const originalValue = Number(originalRecord[field]);
    const currentValue = Number(currentRecord[field]);
    const delta = roundNumber(currentValue - originalValue);

    return {
      field,
      original: originalValue,
      current: currentValue,
      delta,
      withinTolerance: Math.abs(delta) <= tolerancePx
    };
  });
}

function compareStyleValue(
  differences: CompareReport["differences"],
  field: string,
  original: string | undefined,
  current: string | undefined
): void {
  if (original === undefined || current === undefined) {
    return;
  }

  differences.push({
    field,
    original,
    current,
    withinTolerance: original === current
  });
}

function hasMeaningfulChange(differences: CompareReport["differences"]): boolean {
  return differences.some((difference) => difference.withinTolerance === false);
}

async function writeVerificationArtifacts(
  artifactDirectory: string,
  indexed: Awaited<ReturnType<typeof findLatestIssue>>,
  report: CompareReport,
  page: Page
): Promise<void> {
  await mkdir(artifactDirectory, { recursive: true });
  await copyFile(indexed.screenshotPath, path.join(artifactDirectory, "before.png"));
  await page.screenshot({ path: path.join(artifactDirectory, "after.png"), fullPage: true });
  await writeFile(path.join(artifactDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(artifactDirectory, "report.md"), `${renderCompareReport(indexed.stableId, "", artifactDirectory, report)}\n`);
}

function renderCompareReport(
  issueId: string,
  targetUrl: string,
  artifactDirectory: string,
  report: CompareReport
): string {
  return [
    `Issue ${issueId}`,
    targetUrl ? `URL: ${targetUrl}` : null,
    `Selector found: ${report.selectorFound ? "yes" : "no"}`,
    report.referenceFound === undefined ? null : `Reference found: ${report.referenceFound ? "yes" : "no"}`,
    `Tolerance: ${report.tolerancePx}px`,
    `Suggested status: ${report.suggestedStatus}`,
    `Artifacts: ${artifactDirectory}`,
    "",
    "Differences:",
    ...report.differences.map((difference) =>
      `- ${difference.field}: ${String(difference.original)} -> ${String(difference.current)}${typeof difference.delta === "number" ? ` (${formatSignedNumber(difference.delta)})` : ""} ${difference.withinTolerance ? "ok" : "changed"}`
    )
  ].filter((line): line is string => line !== null).join("\n");
}

function readTolerance(args: string[]): number {
  const value = readOption(args, "--tolerance") ?? "2";
  const tolerance = Number(value);

  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new Error(`Invalid --tolerance value: ${value}`);
  }

  return tolerance;
}

function roundNumber(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatSignedNumber(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

async function markIssue(args: string[]): Promise<void> {
  const [reference, status] = readPositionalArgs(args);

  if (!reference || !isIssueStatus(status)) {
    throw new Error("Usage: vernier mark <issue-id> todo|fixed");
  }

  const issue = await markLatestIssue(process.cwd(), reference, status);

  console.log(`Marked ${issue.stableId} ${status}.`);
}

function readIssueStatusFilter(args: string[]): IssueStatus | "all" {
  if (args.includes("--todo")) {
    return "todo";
  }

  if (args.includes("--fixed")) {
    return "fixed";
  }

  return "all";
}

function readRequiredReference(args: string[], command: string): string {
  const reference = readPositionalArgs(args)[0];

  if (!reference) {
    throw new Error(`Usage: vernier ${command} <issue-id>`);
  }

  return reference;
}

async function sendIssueToAgent(args: string[]): Promise<void> {
  const reference = readPositionalArgs(args)[0] ?? "all";
  const agent = readOption(args, "--to");

  if (agent !== "codex" && agent !== "claude") {
    throw new Error("Usage: vernier send <issue-id> --to codex|claude");
  }

  const task = reference === "all"
    ? await createIssuesSendTask(args)
    : renderIssueTask(await findLatestIssue(process.cwd(), reference));

  if (args.includes("--print")) {
    console.log(task);
    return;
  }

  const result = await runAgent(agent, task);

  if (result === "started") {
    return;
  }

  await copyToClipboard(task);
  console.log(`Could not find the ${agent} CLI on PATH.`);
  console.log("Copied the Vernier task to clipboard instead. Paste it into the Codex app or install the CLI.");
}

async function createIssuesSendTask(args: string[]): Promise<string> {
  const issues = filterIssuesByStatus(await listLatestIssues(process.cwd()), args.includes("--all") ? "all" : "todo");

  if (issues.length === 0) {
    return args.includes("--all")
      ? "No issues in latest Vernier session."
      : "No todo issues in latest Vernier session. Use --all to include fixed issues.";
  }

  return renderIssuesTask(issues);
}

async function runAgent(agent: "codex" | "claude", task: string): Promise<"started" | "missing"> {
  const executable = agent === "codex" ? "codex" : "claude";

  return new Promise((resolve, reject) => {
    const child = spawn(executable, [task], {
      cwd: process.cwd(),
      stdio: "inherit"
    });

    child.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        resolve("missing");
        return;
      }

      reject(new Error(`Could not start ${executable}: ${error.message}`));
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve("started");
        return;
      }

      reject(new Error(`${executable} exited with code ${code}`));
    });
  });
}

async function copyToClipboard(value: string): Promise<void> {
  const commands =
    process.platform === "win32"
      ? [["clip.exe"]]
      : process.platform === "darwin"
        ? [["pbcopy"]]
        : [
            ["wl-copy"],
            ["xclip", "-selection", "clipboard"],
            ["xsel", "--clipboard", "--input"]
          ];

  for (const command of commands) {
    if (await tryClipboardCommand(command, value)) {
      return;
    }
  }

  throw new Error("No clipboard command available. Run with --print to write the task to stdout.");
}

function tryClipboardCommand(command: string[], value: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command[0]!, command.slice(1), {
      stdio: ["pipe", "ignore", "ignore"],
      shell: process.platform === "win32"
    });

    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
    child.stdin.end(value);
  });
}

async function detectLocalApps(args: string[]): Promise<void> {
  const apps = await scanLocalApps(parseDetectPorts(args));

  if (apps.length === 0) {
    console.log("No local web apps found.");
    console.log(`Try: vernier --target ${defaultTarget}`);
    return;
  }

  console.log("Found local web apps:");
  for (const app of apps) {
    console.log(`  ${app.url}  ${app.label} (${app.status})`);
  }

  console.log("");
  console.log("Attach Vernier:");
  console.log(`  vernier attach --target ${apps[0].url}`);
}

async function attachToLocalApp(args: string[]): Promise<void> {
  const target = await resolveAttachTarget(args);
  const options = parseProxyOptions(["--target", target, ...args.filter((arg) => arg !== "--open" && arg !== "--no-open")]);

  await startProxyServer(options, { open: !args.includes("--no-open") });
}

async function resolveAttachTarget(args: string[]): Promise<string> {
  const explicitTarget = readOption(args, "--target") ?? readPositionalTarget(args);

  if (explicitTarget) {
    return explicitTarget;
  }

  const apps = await scanLocalApps(parseDetectPorts(args));

  if (apps.length === 0) {
    throw new Error(`No local web apps found. Start your app, or run: vernier attach --target ${defaultTarget}`);
  }

  console.log(`[vernier] detected ${apps[0].label} at ${apps[0].url}`);
  return apps[0].url;
}

async function scanLocalApps(ports: number[]): Promise<DetectedApp[]> {
  return (await Promise.all(ports.map((port) => detectPort(port)))).filter(
    (app): app is DetectedApp => Boolean(app)
  );
}

function parseDetectPorts(args: string[]): number[] {
  const portsValue = readOption(args, "--ports");

  if (!portsValue) {
    return defaultDetectPorts;
  }

  const ports = portsValue.split(",").map((value) => Number(value.trim()));

  if (ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error(`Invalid --ports value: ${portsValue}`);
  }

  return [...new Set(ports)];
}

async function detectPort(port: number): Promise<DetectedApp | null> {
  const url = `http://127.0.0.1:${port}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 700);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: { accept: "text/html,*/*" }
    });
    const contentType = response.headers.get("content-type") ?? "";
    const server = response.headers.get("server") ?? "";
    const poweredBy = response.headers.get("x-powered-by") ?? "";
    const body = contentType.includes("text") || contentType.includes("html") ? await response.text() : "";

    return {
      url,
      status: response.status,
      label: classifyDetectedApp(port, body, server, poweredBy)
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function classifyDetectedApp(port: number, body: string, server: string, poweredBy: string): string {
  const hints = `${body}\n${server}\n${poweredBy}`.toLowerCase();

  if (hints.includes("/@vite/client") || hints.includes("vite")) {
    return "Vite";
  }

  if (hints.includes("__next") || poweredBy.toLowerCase().includes("next")) {
    return "Next.js";
  }

  if (hints.includes("storybook") || port === 6006) {
    return "Storybook";
  }

  if (hints.includes("astro")) {
    return "Astro";
  }

  if (hints.includes("webpack")) {
    return "Webpack dev server";
  }

  return "HTTP app";
}

function parseProxyOptions(args: string[]): ProxyOptions {
  const targetValue = readOption(args, "--target") ?? readPositionalTarget(args) ?? defaultTarget;
  const portValue = readOption(args, "--port") ?? String(defaultPort);
  const port = portValue === "auto" ? "auto" : Number(portValue);

  if (port !== "auto" && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error(`Invalid --port value: ${portValue}`);
  }

  return {
    target: new URL(targetValue),
    port,
    root: process.cwd()
  };
}

async function startProxyServer(options: ProxyOptions, settings: { open: boolean }): Promise<void> {
  const server = createServer((request, response) => {
    void handleProxyRequest(options, request, response);
  });
  server.on("upgrade", (request, socket, head) => {
    handleProxyUpgrade(options, request, socket, head);
  });

  const requestedPort = options.port === "auto" ? defaultPort : options.port;
  const port = await listenWithPortFallback(server, requestedPort);
  const proxyUrl = `http://127.0.0.1:${port}`;

  options.port = port;
  console.log(`[vernier] proxy listening on ${proxyUrl}`);
  console.log(`[vernier] forwarding to ${options.target.origin}`);
  console.log(`[vernier] sessions write to ${options.root}`);

  if (settings.open) {
    await openUrl(proxyUrl);
  }
}

function listenWithPortFallback(server: ReturnType<typeof createServer>, requestedPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let port = requestedPort;
    let attempts = 0;

    const listen = () => {
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", onError);
        resolve(port);
      });
    };

    const onError = (error: NodeJS.ErrnoException) => {
      server.off("error", onError);

      if (error.code !== "EADDRINUSE" || attempts >= maxPortFallbackAttempts) {
        reject(error);
        return;
      }

      const busyPort = port;
      port += 1;
      attempts += 1;
      console.log(`[vernier] Port ${busyPort} is busy.`);
      console.log(`[vernier] Using http://127.0.0.1:${port} instead.`);
      listen();
    };

    listen();
  });
}

async function handleProxyRequest(
  options: ProxyOptions,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  if (await handleVernierSessionRequest(options.root, request, response)) {
    return;
  }

  const requestPath = request.url?.split("?")[0];

  if (requestPath === vernierOverlayPath) {
    sendJavaScript(
      response,
      createVernierOverlayScript({ html2canvasImportPath: vernierHtml2CanvasPath })
    );
    return;
  }

  if (requestPath === vernierHtml2CanvasPath) {
    await sendFile(response, resolveHtml2CanvasPath(), "text/javascript");
    return;
  }

  try {
    await forwardRequest(options, request, response);
  } catch (error) {
    if (error instanceof ProxyRequestError) {
      sendText(response, error.statusCode, error.message);
      return;
    }

    sendProxyError(response, options.target, error);
  }
}

function handleProxyUpgrade(
  options: ProxyOptions,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer
): void {
  const targetUrl = new URL(request.url ?? "/", options.target);
  const targetPort = Number(targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80));
  const upstream = targetUrl.protocol === "https:"
    ? connectTls(targetPort, targetUrl.hostname)
    : connectNet(targetPort, targetUrl.hostname);

  upstream.on("connect", () => {
    upstream.write(createUpgradeRequest(request, targetUrl));

    if (head.byteLength > 0) {
      upstream.write(head);
    }

    upstream.pipe(socket);
    socket.pipe(upstream);
  });

  upstream.on("error", () => {
    socket.destroy();
  });
  socket.on("error", () => {
    upstream.destroy();
  });
  socket.on("close", () => {
    upstream.destroy();
  });
}

function createUpgradeRequest(request: IncomingMessage, targetUrl: URL): string {
  const pathAndQuery = `${targetUrl.pathname}${targetUrl.search}`;
  const lines = [`${request.method ?? "GET"} ${pathAndQuery} HTTP/${request.httpVersion}`];
  const rawHeaders = request.rawHeaders;

  lines.push(`Host: ${targetUrl.host}`);

  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]!;
    const value = rawHeaders[index + 1] ?? "";
    const normalizedName = name.toLowerCase();

    if (normalizedName === "host" || normalizedName === "proxy-connection") {
      continue;
    }

    lines.push(`${name}: ${value}`);
  }

  return `${lines.join("\r\n")}\r\n\r\n`;
}

async function forwardRequest(
  options: ProxyOptions,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const targetUrl = new URL(request.url ?? "/", options.target);
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await readRequestBody(request);
  const upstream = await fetch(targetUrl, {
    method: request.method,
    headers: toForwardHeaders(request, options.target),
    body,
    redirect: "manual"
  });
  const contentType = upstream.headers.get("content-type") ?? "";
  const isHtml = contentType.includes("text/html");

  copyResponseHeaders(upstream, response, options);
  response.statusCode = upstream.status;

  if (isRedirectStatus(upstream.status)) {
    response.end();
    return;
  }

  if (contentType.includes("text/event-stream") && upstream.body) {
    await pipeline(Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]), response);
    return;
  }

  if (isHtml) {
    const html = await upstream.text();
    response.end(injectVernierOverlay(html));
    return;
  }

  response.end(Buffer.from(await upstream.arrayBuffer()));
}

function toForwardHeaders(request: IncomingMessage, target: URL): Headers {
  const headers = new Headers();

  for (const [key, value] of Object.entries(request.headers)) {
    if (!value || isHopByHopHeader(key)) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
    } else {
      headers.set(key, value);
    }
  }

  headers.set("host", target.host);

  return headers;
}

function copyResponseHeaders(upstream: Response, response: ServerResponse, options: ProxyOptions): void {
  const setCookies = readSetCookieHeaders(upstream);

  upstream.headers.forEach((value, key) => {
    const normalizedKey = key.toLowerCase();

    if (
      isHopByHopHeader(key) ||
      normalizedKey === "set-cookie" ||
      normalizedKey === "content-encoding" ||
      normalizedKey === "content-length" ||
      normalizedKey === "content-md5"
    ) {
      return;
    }

    response.setHeader(key, key.toLowerCase() === "location" ? rewriteLocationHeader(value, options) : value);
  });

  if (setCookies.length > 0) {
    response.setHeader("set-cookie", setCookies.map((cookie) => rewriteSetCookieHeader(cookie, options.target)));
  }
}

function readSetCookieHeaders(upstream: Response): string[] {
  const headers = upstream.headers as Headers & { getSetCookie?: () => string[] };
  const setCookies = headers.getSetCookie?.();

  if (setCookies && setCookies.length > 0) {
    return setCookies;
  }

  const fallback = upstream.headers.get("set-cookie");
  return fallback ? [fallback] : [];
}

function rewriteSetCookieHeader(cookie: string, target: URL): string {
  const targetHost = target.hostname.toLowerCase();

  return cookie
    .split(";")
    .map((part) => {
      const trimmed = part.trim();
      const [name, ...rest] = trimmed.split("=");

      if (name.toLowerCase() !== "domain") {
        return trimmed;
      }

      const domain = rest.join("=").trim().replace(/^\./, "").toLowerCase();
      return domain === targetHost || targetHost.endsWith(`.${domain}`) ? "" : trimmed;
    })
    .filter(Boolean)
    .join("; ");
}

function rewriteLocationHeader(location: string, options: ProxyOptions): string {
  let locationUrl: URL;

  try {
    locationUrl = new URL(location, options.target);
  } catch {
    return location;
  }

  if (locationUrl.origin !== options.target.origin) {
    return location;
  }

  return `${locationUrl.pathname}${locationUrl.search}${locationUrl.hash}`;
}

function isRedirectStatus(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

function isHopByHopHeader(header: string): boolean {
  return [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade"
  ].includes(header.toLowerCase());
}

function readRequestBody(request: IncomingMessage): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let rejected = false;

    request.on("data", (chunk: Buffer) => {
      if (rejected) {
        return;
      }

      bytes += chunk.byteLength;

      if (bytes > maxProxyBodyBytes) {
        rejected = true;
        reject(new ProxyRequestError(`Proxy request body exceeds ${maxProxyBodyBytes} bytes`, 413));
        request.destroy();
        return;
      }

      chunks.push(chunk);
    });
    request.on("end", () => {
      if (rejected) {
        return;
      }

      const body = Buffer.concat(chunks);
      resolve(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
    });
    request.on("error", reject);
  });
}

class ProxyRequestError extends Error {
  constructor(
    message: string,
    public statusCode: number
  ) {
    super(message);
  }
}

function sendJavaScript(response: ServerResponse, source: string): void {
  response.statusCode = 200;
  response.setHeader("Content-Type", "text/javascript");
  response.end(source);
}

function sendText(response: ServerResponse, statusCode: number, message: string): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.end(message);
}

function sendProxyError(response: ServerResponse, target: URL, error: unknown): void {
  const message = error instanceof Error ? error.message : "Unknown proxy error";

  response.statusCode = 502;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Vernier proxy target unavailable</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f7f9; color: #172033; font-family: system-ui, sans-serif; }
      main { max-width: 680px; padding: 32px; border: 1px solid #d8dde8; border-radius: 8px; background: #fff; box-shadow: 0 12px 32px rgba(23, 32, 51, 0.12); }
      code { padding: 2px 5px; border-radius: 4px; background: #eef1f6; }
      pre { overflow: auto; padding: 12px; border-radius: 6px; background: #172033; color: #fff; }
    </style>
  </head>
  <body>
    <main>
      <h1>Vernier cannot reach the target app</h1>
      <p>The proxy is running, but <code>${escapeHtml(target.origin)}</code> refused the connection.</p>
      <p>Start your app first, then refresh this proxy URL.</p>
      <pre>${escapeHtml(message)}</pre>
    </main>
  </body>
</html>`);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function sendFile(response: ServerResponse, filePath: string, contentType: string): Promise<void> {
  response.statusCode = 200;
  response.setHeader("Content-Type", contentType);
  await pipeline(createReadStream(filePath), response);
}

function resolveHtml2CanvasPath(): string {
  return require.resolve("html2canvas/dist/html2canvas.esm.js");
}

function readOption(args: string[], name: string): string | null {
  const index = args.indexOf(name);

  return index >= 0 ? args[index + 1] ?? null : null;
}

function isIssueStatus(value: string | undefined): value is IssueStatus {
  return value === "todo" || value === "fixed";
}

function readPositionalArgs(args: string[]): string[] {
  const positional: string[] = [];
  const optionsWithValues = new Set(["--target", "--port", "--ports", "--to"]);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;

    if (arg.startsWith("--")) {
      if (optionsWithValues.has(arg)) {
        index += 1;
      }
      continue;
    }

    if (!arg.startsWith("-")) {
      positional.push(arg);
    }
  }

  return positional;
}

function readPositionalTarget(args: string[]): string | null {
  return args.find((arg) => !arg.startsWith("-") && isUrlLike(arg)) ?? null;
}

function isUrlLike(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

async function openLatestSessionDirectory(root: string): Promise<void> {
  const latestDirectory = path.join(root, ".ui-feedback", "latest");

  await access(latestDirectory);

  if (process.platform === "win32") {
    spawn("explorer.exe", [latestDirectory], { detached: true, stdio: "ignore" }).unref();
    return;
  }

  if (process.platform === "darwin") {
    spawn("open", [latestDirectory], { detached: true, stdio: "ignore" }).unref();
    return;
  }

  spawn("xdg-open", [latestDirectory], { detached: true, stdio: "ignore" }).unref();
}

async function openUrl(url: string): Promise<void> {
  if (process.platform === "win32") {
    spawn("explorer.exe", [url], { detached: true, stdio: "ignore" }).unref();
    return;
  }

  if (process.platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    return;
  }

  spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

function createIssueTargetUrl(target: string, route: string): string {
  return new URL(route || "/", target).toString();
}

function printHelp(): void {
  console.log(
    [
      "Usage:",
      "  vernier [--target http://localhost:5173] [--port 3333|auto]",
      "  vernier attach [--target <url>] [--ports 5173,3000,6006] [--open|--no-open]",
      "  vernier start [--target <url>] [--port 3333|auto]",
      "  vernier proxy [--target <url>] [--port 3333|auto]",
      "  vernier http://localhost:5173",
      "  vernier detect [--ports 5173,3000,6006]",
      "  vernier issues [--todo|--fixed|--all]",
      "  vernier show <issue-id>",
      "  vernier copy <issue-id> [--print]",
      "  vernier mark <issue-id> todo|fixed",
      "  vernier verify <issue-id> [--target <url>] [--open]",
      "  vernier verify <issue-id> --compare [--target <url>] [--tolerance 2]",
      "  vernier send [all|<issue-id>] --to codex|claude [--all] [--print]",
      "  vernier latest",
      "  vernier open",
      "",
      `Latest session path: ${latestSessionMarkdownPath}`
    ].join("\n")
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
