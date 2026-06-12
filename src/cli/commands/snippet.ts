import { createReadStream } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "../lib/args";
import { VernierError } from "../lib/errors";
import type { OverlayRuntimeOptions, SessionOutputOptions } from "../../core/overlay-options";
import {
  createVernierOverlayScript,
  vernierHtml2CanvasPath,
  vernierModernScreenshotPath,
  vernierOverlayPath
} from "../../core/overlay-script";
import { handleVernierSessionRequest, vernierSessionPath } from "../../core/session-handler";
import { listenWithPortFallback } from "./proxy";

export interface SnippetConfig {
  port?: number | "auto";
  overlay?: OverlayRuntimeOptions;
  outDir?: string;
}

export interface StandaloneServerOptions extends SessionOutputOptions {
  port: number | "auto";
  root: string;
  overlay?: OverlayRuntimeOptions;
}

const require = createRequire(import.meta.url);
const defaultStandalonePort = 3333;

export async function startStandaloneServer(args: string[], config: SnippetConfig): Promise<void> {
  const options = parseStandaloneOptions(args, config);
  const server = createServer((request, response) => {
    void handleStandaloneRequest(options, request, response);
  });
  const requestedPort = options.port === "auto" ? defaultStandalonePort : options.port;
  const port = await listenWithPortFallback(server, requestedPort);
  const origin = `http://127.0.0.1:${port}`;

  console.log(`[vernier] standalone overlay server listening on ${origin}`);
  console.log(`[vernier] sessions write to ${options.root}`);
  console.log(renderSnippet(origin));
}

export function renderSnippet(origin: string): string {
  return `<script type="module" src="${origin}${vernierOverlayPath}"></script>`;
}

export function printSnippet(args: string[], config: SnippetConfig): string {
  const options = parseStandaloneOptions(args, config);
  const port = options.port === "auto" ? defaultStandalonePort : options.port;
  const origin = `http://127.0.0.1:${port}`;

  return [
    "Add this before </body>:",
    renderSnippet(origin),
    "",
    "Then run:",
    `vernier serve --port ${port}`,
    "",
    "The overlay writes sessions back to Vernier; your app does not need Vite or the proxy."
  ].join("\n");
}

function parseStandaloneOptions(args: string[], config: SnippetConfig): StandaloneServerOptions {
  const parsed = parseArgs(args, { valueOptions: ["--port", "--config"] });
  const portValue = parsed.option("--port") ?? process.env.VERNIER_PORT ?? String(config.port ?? defaultStandalonePort);
  const port = portValue === "auto" ? "auto" : Number(portValue);

  if (port !== "auto" && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new VernierError("VERNIER_INVALID_OPTION", `Invalid --port value: ${portValue}`, "Use a port from 1 to 65535, or --port auto.");
  }

  return {
    port,
    root: process.cwd(),
    overlay: config.overlay,
    outDir: config.outDir
  };
}

async function handleStandaloneRequest(
  options: StandaloneServerOptions,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  if (await handleVernierSessionRequest(options.root, request, response, { outDir: options.outDir })) {
    return;
  }

  const requestPath = request.url?.split("?")[0];
  const origin = requestOrigin(request);

  if (requestPath === vernierOverlayPath) {
    sendJavaScript(
      response,
      createVernierOverlayScript({
        html2canvasImportPath: `${origin}${vernierHtml2CanvasPath}`,
        modernScreenshotImportPath: `${origin}${vernierModernScreenshotPath}`,
        runtimeOptions: {
          ...options.overlay,
          sessionEndpoint: `${origin}${vernierSessionPath}`
        }
      })
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

  response.statusCode = 404;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.end("Vernier standalone server only serves overlay assets and session export endpoints.");
}

function requestOrigin(request: IncomingMessage): string {
  const host = request.headers.host ?? `127.0.0.1:${defaultStandalonePort}`;
  return `http://${host}`;
}

function sendJavaScript(response: ServerResponse, source: string): void {
  response.statusCode = 200;
  response.setHeader("Content-Type", "text/javascript");
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.end(source);
}

async function sendFile(response: ServerResponse, filePath: string, contentType: string): Promise<void> {
  response.statusCode = 200;
  response.setHeader("Content-Type", contentType);
  response.setHeader("Access-Control-Allow-Origin", "*");
  await pipeline(createReadStream(filePath), response);
}

function resolveHtml2CanvasPath(): string {
  return require.resolve("html2canvas/dist/html2canvas.esm.js");
}

function resolveModernScreenshotPath(): string {
  return require.resolve("modern-screenshot/dist/index.mjs");
}
