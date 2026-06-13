import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createRequire } from "node:module";
import { connect as connectNet } from "node:net";
import { type Duplex, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { connect as connectTls } from "node:tls";
import { injectVernierOverlay } from "../../core/html";
import type {
  OverlayRuntimeOptions,
  SessionOutputOptions,
} from "../../core/overlay-options";
import {
  createVernierOverlayScript,
  vernierHtml2CanvasPath,
  vernierModernScreenshotPath,
  vernierOverlayPath,
} from "../../core/overlay-script";
import { handleVernierSessionRequest } from "../../core/session-handler";
import { parseArgs } from "../lib/args";
import { debugLog } from "../lib/debug";
import { VernierError } from "../lib/errors";

export interface ProxyOptions extends SessionOutputOptions {
  target: URL;
  port: number | "auto";
  root: string;
  overlay?: OverlayRuntimeOptions;
}

export interface ProxyConfig {
  target?: string;
  port?: number | "auto";
  overlay?: OverlayRuntimeOptions;
  outDir?: string;
}

const require = createRequire(import.meta.url);
const defaultTarget = "http://localhost:5173";
const defaultPort = 3333;
const maxProxyBodyBytes = 30 * 1024 * 1024;
const maxPortFallbackAttempts = 20;

export function parseProxyOptions(
  args: string[],
  config: ProxyConfig = {},
): ProxyOptions {
  const targetValue = resolveTargetOption(args, config);
  const port = parsePortOption(args, resolveDefaultPort(config));

  return {
    target: parseUrlOption(targetValue, "target"),
    port,
    root: process.cwd(),
    overlay: config.overlay,
    outDir: config.outDir,
  };
}

function parsePortOption(
  args: string[],
  fallbackPort: number | "auto",
): number | "auto" {
  const portValue =
    parseArgs(args, { valueOptions: ["--port"] }).option("--port") ??
    process.env.VERNIER_PORT ??
    String(fallbackPort);
  const port = portValue === "auto" ? "auto" : Number(portValue);

  if (
    port !== "auto" &&
    (!Number.isInteger(port) || port < 1 || port > 65535)
  ) {
    throw new VernierError(
      "VERNIER_INVALID_OPTION",
      `Invalid --port value: ${portValue}`,
      "Use a port from 1 to 65535, or --port auto.",
    );
  }

  return port;
}

export function resolveTargetOption(
  args: string[],
  config: ProxyConfig,
): string {
  const parsed = parseArgs(args, {
    valueOptions: ["--target", "--port", "--config"],
  });
  return (
    parsed.option("--target") ??
    parsed.positionals().find(isUrlLike) ??
    process.env.VERNIER_TARGET ??
    config.target ??
    defaultTarget
  );
}

function resolveDefaultPort(config: ProxyConfig): number | "auto" {
  return process.env.VERNIER_PORT === undefined
    ? (config.port ?? defaultPort)
    : defaultPort;
}

export function parseUrlOption(value: string, field: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new VernierError(
      "VERNIER_INVALID_OPTION",
      `Invalid ${field} URL: ${value}`,
      "Use an absolute local URL, for example http://localhost:5173.",
    );
  }
}

export async function startProxyServer(
  options: ProxyOptions,
  settings: { open: boolean },
): Promise<void> {
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
  debugLog(
    "proxy",
    `target=${options.target.toString()} port=${port} root=${options.root} outDir=${options.outDir ?? ".ui-feedback"}`,
  );

  if (settings.open) {
    debugLog("proxy", `opening ${proxyUrl}`);
    await openUrl(proxyUrl);
  }
}

export function listenWithPortFallback(
  server: ReturnType<typeof createServer>,
  requestedPort: number,
): Promise<number> {
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
      debugLog("proxy", `port ${busyPort} busy, trying ${port}`);
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
  response: ServerResponse,
): Promise<void> {
  if (
    await handleVernierSessionRequest(options.root, request, response, {
      outDir: options.outDir,
    })
  ) {
    debugLog("session", `${request.method ?? "GET"} ${request.url ?? ""}`);
    return;
  }

  const requestPath = request.url?.split("?")[0];
  debugLog("proxy", `${request.method ?? "GET"} ${request.url ?? ""}`);

  if (requestPath === vernierOverlayPath) {
    sendJavaScript(
      response,
      createVernierOverlayScript({
        html2canvasImportPath: vernierHtml2CanvasPath,
        modernScreenshotImportPath: vernierModernScreenshotPath,
        runtimeOptions: options.overlay,
      }),
    );
    return;
  }

  if (requestPath === vernierHtml2CanvasPath) {
    await sendFile(response, resolveHtml2CanvasPath(), "text/javascript");
    return;
  }

  if (requestPath === vernierModernScreenshotPath) {
    await sendFile(response, resolveModernScreenshotPath(), "text/javascript");
    return;
  }

  try {
    await forwardRequest(options, request, response);
  } catch (error) {
    if (error instanceof ProxyRequestError) {
      debugLog("proxy", `request failed ${error.statusCode}: ${error.message}`);
      sendText(response, error.statusCode, error.message);
      return;
    }

    debugLog(
      "proxy",
      `target error: ${error instanceof Error ? error.message : String(error)}`,
    );
    sendProxyError(response, options.target, error);
  }
}

function handleProxyUpgrade(
  options: ProxyOptions,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): void {
  const targetUrl = new URL(request.url ?? "/", options.target);
  debugLog("proxy", `upgrade ${request.url ?? ""} -> ${targetUrl.toString()}`);
  const targetPort = Number(
    targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80),
  );
  const upstream =
    targetUrl.protocol === "https:"
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
    debugLog("proxy", `upgrade failed ${targetUrl.toString()}`);
    socket.destroy();
  });
  socket.on("error", () => {
    upstream.destroy();
  });
  socket.on("close", () => {
    upstream.destroy();
  });
}

function createUpgradeRequest(
  request: IncomingMessage,
  targetUrl: URL,
): string {
  const pathAndQuery = `${targetUrl.pathname}${targetUrl.search}`;
  const lines = [
    `${request.method ?? "GET"} ${pathAndQuery} HTTP/${request.httpVersion}`,
  ];
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
  response: ServerResponse,
): Promise<void> {
  const targetUrl = new URL(request.url ?? "/", options.target);
  debugLog(
    "proxy",
    `forward ${request.method ?? "GET"} ${targetUrl.toString()}`,
  );
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await readRequestBody(request);
  const upstream = await fetch(targetUrl, {
    method: request.method,
    headers: toForwardHeaders(request, options.target),
    body,
    redirect: "manual",
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
    await pipeline(
      Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]),
      response,
    );
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

function copyResponseHeaders(
  upstream: Response,
  response: ServerResponse,
  options: ProxyOptions,
): void {
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

    response.setHeader(
      key,
      key.toLowerCase() === "location"
        ? rewriteLocationHeader(value, options)
        : value,
    );
  });

  if (setCookies.length > 0) {
    response.setHeader(
      "set-cookie",
      setCookies.map((cookie) =>
        rewriteSetCookieHeader(cookie, options.target),
      ),
    );
  }
}

function readSetCookieHeaders(upstream: Response): string[] {
  const headers = upstream.headers as Headers & {
    getSetCookie?: () => string[];
  };
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
      return domain === targetHost || targetHost.endsWith(`.${domain}`)
        ? ""
        : trimmed;
    })
    .filter(Boolean)
    .join("; ");
}

function rewriteLocationHeader(
  location: string,
  options: ProxyOptions,
): string {
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
    "upgrade",
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
        reject(
          new ProxyRequestError(
            `Proxy request body exceeds ${maxProxyBodyBytes} bytes`,
            413,
          ),
        );
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
      resolve(
        body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      );
    });
    request.on("error", reject);
  });
}

class ProxyRequestError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
  }
}

function sendJavaScript(response: ServerResponse, source: string): void {
  response.statusCode = 200;
  response.setHeader("Content-Type", "text/javascript");
  response.end(source);
}

function sendText(
  response: ServerResponse,
  statusCode: number,
  message: string,
): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.end(message);
}

function sendProxyError(
  response: ServerResponse,
  target: URL,
  error: unknown,
): void {
  const message =
    error instanceof Error ? error.message : "Unknown proxy error";

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

async function sendFile(
  response: ServerResponse,
  filePath: string,
  contentType: string,
): Promise<void> {
  response.statusCode = 200;
  response.setHeader("Content-Type", contentType);
  await pipeline(createReadStream(filePath), response);
}

function resolveHtml2CanvasPath(): string {
  return require.resolve("html2canvas/dist/html2canvas.esm.js");
}

function resolveModernScreenshotPath(): string {
  return require.resolve("modern-screenshot/dist/index.mjs");
}

export function isUrlLike(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

export async function openUrl(url: string): Promise<void> {
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
