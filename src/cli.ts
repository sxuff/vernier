#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import path from "node:path";
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
  port: number;
  root: string;
}

interface DetectedApp {
  url: string;
  label: string;
  status: number;
}

const require = createRequire(import.meta.url);
const defaultTarget = "http://localhost:5173";
const defaultPort = "3333";
const defaultDetectPorts = [5173, 3000, 3001, 4173, 4200, 4321, 5000, 5174, 6006, 8000, 8080];
const maxProxyBodyBytes = 30 * 1024 * 1024;

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
    const server = createServer((request, response) => {
      void handleProxyRequest(options, request, response);
    });

    server.listen(options.port, "127.0.0.1", () => {
      console.log(`[vernier] proxy listening on http://127.0.0.1:${options.port}`);
      console.log(`[vernier] forwarding to ${options.target.origin}`);
      console.log(`[vernier] sessions write to ${options.root}`);
    });
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
  const verification = renderIssueVerification(issue, targetUrl);

  console.log(verification);

  if (args.includes("--open")) {
    await openUrl(targetUrl);
  }
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
  const ports = parseDetectPorts(args);
  const apps = (await Promise.all(ports.map((port) => detectPort(port)))).filter(
    (app): app is DetectedApp => Boolean(app)
  );

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
  console.log(`  vernier --target ${apps[0].url}`);
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
  const portValue = readOption(args, "--port") ?? defaultPort;
  const port = Number(portValue);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid --port value: ${portValue}`);
  }

  return {
    target: new URL(targetValue),
    port,
    root: process.cwd()
  };
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

  copyResponseHeaders(upstream, response);
  response.statusCode = upstream.status;

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

function copyResponseHeaders(upstream: Response, response: ServerResponse): void {
  upstream.headers.forEach((value, key) => {
    const normalizedKey = key.toLowerCase();

    if (
      isHopByHopHeader(key) ||
      normalizedKey === "content-encoding" ||
      normalizedKey === "content-length" ||
      normalizedKey === "content-md5"
    ) {
      return;
    }

    response.setHeader(key, value);
  });
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
      "  vernier [--target http://localhost:5173] [--port 3333]",
      "  vernier start [--target <url>] [--port 3333]",
      "  vernier proxy [--target <url>] [--port 3333]",
      "  vernier http://localhost:5173",
      "  vernier detect [--ports 5173,3000,6006]",
      "  vernier issues [--todo|--fixed|--all]",
      "  vernier show <issue-id>",
      "  vernier copy <issue-id> [--print]",
      "  vernier mark <issue-id> todo|fixed",
      "  vernier verify <issue-id> [--target <url>] [--open]",
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
