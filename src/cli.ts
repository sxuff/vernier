#!/usr/bin/env node
import { access, copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser, Page } from "playwright";
import type { BoundingBox, VernierIssue, VernierSession } from "./schema";
import { auditLatestSession } from "./cli/commands/audit";
import { attachToLocalApp, detectLocalApps } from "./cli/commands/attach";
import { cleanSessions } from "./cli/commands/clean";
import { runDoctor } from "./cli/commands/doctor";
import { handleGitHubCommand } from "./cli/commands/github";
import {
  copyIssueCommand,
  listIssuesCommand,
  planIssueCommand,
  sendIssueToAgent,
  showIssueCommand
} from "./cli/commands/handoff";
import { markIssue, updateIssueNote } from "./cli/commands/issues";
import { startMcpServer } from "./cli/commands/mcp";
import {
  isUrlLike,
  listenWithPortFallback,
  openUrl,
  parseProxyOptions,
  parseUrlOption,
  resolveTargetOption,
  startProxyServer
} from "./cli/commands/proxy";
import { startReplayViewer } from "./cli/commands/replay";
import { VernierError } from "./cli/lib/errors";
import { createAgentPrompt, latestSessionMarkdownPath, readLatestSessionMarkdown } from "./core/handoff";
import {
  findLatestIssue,
  type IssueStatus,
  listLatestIssues,
  renderIssueVerification
} from "./core/issues";

interface VernierConfig {
  target?: string;
  port?: number | "auto";
  detectPorts?: number[];
  verification?: {
    bboxTolerancePx?: number;
  };
  agents?: {
    default?: "codex" | "claude";
  };
}

interface CliContext {
  config: VernierConfig;
  verbose: boolean;
}

async function createCliContext(args: string[]): Promise<CliContext> {
  const verbose = args.includes("--verbose") || process.env.VERNIER_DEBUG === "1" || process.env.DEBUG?.split(",").some((value) => value.trim() === "vernier:*") === true;
  const config = await loadConfig(args, verbose);

  return { config, verbose };
}

async function loadConfig(args: string[], verbose: boolean): Promise<VernierConfig> {
  const configPath = await findConfigPath(args);

  if (!configPath) {
    debugLog(verbose, "config", "no config file found");
    return {};
  }

  const loaded = await readConfigFile(configPath);
  const config = validateConfig(loaded, configPath);
  debugLog(verbose, "config", `loaded ${configPath}`);
  return config;
}

async function findConfigPath(args: string[]): Promise<string | null> {
  const explicit = readOption(args, "--config");

  if (explicit) {
    const resolved = path.resolve(process.cwd(), explicit);
    await access(resolved).catch(() => {
      throw new VernierError("VERNIER_CONFIG_NOT_FOUND", `Config file was not found: ${resolved}`, "Check the --config path or create vernier.config.json.");
    });
    return resolved;
  }

  for (const filename of ["vernier.config.json", "vernier.config.mjs", "vernier.config.js", "vernier.config.cjs"]) {
    const candidate = path.join(process.cwd(), filename);

    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next supported config filename.
    }
  }

  return null;
}

async function readConfigFile(configPath: string): Promise<unknown> {
  const extension = path.extname(configPath);

  if (extension === ".json") {
    try {
      return JSON.parse(await readFile(configPath, "utf8"));
    } catch (error) {
      throw new VernierError("VERNIER_INVALID_CONFIG", `Could not parse ${configPath}`, error instanceof Error ? error.message : undefined);
    }
  }

  if (extension === ".cjs") {
    return require(configPath);
  }

  if (extension === ".js" || extension === ".mjs") {
    const module = await import(pathToFileURL(configPath).href);
    return "default" in module ? module.default : module;
  }

  throw new VernierError("VERNIER_UNSUPPORTED_CONFIG", `Unsupported config file extension: ${extension}`, "Use vernier.config.json, .js, .mjs, or .cjs.");
}

function validateConfig(value: unknown, configPath: string): VernierConfig {
  const config = expectOptionalRecord(value, configPath);
  const result: VernierConfig = {};

  if (config.target !== undefined) {
    result.target = expectConfigString(config.target, "target");
    parseUrlOption(result.target, "config target");
  }

  if (config.port !== undefined) {
    result.port = expectConfigPort(config.port, "port");
  }

  if (config.detectPorts !== undefined) {
    result.detectPorts = expectConfigPorts(config.detectPorts, "detectPorts");
  }

  if (config.verification !== undefined) {
    const verification = expectOptionalRecord(config.verification, "verification");
    result.verification = {};

    if (verification.bboxTolerancePx !== undefined) {
      result.verification.bboxTolerancePx = expectConfigNonNegativeNumber(verification.bboxTolerancePx, "verification.bboxTolerancePx");
    }
  }

  if (config.agents !== undefined) {
    const agents = expectOptionalRecord(config.agents, "agents");
    result.agents = {};

    if (agents.default !== undefined) {
      result.agents.default = expectConfigAgent(agents.default, "agents.default");
    }
  }

  return result;
}

function expectOptionalRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new VernierError("VERNIER_INVALID_CONFIG", `${field} must export an object.`);
  }

  return value as Record<string, unknown>;
}

function expectConfigString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new VernierError("VERNIER_INVALID_CONFIG", `Config ${field} must be a non-empty string.`);
  }

  return value;
}

function expectConfigPort(value: unknown, field: string): number | "auto" {
  if (value === "auto") {
    return value;
  }

  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 65535) {
    throw new VernierError("VERNIER_INVALID_CONFIG", `Config ${field} must be a TCP port or "auto".`);
  }

  return value as number;
}

function expectConfigPorts(value: unknown, field: string): number[] {
  if (!Array.isArray(value)) {
    throw new VernierError("VERNIER_INVALID_CONFIG", `Config ${field} must be an array of TCP ports.`);
  }

  return [...new Set(value.map((port, index) => expectConfigPort(port, `${field}[${index}]`)).filter((port): port is number => port !== "auto"))];
}

function expectConfigNonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new VernierError("VERNIER_INVALID_CONFIG", `Config ${field} must be a non-negative number.`);
  }

  return value;
}

function expectConfigAgent(value: unknown, field: string): "codex" | "claude" {
  if (value !== "codex" && value !== "claude") {
    throw new VernierError("VERNIER_INVALID_CONFIG", `Config ${field} must be codex or claude.`);
  }

  return value;
}

function debugLog(enabled: boolean, namespace: string, message: string): void {
  if (enabled) {
    console.error(`[vernier:${namespace}] ${message}`);
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  const context = await createCliContext(process.argv.slice(2));

  if (!command || command === "proxy" || command === "start" || isUrlLike(command) || command.startsWith("--")) {
    const proxyArgs =
      command && command !== "proxy" && command !== "start" ? [command, ...args] : args;
    const options = parseProxyOptions(proxyArgs, context.config);
    await startProxyServer(options, { open: false });
    return;
  }

  if (command === "attach") {
    await attachToLocalApp(args, context.config, { parseProxyOptions, resolveTargetOption, startProxyServer });
    return;
  }

  if (command === "detect") {
    await detectLocalApps(args, context.config, { resolveTargetOption });
    return;
  }

  if (command === "issues") {
    await listIssuesCommand(process.cwd(), args);
    return;
  }

  if (command === "show") {
    await showIssueCommand(process.cwd(), args);
    return;
  }

  if (command === "copy") {
    await copyIssueCommand(process.cwd(), args);
    return;
  }

  if (command === "send") {
    await sendIssueToAgent(process.cwd(), args, context.config);
    return;
  }

  if (command === "mark") {
    await markIssue(process.cwd(), args);
    return;
  }

  if (command === "note") {
    await updateIssueNote(process.cwd(), args);
    return;
  }

  if (command === "plan") {
    await planIssueCommand(process.cwd(), args);
    return;
  }

  if (command === "github") {
    await handleGitHubCommand(process.cwd(), args);
    return;
  }

  if (command === "verify") {
    await verifyIssue(args, context.config);
    return;
  }

  if (command === "capture") {
    console.log(await captureRoutes(args, context.config));
    return;
  }

  if (command === "diff") {
    console.log(await diffArtifacts(args));
    return;
  }

  if (command === "replay") {
    await startReplayViewer(args, { root: process.cwd(), listenWithPortFallback, openUrl });
    return;
  }

  if (command === "doctor") {
    console.log(await runDoctor(process.cwd()));
    return;
  }

  if (command === "clean") {
    console.log(await cleanSessions(process.cwd(), args));
    return;
  }

  if (command === "audit") {
    console.log(await auditLatestSession(process.cwd(), args));
    return;
  }

  if (command === "mcp") {
    await startMcpServer(process.cwd());
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

async function verifyIssue(args: string[], config: VernierConfig): Promise<void> {
  const reference = readRequiredReference(args, "verify");
  const issue = await findLatestIssue(process.cwd(), reference);
  const targetUrl = createIssueTargetUrl(resolveTargetOption(args, config), issue.session.route);

  if (args.includes("--compare")) {
    console.log(await compareIssue(issue, targetUrl, readTolerance(args, config), readCompareViewports(args, issue.session.viewport)));
    return;
  }

  const verification = renderIssueVerification(issue, targetUrl);

  console.log(verification);

  if (args.includes("--open")) {
    await openUrl(targetUrl);
  }
}

async function captureRoutes(args: string[], config: VernierConfig): Promise<string> {
  const target = parseUrlOption(resolveTargetOption(args, config), "target");
  const routes = readCaptureRoutes(args);
  const viewports = readCaptureViewports(args);
  const captureDirectory = path.join(process.cwd(), ".ui-feedback", "captures", new Date().toISOString().replace(/[:.]/g, "-"));
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
            height: viewport.height
          },
          deviceScaleFactor: viewport.devicePixelRatio
        });

        try {
          const url = new URL(route, target).toString();
          const response = await page.goto(url, { waitUntil: "networkidle" });
          const screenshotName = `${slugifyCapturePart(route)}-${viewportArtifactName(viewport)}.png`;
          await page.screenshot({ path: path.join(screenshotsDirectory, screenshotName), fullPage: true });
          records.push({
            route,
            url,
            viewport,
            screenshotName,
            status: response?.status() ?? null,
            title: await page.title()
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
    `Artifacts: ${captureDirectory}`
  ].join("\n");
}

async function diffArtifacts(args: string[]): Promise<string> {
  const [leftReference, rightReference] = readPositionalArgs(args);

  if (!leftReference || !rightReference) {
    throw new VernierError("VERNIER_INVALID_OPTION", "Usage: vernier diff <left-session-or-capture> <right-session-or-capture>", "Use `latest` for the latest feedback session, or pass artifact directories.");
  }

  const left = await readDiffArtifact(leftReference);
  const right = await readDiffArtifact(rightReference);

  if (left.kind !== right.kind) {
    throw new VernierError("VERNIER_INVALID_OPTION", `Cannot diff ${left.kind} against ${right.kind}.`, "Compare two sessions or two captures.");
  }

  return left.kind === "session" && right.kind === "session"
    ? renderSessionDiff(left, right)
    : renderCaptureDiff(left as DiffCaptureArtifact, right as DiffCaptureArtifact);
}

async function compareIssue(
  indexed: Awaited<ReturnType<typeof findLatestIssue>>,
  targetUrl: string,
  tolerancePx: number,
  viewports: CompareViewport[]
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

    if (viewports.length === 1 && viewports[0]!.label === "captured") {
      const { report, artifactDirectory } = await compareIssueAtViewport(browser, indexed, targetUrl, tolerancePx, viewports[0]!, path.join(indexed.sessionDirectory, "verification", indexed.stableId));
      return renderCompareReport(indexed.stableId, targetUrl, artifactDirectory, report);
    }

    const results = [];
    for (const viewport of viewports) {
      const artifactDirectory = path.join(indexed.sessionDirectory, "verification", indexed.stableId, "viewports", viewportArtifactName(viewport));
      results.push(await compareIssueAtViewport(browser, indexed, targetUrl, tolerancePx, viewport, artifactDirectory));
    }

    const summaryDirectory = path.join(indexed.sessionDirectory, "verification", indexed.stableId, "viewports");
    await writeMultiViewportReport(summaryDirectory, indexed.stableId, targetUrl, results);

    return renderMultiViewportCompareReport(indexed.stableId, targetUrl, summaryDirectory, results);
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
  artifactDirectory: string
): Promise<{ viewport: CompareViewport; report: CompareReport; artifactDirectory: string }> {
  const page = await browser.newPage({
    viewport: {
      width: viewport.width,
      height: viewport.height
    },
    deviceScaleFactor: viewport.devicePixelRatio
  });

  try {
    await page.goto(targetUrl, { waitUntil: "networkidle" });
    const report = await remeasureIssue(page, indexed.issue, tolerancePx);
    await writeVerificationArtifacts(artifactDirectory, indexed, report, page, viewport);

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
  differences: Array<{ field: string; original: unknown; current: unknown; delta?: number; withinTolerance?: boolean }>;
  tolerancePx: number;
  suggestedStatus: IssueStatus;
}

interface CompareViewport {
  label: string;
  width: number;
  height: number;
  devicePixelRatio: number;
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
  page: Page,
  viewport?: CompareViewport
): Promise<void> {
  await mkdir(artifactDirectory, { recursive: true });
  await copyFile(indexed.screenshotPath, path.join(artifactDirectory, "before.png"));
  await page.screenshot({ path: path.join(artifactDirectory, "after.png"), fullPage: true });
  const reportWithViewport = viewport ? { viewport, ...report } : report;
  await writeFile(path.join(artifactDirectory, "report.json"), `${JSON.stringify(reportWithViewport, null, 2)}\n`);
  await writeFile(path.join(artifactDirectory, "report.md"), `${renderCompareReport(indexed.stableId, "", artifactDirectory, report, viewport)}\n`);
}

function renderCompareReport(
  issueId: string,
  targetUrl: string,
  artifactDirectory: string,
  report: CompareReport,
  viewport?: CompareViewport
): string {
  return [
    `Issue ${issueId}`,
    targetUrl ? `URL: ${targetUrl}` : null,
    viewport ? `Viewport: ${formatCompareViewport(viewport)}` : null,
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

async function writeMultiViewportReport(
  summaryDirectory: string,
  issueId: string,
  targetUrl: string,
  results: Array<{ viewport: CompareViewport; report: CompareReport; artifactDirectory: string }>
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
      differenceCount: result.report.differences.length
    }))
  };

  await writeFile(path.join(summaryDirectory, "report.json"), `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(path.join(summaryDirectory, "report.md"), `${renderMultiViewportCompareReport(issueId, targetUrl, summaryDirectory, results)}\n`);
}

function renderMultiViewportCompareReport(
  issueId: string,
  targetUrl: string,
  summaryDirectory: string,
  results: Array<{ viewport: CompareViewport; report: CompareReport; artifactDirectory: string }>
): string {
  return [
    `Issue ${issueId}`,
    `URL: ${targetUrl}`,
    `Viewports compared: ${results.length}`,
    `Artifacts: ${summaryDirectory}`,
    "",
    ...results.flatMap((result) => [
      `## ${formatCompareViewport(result.viewport)}`,
      `Selector found: ${result.report.selectorFound ? "yes" : "no"}`,
      result.report.referenceFound === undefined ? null : `Reference found: ${result.report.referenceFound ? "yes" : "no"}`,
      `Suggested status: ${result.report.suggestedStatus}`,
      `Artifacts: ${result.artifactDirectory}`,
      "Differences:",
      ...result.report.differences.map((difference) =>
        `- ${difference.field}: ${String(difference.original)} -> ${String(difference.current)}${typeof difference.delta === "number" ? ` (${formatSignedNumber(difference.delta)})` : ""} ${difference.withinTolerance ? "ok" : "changed"}`
      ),
      ""
    ].filter((line): line is string => line !== null))
  ].join("\n");
}

function readTolerance(args: string[], config: VernierConfig): number {
  const value = readOption(args, "--tolerance") ?? String(config.verification?.bboxTolerancePx ?? 2);
  const tolerance = Number(value);

  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new VernierError("VERNIER_INVALID_OPTION", `Invalid --tolerance value: ${value}`, "Use a non-negative number, for example --tolerance 2.");
  }

  return tolerance;
}

function readCompareViewports(args: string[], captured: VernierSession["viewport"]): CompareViewport[] {
  const value = readOption(args, "--viewports");

  if (!value) {
    return [{
      label: "captured",
      width: captured.width,
      height: captured.height,
      devicePixelRatio: captured.devicePixelRatio
    }];
  }

  const viewports = value.split(",").map((item) => parseCompareViewport(item.trim())).filter((item): item is CompareViewport => item !== null);

  if (viewports.length === 0) {
    throw new VernierError("VERNIER_INVALID_OPTION", `Invalid --viewports value: ${value}`, "Use names like mobile,tablet,desktop or sizes like 390x844,768x1024,1440x900@2.");
  }

  return viewports;
}

function readCaptureViewports(args: string[]): CompareViewport[] {
  const value = readOption(args, "--viewports");

  if (!value) {
    return [parseCompareViewport("desktop")!];
  }

  const viewports = value.split(",").map((item) => parseCompareViewport(item.trim())).filter((item): item is CompareViewport => item !== null);

  if (viewports.length === 0) {
    throw new VernierError("VERNIER_INVALID_OPTION", `Invalid --viewports value: ${value}`, "Use names like mobile,tablet,desktop or sizes like 390x844,768x1024,1440x900@2.");
  }

  return viewports;
}

function readCaptureRoutes(args: string[]): string[] {
  const value = readOption(args, "--routes") ?? readPositionalArgs(args)[0];

  if (!value) {
    throw new VernierError("VERNIER_INVALID_OPTION", "Usage: vernier capture --target <url> --routes /,/pricing [--viewports mobile,desktop]", "Provide a comma-separated --routes list.");
  }

  const routes = value.split(",").map((route) => route.trim()).filter(Boolean);

  if (routes.length === 0) {
    throw new VernierError("VERNIER_INVALID_OPTION", `Invalid --routes value: ${value}`, "Provide at least one route, for example --routes /,/pricing.");
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

  if (!Number.isInteger(width) || !Number.isInteger(height) || !Number.isFinite(devicePixelRatio) || width <= 0 || height <= 0 || devicePixelRatio <= 0) {
    return null;
  }

  return {
    label: value,
    width,
    height,
    devicePixelRatio
  };
}

function viewportArtifactName(viewport: CompareViewport): string {
  return `${viewport.label}-${viewport.width}x${viewport.height}@${viewport.devicePixelRatio}x`.replace(/[^a-zA-Z0-9@._-]/g, "-");
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
  }>
): Promise<void> {
  const report = {
    createdAt: new Date().toISOString(),
    target,
    screenshotCount: records.length,
    records
  };

  await writeFile(path.join(captureDirectory, "capture.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(captureDirectory, "capture.md"), `${[
    "# Vernier Batch Capture",
    "",
    `Target: ${target}`,
    `Screenshot count: ${records.length}`,
    "",
    ...records.map((record) => [
      `## ${record.route} - ${formatCompareViewport(record.viewport)}`,
      `URL: ${record.url}`,
      `Status: ${record.status ?? "unknown"}`,
      `Title: ${record.title || "untitled"}`,
      `Screenshot: ./screenshots/${record.screenshotName}`,
      ""
    ].join("\n"))
  ].join("\n")}\n`);
}

function slugifyCapturePart(value: string): string {
  return value
    .replace(/^https?:\/\//, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase() || "root";
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
  const directory = reference === "latest"
    ? path.join(process.cwd(), ".ui-feedback", "latest")
    : path.resolve(process.cwd(), reference);

  try {
    const session = JSON.parse(await readFile(path.join(directory, "session.json"), "utf8")) as VernierSession;
    return { kind: "session", path: directory, session };
  } catch {
    // Not a feedback session, try batch capture next.
  }

  try {
    const capture = JSON.parse(await readFile(path.join(directory, "capture.json"), "utf8")) as DiffCaptureArtifact["capture"];
    return { kind: "capture", path: directory, capture };
  } catch {
    throw new VernierError("VERNIER_NO_ARTIFACT", `No Vernier session or capture artifact found at ${directory}`, "Pass a directory containing session.json or capture.json.");
  }
}

function renderSessionDiff(left: DiffSessionArtifact, right: DiffSessionArtifact): string {
  const leftIssues = new Map(left.session.issues.map((issue) => [issue.stableId, issue]));
  const rightIssues = new Map(right.session.issues.map((issue) => [issue.stableId, issue]));
  const ids = [...new Set([...leftIssues.keys(), ...rightIssues.keys()])].sort();
  const lines = [
    "Vernier session diff",
    `Left: ${left.path}`,
    `Right: ${right.path}`,
    `Route: ${left.session.route} -> ${right.session.route}`,
    `Viewport: ${left.session.viewport.width}x${left.session.viewport.height} -> ${right.session.viewport.width}x${right.session.viewport.height}`,
    ""
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

function renderCaptureDiff(left: DiffCaptureArtifact, right: DiffCaptureArtifact): string {
  const leftRecords = new Map((left.capture.records ?? []).map((record) => [captureRecordKey(record), record]));
  const rightRecords = new Map((right.capture.records ?? []).map((record) => [captureRecordKey(record), record]));
  const keys = [...new Set([...leftRecords.keys(), ...rightRecords.keys()])].sort();
  const lines = [
    "Vernier capture diff",
    `Left: ${left.path}`,
    `Right: ${right.path}`,
    `Target: ${left.capture.target ?? "unknown"} -> ${right.capture.target ?? "unknown"}`,
    ""
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
    changes.push(`note changed: ${left.note || "(empty)"} -> ${right.note || "(empty)"}`);
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

function captureRecordKey(record: NonNullable<DiffCaptureArtifact["capture"]["records"]>[number]): string {
  return `${record.route} ${formatCompareViewport(record.viewport)}`;
}

function diffCaptureRecordFields(
  left: NonNullable<DiffCaptureArtifact["capture"]["records"]>[number],
  right: NonNullable<DiffCaptureArtifact["capture"]["records"]>[number]
): string[] {
  const changes: string[] = [];

  if (left.status !== right.status) {
    changes.push(`status changed: ${left.status ?? "unknown"} -> ${right.status ?? "unknown"}`);
  }
  if (left.title !== right.title) {
    changes.push(`title changed: ${left.title || "untitled"} -> ${right.title || "untitled"}`);
  }
  if (left.screenshotName !== right.screenshotName) {
    changes.push(`screenshot changed: ${left.screenshotName} -> ${right.screenshotName}`);
  }

  return changes;
}

function roundNumber(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatSignedNumber(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function readOption(args: string[], name: string): string | null {
  const index = args.indexOf(name);

  return index >= 0 ? args[index + 1] ?? null : null;
}

function isIssueStatus(value: string | undefined): value is IssueStatus {
  return value === "todo" || value === "fixed";
}

function readRequiredReference(args: string[], command: string): string {
  const reference = readPositionalArgs(args)[0];

  if (!reference) {
    throw new Error(`Usage: vernier ${command} <issue-id>`);
  }

  return reference;
}

function readPositionalArgs(args: string[]): string[] {
  const positional: string[] = [];
  const optionsWithValues = new Set(["--target", "--port", "--ports", "--to", "--keep", "--older-than", "--tolerance", "--config", "--label", "--template", "--viewports", "--routes"]);

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

function createIssueTargetUrl(target: string, route: string): string {
  return new URL(route || "/", target).toString();
}

function printHelp(): void {
  console.log(
    [
      "Usage:",
      "  vernier [--target http://localhost:5173] [--port 3333|auto] [--config vernier.config.json]",
      "  vernier attach [--target <url>] [--ports 5173,3000,6006] [--open|--no-open]",
      "  vernier start [--target <url>] [--port 3333|auto]",
      "  vernier proxy [--target <url>] [--port 3333|auto]",
      "  vernier http://localhost:5173",
      "  vernier detect [--ports 5173,3000,6006]",
      "  vernier issues [--todo|--fixed|--all]",
      "  vernier show <issue-id>",
      "  vernier copy <issue-id> [--template generic|codex|claude|cursor|aider|strict] [--print]",
      "  vernier note <issue-id> \"updated note\"",
      "  vernier plan <issue-id>",
      "  vernier github body|create [all|<issue-id>] [--label ui-feedback]",
      "  vernier mark <issue-id> todo|fixed",
      "  vernier verify <issue-id> [--target <url>] [--open]",
      "  vernier verify <issue-id> --compare [--target <url>] [--tolerance 2] [--viewports mobile,tablet,desktop|390x844,1440x900]",
      "  vernier capture --target <url> --routes /,/pricing [--viewports mobile,desktop]",
      "  vernier diff <left-session-or-capture> <right-session-or-capture>",
      "  vernier replay latest [--port 3340|auto] [--no-open]",
      "  vernier doctor",
      "  vernier clean [--keep 20] [--older-than 14d] [--dry-run]",
      "  vernier audit a11y|layout [--json]",
      "  vernier mcp",
      "  vernier send [all|<issue-id>] --to codex|claude [--template generic|codex|claude|cursor|aider|strict] [--all] [--print]",
      "  vernier latest",
      "  vernier open",
      "",
      "Config:",
      "  vernier.config.json|js|mjs|cjs can set target, port, detectPorts, verification.bboxTolerancePx, and agents.default.",
      "  Environment defaults: VERNIER_TARGET, VERNIER_PORT, VERNIER_PORTS, VERNIER_AGENT, VERNIER_DEBUG=1.",
      "",
      `Latest session path: ${latestSessionMarkdownPath}`
    ].join("\n")
  );
}

main().catch((error) => {
  if (error instanceof VernierError) {
    console.error(error.code);
    console.error(error.message);
    if (error.hint) {
      console.error(`Hint: ${error.hint}`);
    }
    process.exit(1);
  }

  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
