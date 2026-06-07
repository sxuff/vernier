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

const require = createRequire(import.meta.url);

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  if (command === "proxy") {
    const options = parseProxyOptions(args);
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

function parseProxyOptions(args: string[]): ProxyOptions {
  const targetValue = readOption(args, "--target");
  const portValue = readOption(args, "--port") ?? "3333";

  if (!targetValue) {
    throw new Error("Missing required --target <url>");
  }

  return {
    target: new URL(targetValue),
    port: Number(portValue),
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
    headers: toForwardHeaders(request),
    body,
    redirect: "manual"
  });
  const contentType = upstream.headers.get("content-type") ?? "";
  const isHtml = contentType.includes("text/html");

  copyResponseHeaders(upstream, response, isHtml);
  response.statusCode = upstream.status;

  if (isHtml) {
    const html = await upstream.text();
    response.end(injectVernierOverlay(html));
    return;
  }

  response.end(Buffer.from(await upstream.arrayBuffer()));
}

function toForwardHeaders(request: IncomingMessage): Headers {
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

  return headers;
}

function copyResponseHeaders(upstream: Response, response: ServerResponse, transformed: boolean): void {
  upstream.headers.forEach((value, key) => {
    if (isHopByHopHeader(key) || (transformed && key.toLowerCase() === "content-length")) {
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

    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      resolve(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
    });
    request.on("error", reject);
  });
}

function sendJavaScript(response: ServerResponse, source: string): void {
  response.statusCode = 200;
  response.setHeader("Content-Type", "text/javascript");
  response.end(source);
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

function printHelp(): void {
  console.log(
    [
      "Usage:",
      "  vernier proxy --target <url> [--port 3333]",
      "  vernier latest",
      "  vernier prompt",
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
