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
  await writeFile(path.join(baseDirectory, "screenshots.json"), `${JSON.stringify(renderScreenshotInventory(session), null, 2)}\n`);
  await writeFile(
    path.join(baseDirectory, "metadata.json"),
    `${JSON.stringify(
      {
        localOnly: true,
        networkUploads: false,
        createdBy: "vernier",
        createdAt: session.createdAt,
        sessionId: session.sessionId,
        privacy: "Screenshots and UI feedback are written only to this local .ui-feedback directory."
      },
      null,
      2
    )}\n`
  );

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

export function renderSessionMarkdown(session: VernierSession): string {
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
      ...formatStructuredMeasurement(issue),
      ...formatRedaction(issue),
      "",
      "Target:",
      `Selector: ${issue.selector}`,
      `Selector confidence: ${issue.target?.selectorConfidence ?? "unknown"}${issue.target?.selectorReason ? ` (${issue.target.selectorReason})` : ""}`,
      `Source: ${issue.source}`,
      `Source confidence: ${issue.target?.sourceConfidence ?? "unknown"}`,
      `Source resolver: ${issue.target?.sourceResolver ?? "unknown"}`,
      `Component: ${issue.target?.componentName ?? "unknown"}`,
      `Element: ${formatTarget(issue)}`,
      "",
      `Screenshot: ./screenshots/${issue.screenshotName}`,
      `Screenshot metadata: ${issue.screenshot.width}x${issue.screenshot.height}, ${issue.screenshot.captureStrategy}, ${issue.screenshot.hash}`,
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

function renderScreenshotInventory(session: VernierSession): Array<VernierSession["fullPageScreenshot"]> {
  return [
    session.fullPageScreenshot,
    ...session.issues.map((issue) => issue.screenshot)
  ];
}

function formatTarget(issue: VernierSession["issues"][number]): string {
  const target = issue.target;

  if (!target) {
    return issue.selector;
  }

  const parts = [
    target.tag,
    target.testId ? `data-testid=${target.testId}` : null,
    target.id ? `id=${target.id}` : null,
    target.role ? `role=${target.role}` : null,
    target.accessibleName ? `name=${target.accessibleName}` : null
  ].filter(Boolean);

  return parts.join(" ");
}

function formatMeasured(measured: string): string[] {
  return measured.split("\n").map((line) => `- ${line}`);
}

function formatStructuredMeasurement(issue: VernierSession["issues"][number]): string[] {
  if (!issue.measurement) {
    return [];
  }

  return [
    "",
    "Structured evidence:",
    "```json",
    JSON.stringify(issue.measurement, null, 2),
    "```"
  ];
}

function formatRedaction(issue: VernierSession["issues"][number]): string[] {
  if (!issue.redaction || (issue.redaction.autoRedactedElements === 0 && !issue.redaction.manualRedaction)) {
    return [];
  }

  return [
    "",
    "Redaction:",
    `- Auto-redacted elements: ${issue.redaction.autoRedactedElements}`,
    `- Manual redaction: ${issue.redaction.manualRedaction ? "yes" : "no"}`
  ];
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
