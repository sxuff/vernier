import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Browser } from "playwright";
import { parseArgs } from "../lib/args";
import { VernierError } from "../lib/errors";
import { parseUrlOption } from "./proxy";

const storybookValueOptions = ["--url", "--stories", "--viewports"];

interface StorybookStory {
  id: string;
  title: string;
  name: string;
  type?: string;
  importPath?: string;
  tags?: string[];
}

interface StorybookViewport {
  label: string;
  width: number;
  height: number;
  devicePixelRatio: number;
}

export async function captureStorybook(args: string[]): Promise<string> {
  const parsed = parseArgs(args, { valueOptions: storybookValueOptions });
  const url = parseUrlOption(
    parsed.option("--url") ??
      parsed.positionals()[0] ??
      "http://localhost:6006",
    "Storybook URL",
  );
  const stories = filterStories(
    await readStorybookIndex(url),
    parsed.option("--stories") ?? undefined,
  );
  const viewports = readStorybookViewports(args);
  const artifactDirectory = path.join(
    process.cwd(),
    ".ui-feedback",
    "storybook",
    new Date().toISOString().replace(/[:.]/g, "-"),
  );
  const screenshotsDirectory = path.join(artifactDirectory, "screenshots");
  const records: Array<{
    id: string;
    title: string;
    name: string;
    type?: string;
    importPath?: string;
    tags: string[];
    url: string;
    viewport: StorybookViewport;
    screenshotName: string;
    status: number | null;
    pageTitle: string;
  }> = [];
  const { chromium } = await import("playwright");
  let browser: Browser | null = null;

  if (stories.length === 0) {
    throw new VernierError(
      "VERNIER_NO_STORIES",
      "No Storybook stories matched.",
      "Check --stories IDs or the Storybook index.",
    );
  }

  await mkdir(screenshotsDirectory, { recursive: true });

  try {
    browser = await chromium.launch({ headless: true });

    for (const story of stories) {
      for (const viewport of viewports) {
        const page = await browser.newPage({
          viewport: {
            width: viewport.width,
            height: viewport.height,
          },
          deviceScaleFactor: viewport.devicePixelRatio,
        });

        try {
          const storyUrl = createStoryUrl(url, story.id);
          const response = await page.goto(storyUrl, {
            waitUntil: "networkidle",
          });
          const screenshotName = `${slugify(story.id)}-${viewportArtifactName(viewport)}.png`;
          await page.screenshot({
            path: path.join(screenshotsDirectory, screenshotName),
            fullPage: true,
          });
          records.push({
            id: story.id,
            title: story.title,
            name: story.name,
            type: story.type,
            importPath: story.importPath,
            tags: story.tags ?? [],
            url: storyUrl,
            viewport,
            screenshotName,
            status: response?.status() ?? null,
            pageTitle: await page.title(),
          });
        } finally {
          await page.close();
        }
      }
    }
  } finally {
    await browser?.close();
  }

  await writeStorybookReport(artifactDirectory, url.toString(), records);

  return [
    `Captured ${records.length} Storybook screenshot${records.length === 1 ? "" : "s"}.`,
    `Storybook: ${url.toString()}`,
    `Stories: ${stories.map((story) => story.id).join(", ")}`,
    `Viewports: ${viewports.map(formatViewport).join(", ")}`,
    `Artifacts: ${artifactDirectory}`,
  ].join("\n");
}

async function readStorybookIndex(url: URL): Promise<StorybookStory[]> {
  const candidates = [new URL("index.json", url), new URL("stories.json", url)];

  for (const candidate of candidates) {
    const response = await fetch(candidate);

    if (!response.ok) {
      continue;
    }

    return parseStorybookIndex(await response.json());
  }

  throw new VernierError(
    "VERNIER_STORYBOOK_INDEX",
    `Could not read Storybook index from ${url.toString()}`,
    "Start Storybook and confirm /index.json or /stories.json is reachable.",
  );
}

function parseStorybookIndex(value: unknown): StorybookStory[] {
  const record = isRecord(value) ? value : {};
  const entries = isRecord(record.entries)
    ? Object.values(record.entries)
    : isRecord(record.stories)
      ? Object.values(record.stories)
      : [];

  return entries
    .filter(isRecord)
    .map((entry) => ({
      id: typeof entry.id === "string" ? entry.id : "",
      title: typeof entry.title === "string" ? entry.title : "Untitled",
      name: typeof entry.name === "string" ? entry.name : "Default",
      type: typeof entry.type === "string" ? entry.type : undefined,
      importPath:
        typeof entry.importPath === "string" ? entry.importPath : undefined,
      tags: Array.isArray(entry.tags)
        ? entry.tags.filter((tag): tag is string => typeof tag === "string")
        : [],
    }))
    .filter((story) => story.id && (!story.type || story.type === "story"));
}

function filterStories(
  stories: StorybookStory[],
  selectedIds: string | undefined,
): StorybookStory[] {
  if (!selectedIds) {
    return stories;
  }

  const selected = new Set(
    selectedIds
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
  return stories.filter((story) => selected.has(story.id));
}

function readStorybookViewports(args: string[]): StorybookViewport[] {
  const value =
    parseArgs(args, { valueOptions: storybookValueOptions }).option(
      "--viewports",
    ) ?? "desktop";
  const viewports = value
    .split(",")
    .map((item) => parseViewport(item.trim()))
    .filter((item): item is StorybookViewport => item !== null);

  if (viewports.length === 0) {
    throw new VernierError(
      "VERNIER_INVALID_OPTION",
      `Invalid --viewports value: ${value}`,
      "Use names like mobile,tablet,desktop or sizes like 390x844,1440x900@2.",
    );
  }

  return viewports;
}

function parseViewport(value: string): StorybookViewport | null {
  if (value === "mobile") {
    return { label: "mobile", width: 390, height: 844, devicePixelRatio: 1 };
  }

  if (value === "tablet") {
    return { label: "tablet", width: 768, height: 1024, devicePixelRatio: 1 };
  }

  if (value === "desktop") {
    return { label: "desktop", width: 1440, height: 900, devicePixelRatio: 1 };
  }

  const match = value.match(/^(\d{2,5})x(\d{2,5})(?:@(\d+(?:\.\d+)?))?$/);

  if (!match) {
    return null;
  }

  const width = Number(match[1]);
  const height = Number(match[2]);
  const devicePixelRatio = match[3] ? Number(match[3]) : 1;

  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    !Number.isFinite(devicePixelRatio) ||
    width <= 0 ||
    height <= 0 ||
    devicePixelRatio <= 0
  ) {
    return null;
  }

  return { label: value, width, height, devicePixelRatio };
}

function createStoryUrl(base: URL, storyId: string): string {
  const url = new URL("iframe.html", base);
  url.searchParams.set("id", storyId);
  url.searchParams.set("viewMode", "story");
  return url.toString();
}

async function writeStorybookReport(
  artifactDirectory: string,
  storybookUrl: string,
  records: Array<{
    id: string;
    title: string;
    name: string;
    type?: string;
    importPath?: string;
    tags: string[];
    url: string;
    viewport: StorybookViewport;
    screenshotName: string;
    status: number | null;
    pageTitle: string;
  }>,
): Promise<void> {
  const report = {
    createdAt: new Date().toISOString(),
    storybookUrl,
    screenshotCount: records.length,
    records,
  };

  await writeFile(
    path.join(artifactDirectory, "storybook.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await writeFile(
    path.join(artifactDirectory, "storybook.md"),
    `${[
      "# Vernier Storybook Capture",
      "",
      `Storybook: ${storybookUrl}`,
      `Screenshot count: ${records.length}`,
      "",
      ...records.map((record) =>
        [
          `## ${record.title} / ${record.name}`,
          `Story ID: ${record.id}`,
          `URL: ${record.url}`,
          `Status: ${record.status ?? "unknown"}`,
          `Viewport: ${formatViewport(record.viewport)}`,
          record.importPath ? `Import path: ${record.importPath}` : null,
          record.tags.length > 0 ? `Tags: ${record.tags.join(", ")}` : null,
          `Screenshot: ./screenshots/${record.screenshotName}`,
          "",
        ]
          .filter((line): line is string => line !== null)
          .join("\n"),
      ),
    ].join("\n")}\n`,
  );
}

function viewportArtifactName(viewport: StorybookViewport): string {
  return `${viewport.label}-${viewport.width}x${viewport.height}@${viewport.devicePixelRatio}x`.replace(
    /[^a-zA-Z0-9@._-]/g,
    "-",
  );
}

function formatViewport(viewport: StorybookViewport): string {
  return `${viewport.label} ${viewport.width}x${viewport.height} @${viewport.devicePixelRatio}x`;
}

function slugify(value: string): string {
  return (
    value
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase() || "story"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
