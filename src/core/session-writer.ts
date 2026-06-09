import { cp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { VernierSession } from "../schema";

export async function writeSession(root: string, session: VernierSession): Promise<string> {
  const slug = `${session.createdAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}-${slugify(session.route)}`;
  const baseDirectory = path.join(root, ".ui-feedback", "sessions", slug);
  const screenshotsDirectory = path.join(baseDirectory, "screenshots");

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
    `Schema version: ${session.schemaVersion}`,
    `Tool version: ${session.toolVersion}`,
    `Session ID: ${session.sessionId}`,
    `Created: ${session.createdAt}`,
    `Route: ${session.route}`,
    `URL: ${session.url}`,
    `Viewport: ${session.viewport.width}x${session.viewport.height} @${session.viewport.devicePixelRatio}x`,
    `Issue count: ${session.issues.length}`,
    ""
  ];

  for (const issue of session.issues) {
    lines.push(
      `## Issue ${issue.id} - ${titleCase(issue.kind)}`,
      `Stable ID: ${issue.stableId}`,
      "Instruction:",
      issue.note || "Fix the measured UI issue. Prefer minimal changes.",
      "",
      "Measured:",
      ...formatMeasured(issue.measured),
      "",
      "Target:",
      `Selector: ${issue.selector}`,
      `Source: ${issue.source}`,
      "",
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

function formatMeasured(measured: string): string[] {
  return measured.split("\n").map((line) => `- ${line}`);
}

function titleCase(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

async function updateLatestLink(root: string, targetDirectory: string): Promise<void> {
  const latestPath = path.join(root, ".ui-feedback", "latest");
  let latestKind = "junction";

  await rm(latestPath, { recursive: true, force: true });

  try {
    await symlink(targetDirectory, latestPath, "junction");
  } catch {
    latestKind = "copy";
    await cp(targetDirectory, latestPath, { recursive: true });
  }

  await writeFile(
    path.join(root, ".ui-feedback", "latest.json"),
    `${JSON.stringify(
      {
        kind: latestKind,
        target: path.relative(path.join(root, ".ui-feedback"), targetDirectory),
        updatedAt: new Date().toISOString()
      },
      null,
      2
    )}\n`
  );
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
