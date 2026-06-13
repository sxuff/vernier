import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser, Page } from "playwright";
import {
  findLatestIssue,
  type IndexedVernierIssue,
  type IssueStatus,
  renderIssueVerification,
} from "../../core/issues";
import type { BoundingBox, VernierIssue, VernierSession } from "../../schema";
import { parseArgs } from "../lib/args";
import { VernierError } from "../lib/errors";
import { openUrl, parseUrlOption, resolveTargetOption } from "./proxy";

interface VerifyConfig {
  target?: string;
  verification?: {
    bboxTolerancePx?: number;
  };
}

const verifyValueOptions = [
  "--target",
  "--port",
  "--config",
  "--tolerance",
  "--viewports",
  "--routes",
];

export interface CompareIssueResult {
  output: string;
  suggestedStatus: IssueStatus;
  artifactDirectory?: string;
}

export async function verifyIssue(
  args: string[],
  config: VerifyConfig,
): Promise<void> {
  const parsed = parseArgs(args, { valueOptions: verifyValueOptions });
  const reference = readRequiredReference(args, "verify");
  const issue = await findLatestIssue(process.cwd(), reference);
  const targetUrl = createIssueTargetUrl(
    resolveTargetOption(args, config),
    issue.session.route,
  );

  if (parsed.flag("--compare")) {
    console.log(
      (
        await compareLatestIssue(
          issue,
          targetUrl,
          readTolerance(args, config),
          readCompareViewports(args, issue.session.viewport),
        )
      ).output,
    );
    return;
  }

  const verification = renderIssueVerification(issue, targetUrl);

  console.log(verification);

  if (parsed.flag("--open")) {
    await openUrl(targetUrl);
  }
}

export async function captureRoutes(
  args: string[],
  config: VerifyConfig,
): Promise<string> {
  const target = parseUrlOption(resolveTargetOption(args, config), "target");
  const routes = readCaptureRoutes(args);
  const viewports = readCaptureViewports(args);
  const captureDirectory = path.join(
    process.cwd(),
    ".ui-feedback",
    "captures",
    new Date().toISOString().replace(/[:.]/g, "-"),
  );
  const screenshotsDirectory = path.join(captureDirectory, "screenshots");
  const records: Array<{
    route: string;
    url: string;
    viewport: CompareViewport;
    screenshotName: string;
    status: number | null;
    title: string;
  }> = [];
  const { chromium } = await import("playwright");
  let browser: Browser | null = null;

  await mkdir(screenshotsDirectory, { recursive: true });

  try {
    browser = await chromium.launch({ headless: true });

    for (const route of routes) {
      for (const viewport of viewports) {
        const page = await browser.newPage({
          viewport: {
            width: viewport.width,
            height: viewport.height,
          },
          deviceScaleFactor: viewport.devicePixelRatio,
        });

        try {
          const url = new URL(route, target).toString();
          const response = await page.goto(url, { waitUntil: "networkidle" });
          const screenshotName = `${slugifyCapturePart(route)}-${viewportArtifactName(viewport)}.png`;
          await page.screenshot({
            path: path.join(screenshotsDirectory, screenshotName),
            fullPage: true,
          });
          records.push({
            route,
            url,
            viewport,
            screenshotName,
            status: response?.status() ?? null,
            title: await page.title(),
          });
        } finally {
          await page.close();
        }
      }
    }
  } finally {
    await browser?.close();
  }

  await writeCaptureReport(captureDirectory, target.toString(), records);

  return [
    `Captured ${records.length} screenshot${records.length === 1 ? "" : "s"}.`,
    `Target: ${target.toString()}`,
    `Routes: ${routes.join(", ")}`,
    `Viewports: ${viewports.map(formatCompareViewport).join(", ")}`,
    `Artifacts: ${captureDirectory}`,
  ].join("\n");
}

export async function diffArtifacts(args: string[]): Promise<string> {
  const [leftReference, rightReference] = parseArgs(args).positionals();

  if (!leftReference || !rightReference) {
    throw new VernierError(
      "VERNIER_INVALID_OPTION",
      "Usage: vernier diff <left-session-or-capture> <right-session-or-capture>",
      "Use `latest` for the latest feedback session, or pass artifact directories.",
    );
  }

  const left = await readDiffArtifact(leftReference);
  const right = await readDiffArtifact(rightReference);

  if (left.kind !== right.kind) {
    throw new VernierError(
      "VERNIER_INVALID_OPTION",
      `Cannot diff ${left.kind} against ${right.kind}.`,
      "Compare two sessions or two captures.",
    );
  }

  return left.kind === "session" && right.kind === "session"
    ? renderSessionDiff(left, right)
    : renderCaptureDiff(
        left as DiffCaptureArtifact,
        right as DiffCaptureArtifact,
      );
}

export async function compareLatestIssue(
  indexed: IndexedVernierIssue,
  targetUrl: string,
  tolerancePx: number,
  viewports: CompareViewport[],
): Promise<CompareIssueResult> {
  if (
    !indexed.issue.measurement ||
    indexed.issue.measurement.kind === "annotation"
  ) {
    return {
      suggestedStatus: "todo",
      output: [
        renderIssueVerification(indexed, targetUrl),
        "",
        "Compare result:",
        "Structured element measurement is required for automatic comparison.",
      ].join("\n"),
    };
  }

  const { chromium } = await import("playwright");
  let browser: Browser | null = null;

  try {
    browser = await chromium.launch({ headless: true });

    if (viewports.length === 1 && viewports[0]!.label === "captured") {
      const { report, artifactDirectory } = await compareIssueAtViewport(
        browser,
        indexed,
        targetUrl,
        tolerancePx,
        viewports[0]!,
        path.join(indexed.sessionDirectory, "verification", indexed.stableId),
      );
      return {
        output: renderCompareReport(
          indexed.stableId,
          targetUrl,
          artifactDirectory,
          report,
        ),
        suggestedStatus: report.suggestedStatus,
        artifactDirectory,
      };
    }

    const results = [];
    for (const viewport of viewports) {
      const artifactDirectory = path.join(
        indexed.sessionDirectory,
        "verification",
        indexed.stableId,
        "viewports",
        viewportArtifactName(viewport),
      );
      results.push(
        await compareIssueAtViewport(
          browser,
          indexed,
          targetUrl,
          tolerancePx,
          viewport,
          artifactDirectory,
        ),
      );
    }

    const summaryDirectory = path.join(
      indexed.sessionDirectory,
      "verification",
      indexed.stableId,
      "viewports",
    );
    await writeMultiViewportReport(
      summaryDirectory,
      indexed.stableId,
      targetUrl,
      results,
    );

    return {
      output: renderMultiViewportCompareReport(
        indexed.stableId,
        targetUrl,
        summaryDirectory,
        results,
      ),
      suggestedStatus: results.every(
        (result) => result.report.suggestedStatus === "fixed",
      )
        ? "fixed"
        : "todo",
      artifactDirectory: summaryDirectory,
    };
  } finally {
    await browser?.close();
  }
}

async function compareIssueAtViewport(
  browser: Browser,
  indexed: Awaited<ReturnType<typeof findLatestIssue>>,
  targetUrl: string,
  tolerancePx: number,
  viewport: CompareViewport,
  artifactDirectory: string,
): Promise<{
  viewport: CompareViewport;
  report: CompareReport;
  artifactDirectory: string;
}> {
  const page = await browser.newPage({
    viewport: {
      width: viewport.width,
      height: viewport.height,
    },
    deviceScaleFactor: viewport.devicePixelRatio,
  });

  try {
    await page.goto(targetUrl, { waitUntil: "networkidle" });
    const report = await remeasureIssue(page, indexed.issue, tolerancePx);
    await writeVerificationArtifacts(
      artifactDirectory,
      indexed,
      report,
      page,
      viewport,
    );

    return { viewport, report, artifactDirectory };
  } finally {
    await page.close();
  }
}

interface CompareReport {
  selectorFound: boolean;
  referenceFound?: boolean;
  original?: Record<string, unknown>;
  current?: Record<string, unknown>;
  differences: Array<{
    field: string;
    original: unknown;
    current: unknown;
    delta?: number;
    withinTolerance?: boolean;
  }>;
  tolerancePx: number;
  suggestedStatus: IssueStatus;
}

export interface CompareViewport {
  label: string;
  width: number;
  height: number;
  devicePixelRatio: number;
}

async function remeasureIssue(
  page: Page,
  issue: VernierIssue,
  tolerancePx: number,
): Promise<CompareReport> {
  const measurement = issue.measurement;

  if (!measurement || measurement.kind === "annotation") {
    throw new VernierError(
      "VERNIER_UNSUPPORTED_ISSUE",
      "Cannot compare an issue without element measurement data.",
      "Annotation-only issues can be reviewed manually with `vernier show <issue-id>`.",
    );
  }

  const selector =
    measurement.kind === "delta" ? measurement.target.selector : issue.selector;
  const current = await measureSelectorOnPage(page, selector);

  if (!current) {
    return {
      selectorFound: false,
      differences: [
        { field: "selector", original: selector, current: "not found" },
      ],
      tolerancePx,
      suggestedStatus: "todo",
    };
  }

  if (measurement.kind === "single") {
    const differences = compareBoundingBoxes(
      measurement.bbox,
      current.bbox,
      tolerancePx,
    );
    compareStyleValue(
      differences,
      "color",
      measurement.computedStyle.color,
      current.computedStyle.color,
    );
    compareStyleValue(
      differences,
      "background-color",
      measurement.computedStyle["background-color"],
      current.computedStyle["background-color"],
    );
    compareStyleValue(
      differences,
      "font-size",
      measurement.computedStyle["font-size"],
      current.computedStyle["font-size"],
    );

    return {
      selectorFound: true,
      original: {
        bbox: measurement.bbox,
        computedStyle: measurement.computedStyle,
      },
      current,
      differences,
      tolerancePx,
      suggestedStatus: hasMeaningfulChange(differences) ? "fixed" : "todo",
    };
  }

  const currentReference = await measureSelectorOnPage(
    page,
    measurement.reference.selector,
  );

  if (!currentReference) {
    return {
      selectorFound: true,
      referenceFound: false,
      current,
      differences: [
        {
          field: "reference",
          original: measurement.reference.selector,
          current: "not found",
        },
      ],
      tolerancePx,
      suggestedStatus: "todo",
    };
  }

  const currentDelta = {
    left: roundNumber(current.bbox.left - currentReference.bbox.left),
    top: roundNumber(current.bbox.top - currentReference.bbox.top),
    width: roundNumber(current.bbox.width - currentReference.bbox.width),
    height: roundNumber(current.bbox.height - currentReference.bbox.height),
  };
  const differences = compareNumericRecord(
    measurement.delta,
    currentDelta,
    tolerancePx,
    ["left", "top", "width", "height"],
  );

  compareStyleValue(
    differences,
    "color",
    measurement.delta.color?.[1],
    current.computedStyle.color,
  );
  compareStyleValue(
    differences,
    "background-color",
    measurement.delta.backgroundColor?.[1],
    current.computedStyle["background-color"],
  );
  compareStyleValue(
    differences,
    "font-size",
    measurement.delta.fontSize?.[1],
    current.computedStyle["font-size"],
  );

  return {
    selectorFound: true,
    referenceFound: true,
    original: {
      delta: measurement.delta,
      targetBbox: measurement.targetBbox,
      referenceBbox: measurement.referenceBbox,
    },
    current: {
      delta: currentDelta,
      target: current,
      reference: currentReference,
    },
    differences,
    tolerancePx,
    suggestedStatus: hasMeaningfulChange(differences) ? "fixed" : "todo",
  };
}

async function measureSelectorOnPage(
  page: Page,
  selector: string,
): Promise<{
  bbox: BoundingBox;
  computedStyle: Record<string, string>;
} | null> {
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
        left: round(rect.left),
      },
      computedStyle: {
        color: styles.color,
        "background-color": styles.backgroundColor,
        "font-size": styles.fontSize,
        padding: styles.padding,
        margin: styles.margin,
        width: styles.width,
        height: styles.height,
        "border-radius": styles.borderRadius,
      },
    };
  }, selector);
}

function compareBoundingBoxes(
  original: BoundingBox,
  current: BoundingBox,
  tolerancePx: number,
): CompareReport["differences"] {
  return compareNumericRecord(original, current, tolerancePx, [
    "x",
    "y",
    "width",
    "height",
    "top",
    "right",
    "bottom",
    "left",
  ]);
}

function compareNumericRecord(
  original: object,
  current: object,
  tolerancePx: number,
  fields: string[],
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
      withinTolerance: Math.abs(delta) <= tolerancePx,
    };
  });
}

function compareStyleValue(
  differences: CompareReport["differences"],
  field: string,
  original: string | undefined,
  current: string | undefined,
): void {
  if (original === undefined || current === undefined) {
    return;
  }

  differences.push({
    field,
    original,
    current,
    withinTolerance: original === current,
  });
}

function hasMeaningfulChange(
  differences: CompareReport["differences"],
): boolean {
  return differences.some((difference) => difference.withinTolerance === false);
}

async function writeVerificationArtifacts(
  artifactDirectory: string,
  indexed: Awaited<ReturnType<typeof findLatestIssue>>,
  report: CompareReport,
  page: Page,
  viewport?: CompareViewport,
): Promise<void> {
  await mkdir(artifactDirectory, { recursive: true });
  const beforePath = path.join(artifactDirectory, "before.png");
  const afterPath = path.join(artifactDirectory, "after.png");
  const diffPath = path.join(artifactDirectory, "diff.png");
  const artifacts = {
    before: "before.png",
    after: "after.png",
    diff: "diff.png",
  };

  await copyFile(indexed.screenshotPath, beforePath);
  await page.screenshot({ path: afterPath, fullPage: true });
  await writeDiffOverviewImage(
    page,
    beforePath,
    afterPath,
    diffPath,
    indexed,
    report,
    viewport,
  );

  const reportWithViewport = viewport
    ? { viewport, artifacts, ...report }
    : { artifacts, ...report };
  await writeFile(
    path.join(artifactDirectory, "report.json"),
    `${JSON.stringify(reportWithViewport, null, 2)}\n`,
  );
  await writeFile(
    path.join(artifactDirectory, "report.md"),
    `${renderCompareReport(indexed.stableId, "", artifactDirectory, report, viewport, artifacts)}\n`,
  );
}

async function writeDiffOverviewImage(
  page: Page,
  beforePath: string,
  afterPath: string,
  diffPath: string,
  indexed: IndexedVernierIssue,
  report: CompareReport,
  viewport?: CompareViewport,
): Promise<void> {
  await page.setViewportSize({ width: 1100, height: 760 });
  const rows =
    report.differences.length === 0
      ? '<tr><td colspan="4">No measured differences.</td></tr>'
      : report.differences
          .map((difference) =>
            [
              "<tr>",
              `<td>${escapeHtml(difference.field)}</td>`,
              `<td>${escapeHtml(String(difference.original))}</td>`,
              `<td>${escapeHtml(String(difference.current))}</td>`,
              `<td>${escapeHtml(difference.withinTolerance ? "ok" : "changed")}</td>`,
              "</tr>",
            ].join(""),
          )
          .join("");
  await page.setContent(
    [
      "<!doctype html>",
      "<html>",
      "<head>",
      '<meta charset="utf-8" />',
      "<style>",
      "body { margin: 0; padding: 28px; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f6f8fa; color: #101828; }",
      "header { display: flex; align-items: baseline; justify-content: space-between; gap: 24px; margin-bottom: 20px; }",
      "h1 { font-size: 24px; margin: 0; }",
      ".meta { font-size: 13px; color: #475467; }",
      ".grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }",
      ".panel { background: white; border: 1px solid #d0d7de; border-radius: 8px; padding: 12px; min-height: 260px; }",
      ".label { font-size: 13px; font-weight: 700; margin-bottom: 10px; }",
      "img { display: block; max-width: 100%; max-height: 360px; object-fit: contain; background: #fff; border: 1px solid #eaecf0; }",
      "table { width: 100%; border-collapse: collapse; margin-top: 18px; background: #fff; border: 1px solid #d0d7de; border-radius: 8px; overflow: hidden; font-size: 13px; }",
      "th, td { padding: 8px 10px; border-bottom: 1px solid #eaecf0; text-align: left; vertical-align: top; }",
      "th { background: #f2f4f7; font-weight: 700; }",
      "tr:last-child td { border-bottom: 0; }",
      "</style>",
      "</head>",
      "<body>",
      "<header>",
      `<h1>Vernier verification diff - ${escapeHtml(indexed.stableId)}</h1>`,
      `<div class="meta">${escapeHtml(viewport ? formatCompareViewport(viewport) : "captured viewport")} · suggested ${escapeHtml(report.suggestedStatus)}</div>`,
      "</header>",
      '<section class="grid">',
      '<div class="panel">',
      '<div class="label">Before</div>',
      `<img src="${pathToFileURL(beforePath).href}" alt="Before screenshot" />`,
      "</div>",
      '<div class="panel">',
      '<div class="label">After</div>',
      `<img src="${pathToFileURL(afterPath).href}" alt="After screenshot" />`,
      "</div>",
      "</section>",
      "<table>",
      "<thead><tr><th>Field</th><th>Original</th><th>Current</th><th>Status</th></tr></thead>",
      `<tbody>${rows}</tbody>`,
      "</table>",
      "</body>",
      "</html>",
    ].join(""),
  );
  await page.screenshot({ path: diffPath, fullPage: true });
}

function renderCompareReport(
  issueId: string,
  targetUrl: string,
  artifactDirectory: string,
  report: CompareReport,
  viewport?: CompareViewport,
  artifacts?: { before: string; after: string; diff: string },
): string {
  return [
    `Issue ${issueId}`,
    targetUrl ? `URL: ${targetUrl}` : null,
    viewport ? `Viewport: ${formatCompareViewport(viewport)}` : null,
    `Selector found: ${report.selectorFound ? "yes" : "no"}`,
    report.referenceFound === undefined
      ? null
      : `Reference found: ${report.referenceFound ? "yes" : "no"}`,
    `Tolerance: ${report.tolerancePx}px`,
    `Suggested status: ${report.suggestedStatus}`,
    `Artifacts: ${artifactDirectory}`,
    artifacts ? `Before: ${artifacts.before}` : null,
    artifacts ? `After: ${artifacts.after}` : null,
    artifacts ? `Diff: ${artifacts.diff}` : null,
    "",
    "Differences:",
    ...report.differences.map(
      (difference) =>
        `- ${difference.field}: ${String(difference.original)} -> ${String(difference.current)}${typeof difference.delta === "number" ? ` (${formatSignedNumber(difference.delta)})` : ""} ${difference.withinTolerance ? "ok" : "changed"}`,
    ),
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

async function writeMultiViewportReport(
  summaryDirectory: string,
  issueId: string,
  targetUrl: string,
  results: Array<{
    viewport: CompareViewport;
    report: CompareReport;
    artifactDirectory: string;
  }>,
): Promise<void> {
  await mkdir(summaryDirectory, { recursive: true });
  const summary = {
    issueId,
    targetUrl,
    comparedAt: new Date().toISOString(),
    viewports: results.map((result) => ({
      viewport: result.viewport,
      artifactDirectory: result.artifactDirectory,
      selectorFound: result.report.selectorFound,
      suggestedStatus: result.report.suggestedStatus,
      differenceCount: result.report.differences.length,
    })),
  };

  await writeFile(
    path.join(summaryDirectory, "report.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  await writeFile(
    path.join(summaryDirectory, "report.md"),
    `${renderMultiViewportCompareReport(issueId, targetUrl, summaryDirectory, results)}\n`,
  );
}

function renderMultiViewportCompareReport(
  issueId: string,
  targetUrl: string,
  summaryDirectory: string,
  results: Array<{
    viewport: CompareViewport;
    report: CompareReport;
    artifactDirectory: string;
  }>,
): string {
  return [
    `Issue ${issueId}`,
    `URL: ${targetUrl}`,
    `Viewports compared: ${results.length}`,
    `Artifacts: ${summaryDirectory}`,
    "",
    ...results.flatMap((result) =>
      [
        `## ${formatCompareViewport(result.viewport)}`,
        `Selector found: ${result.report.selectorFound ? "yes" : "no"}`,
        result.report.referenceFound === undefined
          ? null
          : `Reference found: ${result.report.referenceFound ? "yes" : "no"}`,
        `Suggested status: ${result.report.suggestedStatus}`,
        `Artifacts: ${result.artifactDirectory}`,
        "Differences:",
        ...result.report.differences.map(
          (difference) =>
            `- ${difference.field}: ${String(difference.original)} -> ${String(difference.current)}${typeof difference.delta === "number" ? ` (${formatSignedNumber(difference.delta)})` : ""} ${difference.withinTolerance ? "ok" : "changed"}`,
        ),
        "",
      ].filter((line): line is string => line !== null),
    ),
  ].join("\n");
}

function readTolerance(args: string[], config: VerifyConfig): number {
  const value =
    parseArgs(args, { valueOptions: verifyValueOptions }).option(
      "--tolerance",
    ) ?? String(config.verification?.bboxTolerancePx ?? 2);
  const tolerance = Number(value);

  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new VernierError(
      "VERNIER_INVALID_OPTION",
      `Invalid --tolerance value: ${value}`,
      "Use a non-negative number, for example --tolerance 2.",
    );
  }

  return tolerance;
}

function readCompareViewports(
  args: string[],
  captured: VernierSession["viewport"],
): CompareViewport[] {
  const value = parseArgs(args, { valueOptions: verifyValueOptions }).option(
    "--viewports",
  );

  if (!value) {
    return [
      {
        label: "captured",
        width: captured.width,
        height: captured.height,
        devicePixelRatio: captured.devicePixelRatio,
      },
    ];
  }

  const viewports = value
    .split(",")
    .map((item) => parseCompareViewport(item.trim()))
    .filter((item): item is CompareViewport => item !== null);

  if (viewports.length === 0) {
    throw new VernierError(
      "VERNIER_INVALID_OPTION",
      `Invalid --viewports value: ${value}`,
      "Use names like mobile,tablet,desktop or sizes like 390x844,768x1024,1440x900@2.",
    );
  }

  return viewports;
}

function readCaptureViewports(args: string[]): CompareViewport[] {
  const value = parseArgs(args, { valueOptions: verifyValueOptions }).option(
    "--viewports",
  );

  if (!value) {
    return [parseCompareViewport("desktop")!];
  }

  const viewports = value
    .split(",")
    .map((item) => parseCompareViewport(item.trim()))
    .filter((item): item is CompareViewport => item !== null);

  if (viewports.length === 0) {
    throw new VernierError(
      "VERNIER_INVALID_OPTION",
      `Invalid --viewports value: ${value}`,
      "Use names like mobile,tablet,desktop or sizes like 390x844,768x1024,1440x900@2.",
    );
  }

  return viewports;
}

function readCaptureRoutes(args: string[]): string[] {
  const parsed = parseArgs(args, { valueOptions: verifyValueOptions });
  const value = parsed.option("--routes") ?? parsed.positionals()[0];

  if (!value) {
    throw new VernierError(
      "VERNIER_INVALID_OPTION",
      "Usage: vernier capture --target <url> --routes /,/pricing [--viewports mobile,desktop]",
      "Provide a comma-separated --routes list.",
    );
  }

  const routes = value
    .split(",")
    .map((route) => route.trim())
    .filter(Boolean);

  if (routes.length === 0) {
    throw new VernierError(
      "VERNIER_INVALID_OPTION",
      `Invalid --routes value: ${value}`,
      "Provide at least one route, for example --routes /,/pricing.",
    );
  }

  return routes;
}

function parseCompareViewport(value: string): CompareViewport | null {
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

  return {
    label: value,
    width,
    height,
    devicePixelRatio,
  };
}

function viewportArtifactName(viewport: CompareViewport): string {
  return `${viewport.label}-${viewport.width}x${viewport.height}@${viewport.devicePixelRatio}x`.replace(
    /[^a-zA-Z0-9@._-]/g,
    "-",
  );
}

function formatCompareViewport(viewport: CompareViewport): string {
  return `${viewport.label} ${viewport.width}x${viewport.height} @${viewport.devicePixelRatio}x`;
}

async function writeCaptureReport(
  captureDirectory: string,
  target: string,
  records: Array<{
    route: string;
    url: string;
    viewport: CompareViewport;
    screenshotName: string;
    status: number | null;
    title: string;
  }>,
): Promise<void> {
  const report = {
    createdAt: new Date().toISOString(),
    target,
    screenshotCount: records.length,
    records,
  };

  await writeFile(
    path.join(captureDirectory, "capture.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await writeFile(
    path.join(captureDirectory, "capture.md"),
    `${[
      "# Vernier Batch Capture",
      "",
      `Target: ${target}`,
      `Screenshot count: ${records.length}`,
      "",
      ...records.map((record) =>
        [
          `## ${record.route} - ${formatCompareViewport(record.viewport)}`,
          `URL: ${record.url}`,
          `Status: ${record.status ?? "unknown"}`,
          `Title: ${record.title || "untitled"}`,
          `Screenshot: ./screenshots/${record.screenshotName}`,
          "",
        ].join("\n"),
      ),
    ].join("\n")}\n`,
  );
}

function slugifyCapturePart(value: string): string {
  return (
    value
      .replace(/^https?:\/\//, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase() || "root"
  );
}

type DiffArtifact = DiffSessionArtifact | DiffCaptureArtifact;

interface DiffSessionArtifact {
  kind: "session";
  path: string;
  session: VernierSession;
}

interface DiffCaptureArtifact {
  kind: "capture";
  path: string;
  capture: {
    createdAt?: string;
    target?: string;
    screenshotCount?: number;
    records?: Array<{
      route: string;
      url: string;
      viewport: CompareViewport;
      screenshotName: string;
      status: number | null;
      title: string;
    }>;
  };
}

async function readDiffArtifact(reference: string): Promise<DiffArtifact> {
  const directory =
    reference === "latest"
      ? path.join(process.cwd(), ".ui-feedback", "latest")
      : path.resolve(process.cwd(), reference);

  try {
    const session = JSON.parse(
      await readFile(path.join(directory, "session.json"), "utf8"),
    ) as VernierSession;
    return { kind: "session", path: directory, session };
  } catch {
    // Not a feedback session, try batch capture next.
  }

  try {
    const capture = JSON.parse(
      await readFile(path.join(directory, "capture.json"), "utf8"),
    ) as DiffCaptureArtifact["capture"];
    return { kind: "capture", path: directory, capture };
  } catch {
    throw new VernierError(
      "VERNIER_NO_ARTIFACT",
      `No Vernier session or capture artifact found at ${directory}`,
      "Pass a directory containing session.json or capture.json.",
    );
  }
}

function renderSessionDiff(
  left: DiffSessionArtifact,
  right: DiffSessionArtifact,
): string {
  const leftIssues = new Map(
    left.session.issues.map((issue) => [issue.stableId, issue]),
  );
  const rightIssues = new Map(
    right.session.issues.map((issue) => [issue.stableId, issue]),
  );
  const ids = [
    ...new Set([...leftIssues.keys(), ...rightIssues.keys()]),
  ].sort();
  const lines = [
    "Vernier session diff",
    `Left: ${left.path}`,
    `Right: ${right.path}`,
    `Route: ${left.session.route} -> ${right.session.route}`,
    `Viewport: ${left.session.viewport.width}x${left.session.viewport.height} -> ${right.session.viewport.width}x${right.session.viewport.height}`,
    "",
  ];
  let differenceCount = 0;

  for (const id of ids) {
    const before = leftIssues.get(id);
    const after = rightIssues.get(id);

    if (!before) {
      differenceCount += 1;
      lines.push(`+ ${id}: added ${summarizeDiffIssue(after!)}`);
      continue;
    }

    if (!after) {
      differenceCount += 1;
      lines.push(`- ${id}: removed ${summarizeDiffIssue(before)}`);
      continue;
    }

    const changes = diffIssueFields(before, after);

    if (changes.length > 0) {
      differenceCount += changes.length;
      lines.push(`~ ${id}: ${changes.join("; ")}`);
    }
  }

  if (differenceCount === 0) {
    lines.push("No differences.");
  }

  return lines.join("\n");
}

function renderCaptureDiff(
  left: DiffCaptureArtifact,
  right: DiffCaptureArtifact,
): string {
  const leftRecords = new Map(
    (left.capture.records ?? []).map((record) => [
      captureRecordKey(record),
      record,
    ]),
  );
  const rightRecords = new Map(
    (right.capture.records ?? []).map((record) => [
      captureRecordKey(record),
      record,
    ]),
  );
  const keys = [
    ...new Set([...leftRecords.keys(), ...rightRecords.keys()]),
  ].sort();
  const lines = [
    "Vernier capture diff",
    `Left: ${left.path}`,
    `Right: ${right.path}`,
    `Target: ${left.capture.target ?? "unknown"} -> ${right.capture.target ?? "unknown"}`,
    "",
  ];
  let differenceCount = 0;

  for (const key of keys) {
    const before = leftRecords.get(key);
    const after = rightRecords.get(key);

    if (!before) {
      differenceCount += 1;
      lines.push(`+ ${key}: added screenshot ${after!.screenshotName}`);
      continue;
    }

    if (!after) {
      differenceCount += 1;
      lines.push(`- ${key}: removed screenshot ${before.screenshotName}`);
      continue;
    }

    const changes = diffCaptureRecordFields(before, after);

    if (changes.length > 0) {
      differenceCount += changes.length;
      lines.push(`~ ${key}: ${changes.join("; ")}`);
    }
  }

  if (differenceCount === 0) {
    lines.push("No differences.");
  }

  return lines.join("\n");
}

function summarizeDiffIssue(issue: VernierIssue): string {
  return `${issue.kind} ${issue.note || issue.selector}`;
}

function diffIssueFields(left: VernierIssue, right: VernierIssue): string[] {
  const changes: string[] = [];

  if (left.note !== right.note) {
    changes.push(
      `note changed: ${left.note || "(empty)"} -> ${right.note || "(empty)"}`,
    );
  }
  if (left.selector !== right.selector) {
    changes.push(`selector changed: ${left.selector} -> ${right.selector}`);
  }
  if (left.source !== right.source) {
    changes.push(`source changed: ${left.source} -> ${right.source}`);
  }
  if (left.kind !== right.kind) {
    changes.push(`kind changed: ${left.kind} -> ${right.kind}`);
  }
  if (left.screenshot?.hash !== right.screenshot?.hash) {
    changes.push("screenshot hash changed");
  }
  if (JSON.stringify(left.measurement) !== JSON.stringify(right.measurement)) {
    changes.push("measurement changed");
  }

  return changes;
}

function captureRecordKey(
  record: NonNullable<DiffCaptureArtifact["capture"]["records"]>[number],
): string {
  return `${record.route} ${formatCompareViewport(record.viewport)}`;
}

function diffCaptureRecordFields(
  left: NonNullable<DiffCaptureArtifact["capture"]["records"]>[number],
  right: NonNullable<DiffCaptureArtifact["capture"]["records"]>[number],
): string[] {
  const changes: string[] = [];

  if (left.status !== right.status) {
    changes.push(
      `status changed: ${left.status ?? "unknown"} -> ${right.status ?? "unknown"}`,
    );
  }
  if (left.title !== right.title) {
    changes.push(
      `title changed: ${left.title || "untitled"} -> ${right.title || "untitled"}`,
    );
  }
  if (left.screenshotName !== right.screenshotName) {
    changes.push(
      `screenshot changed: ${left.screenshotName} -> ${right.screenshotName}`,
    );
  }

  return changes;
}

function roundNumber(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatSignedNumber(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function readRequiredReference(args: string[], command: string): string {
  const reference = parseArgs(args, {
    valueOptions: verifyValueOptions,
  }).positionals()[0];

  if (!reference) {
    throw new VernierError(
      "VERNIER_INVALID_OPTION",
      `Usage: vernier ${command} <issue-id>`,
      "Use `vernier issues` to find an issue id.",
    );
  }

  return reference;
}

export function createIssueTargetUrl(target: string, route: string): string {
  return new URL(route || "/", target).toString();
}
