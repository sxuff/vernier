import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ViteDevServer } from "vite";
import type { VernierIssue, VernierSession } from "./schema";

const sessionRoute = "/__vernier/session";

export function registerSessionMiddleware(server: ViteDevServer): void {
  server.middlewares.use(async (request, response, next) => {
    const requestPath = request.url?.split("?")[0];

    if (requestPath !== sessionRoute) {
      next();
      return;
    }

    if (request.method !== "POST") {
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }

    try {
      const session = JSON.parse(await readBody(request)) as VernierSession;
      const sessionDirectory = await writeSession(server.config.root, session);

      sendJson(response, 200, { ok: true, sessionDirectory });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      sendJson(response, 500, { error: message });
    }
  });
}

async function writeSession(root: string, session: VernierSession): Promise<string> {
  const slug = `${session.createdAt.slice(0, 10)}-${slugify(session.route)}`;
  const baseDirectory = path.join(root, ".ui-feedback", "sessions", slug);
  const screenshotsDirectory = path.join(baseDirectory, "screenshots");

  await rm(baseDirectory, { recursive: true, force: true });
  await mkdir(screenshotsDirectory, { recursive: true });
  await writeFile(path.join(baseDirectory, "session.json"), `${JSON.stringify(session, null, 2)}\n`);
  await writeFile(path.join(baseDirectory, "session.md"), renderSessionMarkdown(session));

  for (const issue of session.issues) {
    await writeDataUrl(path.join(screenshotsDirectory, issue.screenshotName), issue.screenshotDataUrl);
  }

  await writeDataUrl(
    path.join(screenshotsDirectory, session.fullPageScreenshotName),
    session.fullPageScreenshotDataUrl
  );
  await updateLatestLink(root, baseDirectory);

  return baseDirectory;
}

function renderSessionMarkdown(session: VernierSession): string {
  const lines = [
    "# UI Feedback Session - Vernier",
    `Route: ${session.route}`,
    `Viewport: ${session.viewport.width}x${session.viewport.height} @${session.viewport.devicePixelRatio}x`,
    ""
  ];

  for (const issue of session.issues) {
    lines.push(
      `## Issue ${issue.id} - ${issue.kind}`,
      issue.measured,
      `Selector: ${issue.selector}`,
      `Source: ${issue.source}`,
      `Note: ${issue.note}`,
      `Screenshot: ./screenshots/${issue.screenshotName}`,
      ""
    );
  }

  lines.push(
    "## Agent instruction",
    "Fix the issues above. Prefer minimal changes. Use existing design tokens.",
    "Map each change back to an issue number and state the file:line touched.",
    ""
  );

  return lines.join("\n");
}

async function updateLatestLink(root: string, targetDirectory: string): Promise<void> {
  const latestPath = path.join(root, ".ui-feedback", "latest");

  await rm(latestPath, { recursive: true, force: true });

  try {
    await symlink(targetDirectory, latestPath, "junction");
  } catch {
    await mkdir(latestPath, { recursive: true });
    await writeFile(path.join(latestPath, "README.txt"), `Latest session: ${targetDirectory}\n`);
  }
}

async function writeDataUrl(filePath: string, dataUrl: string): Promise<void> {
  const base64 = dataUrl.split(",")[1];

  if (!base64) {
    throw new Error(`Invalid data URL for ${filePath}`);
  }

  await writeFile(filePath, Buffer.from(base64, "base64"));
}

function slugify(value: string): string {
  return (
    value
      .replace(/^\/+/, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase() || "root"
  );
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(payload));
}

