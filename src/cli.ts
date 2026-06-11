#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { connect as connectNet } from "node:net";
import { spawn } from "node:child_process";
import { Duplex, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { connect as connectTls } from "node:tls";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import type { Browser, Page } from "playwright";
import type { BoundingBox, LayoutContext, VernierIssue, VernierMeasurement, VernierSession } from "./schema";
import { createAgentPrompt, latestSessionMarkdownPath, readLatestSessionMarkdown } from "./core/handoff";
import { injectVernierOverlay } from "./core/html";
import {
  filterIssuesByStatus,
  findLatestIssue,
  type AgentTemplate,
  type IssueStatus,
  listLatestIssues,
  markLatestIssue,
  renderIssueDetail,
  renderGitHubIssueBody,
  renderGitHubIssueTitle,
  renderIssueList,
  renderIssuePlan,
  renderIssueTask,
  renderIssueVerification,
  renderIssuesTask,
  updateLatestIssueNote
} from "./core/issues";
import {
  createVernierOverlayScript,
  vernierHtml2CanvasPath,
  vernierOverlayPath
} from "./core/overlay-script";
import { handleVernierSessionRequest } from "./core/session-handler";

interface ProxyOptions {
  target: URL;
  port: number | "auto";
  root: string;
}

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

interface DetectedApp {
  url: string;
  label: string;
  status: number;
}

const require = createRequire(import.meta.url);
const defaultTarget = "http://localhost:5173";
const defaultPort = 3333;
const defaultDetectPorts = [5173, 3000, 3001, 4173, 4200, 4321, 5000, 5174, 6006, 8000, 8080];
const maxProxyBodyBytes = 30 * 1024 * 1024;
const maxPortFallbackAttempts = 20;

class VernierError extends Error {
  constructor(
    public code: string,
    message: string,
    public hint?: string
  ) {
    super(message);
  }
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
    await attachToLocalApp(args, context.config);
    return;
  }

  if (command === "detect") {
    await detectLocalApps(args, context.config);
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
    const task = renderIssueTask(await findLatestIssue(process.cwd(), readRequiredReference(args, "copy")), readAgentTemplate(args));

    if (args.includes("--print")) {
      console.log(task);
      return;
    }

    await copyToClipboard(task);
    console.log("Copied Vernier issue task to clipboard.");
    return;
  }

  if (command === "send") {
    await sendIssueToAgent(args, context.config);
    return;
  }

  if (command === "mark") {
    await markIssue(args);
    return;
  }

  if (command === "note") {
    await updateIssueNote(args);
    return;
  }

  if (command === "plan") {
    console.log(renderIssuePlan(await findLatestIssue(process.cwd(), readRequiredReference(args, "plan"))));
    return;
  }

  if (command === "github") {
    await handleGitHubCommand(args);
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

  if (command === "replay") {
    await startReplayViewer(args);
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

async function startReplayViewer(args: string[]): Promise<void> {
  const reference = readPositionalArgs(args)[0];

  if (reference && reference !== "latest") {
    throw new Error("Usage: vernier replay latest [--port 3340|auto] [--no-open]");
  }

  const requestedPort = parsePortOption(args, 3340);
  const server = createServer((request, response) => {
    void handleReplayRequest(process.cwd(), request, response);
  });
  const port = await listenWithPortFallback(server, requestedPort === "auto" ? 3340 : requestedPort);
  const url = `http://127.0.0.1:${port}`;

  console.log(`[vernier] replay viewer listening on ${url}`);

  if (!args.includes("--no-open")) {
    await openUrl(url);
  }
}

async function runDoctor(root: string): Promise<string> {
  const gitignorePath = path.join(root, ".gitignore");
  const lines = ["Vernier doctor", ""];
  let gitignore = "";

  try {
    gitignore = await readFile(gitignorePath, "utf8");
  } catch {
    lines.push("Warning: .gitignore was not found.");
    lines.push("Hint: add .ui-feedback/ so captured screenshots are not committed.");
  }

  if (gitignore) {
    if (gitignoreIgnoresFeedback(gitignore)) {
      lines.push("OK: .ui-feedback is ignored by .gitignore.");
    } else {
      lines.push("Warning: .ui-feedback is not ignored by .gitignore.");
      lines.push("Hint: add .ui-feedback/ so captured screenshots are not committed.");
    }
  }

  const feedbackDirectory = path.join(root, ".ui-feedback");
  try {
    await access(feedbackDirectory);
    lines.push(`OK: feedback directory exists at ${feedbackDirectory}`);
  } catch {
    lines.push("OK: no .ui-feedback directory yet.");
  }

  lines.push("OK: Vernier captures are local files; no network uploads are performed by Vernier.");

  return lines.join("\n");
}

async function cleanSessions(root: string, args: string[]): Promise<string> {
  const options = parseCleanOptions(args);
  const sessionsDirectory = path.join(root, ".ui-feedback", "sessions");
  const safeSessionsDirectory = path.resolve(sessionsDirectory);
  const entries = await readSessionDirectories(sessionsDirectory);
  const olderThanCutoff = options.olderThanMs === null ? null : Date.now() - options.olderThanMs;
  const byKeep = entries.slice(options.keep);
  const byAge = olderThanCutoff === null ? [] : entries.filter((entry) => entry.mtimeMs < olderThanCutoff);
  const targets = uniqueSessionDirectories([...byKeep, ...byAge]);

  if (targets.length === 0) {
    return "No Vernier sessions to clean.";
  }

  if (!options.dryRun) {
    for (const target of targets) {
      const resolved = path.resolve(target.path);

      if (!resolved.startsWith(`${safeSessionsDirectory}${path.sep}`)) {
        throw new Error(`Refusing to remove unsafe path: ${target.path}`);
      }

      await rm(resolved, { recursive: true, force: true });
    }
  }

  return [
    options.dryRun ? "Dry run: would remove Vernier sessions:" : "Removed Vernier sessions:",
    ...targets.map((target) => `- ${path.relative(root, target.path)}`),
    "",
    `${targets.length} session${targets.length === 1 ? "" : "s"} ${options.dryRun ? "would be removed" : "removed"}.`
  ].join("\n");
}

interface CleanOptions {
  keep: number;
  olderThanMs: number | null;
  dryRun: boolean;
}

interface SessionDirectoryEntry {
  path: string;
  mtimeMs: number;
}

function parseCleanOptions(args: string[]): CleanOptions {
  const keepValue = readOption(args, "--keep") ?? "20";
  const keep = Number(keepValue);

  if (!Number.isInteger(keep) || keep < 0) {
    throw new Error(`Invalid --keep value: ${keepValue}`);
  }

  const olderThanValue = readOption(args, "--older-than");

  return {
    keep,
    olderThanMs: olderThanValue ? parseDuration(olderThanValue) : null,
    dryRun: args.includes("--dry-run")
  };
}

function parseDuration(value: string): number {
  const match = value.match(/^(\d+)([dhm])$/);

  if (!match) {
    throw new Error(`Invalid --older-than value: ${value}. Use values like 14d, 12h, or 30m.`);
  }

  const amount = Number(match[1]);
  const unit = match[2];
  const multipliers: Record<string, number> = {
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000
  };

  return amount * multipliers[unit]!;
}

async function readSessionDirectories(sessionsDirectory: string): Promise<SessionDirectoryEntry[]> {
  let entries;
  try {
    entries = await readdir(sessionsDirectory, { withFileTypes: true });
  } catch {
    return [];
  }

  const directories = await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory()) {
      return null;
    }

    const directoryPath = path.join(sessionsDirectory, entry.name);
    const directoryStat = await stat(directoryPath);

    return {
      path: directoryPath,
      mtimeMs: directoryStat.mtimeMs
    };
  }));

  return directories
    .filter((entry): entry is SessionDirectoryEntry => entry !== null)
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
}

function uniqueSessionDirectories(entries: SessionDirectoryEntry[]): SessionDirectoryEntry[] {
  const seen = new Set<string>();
  const result: SessionDirectoryEntry[] = [];

  for (const entry of entries) {
    const resolved = path.resolve(entry.path);

    if (seen.has(resolved)) {
      continue;
    }

    seen.add(resolved);
    result.push(entry);
  }

  return result;
}

function gitignoreIgnoresFeedback(gitignore: string): boolean {
  return gitignore
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line === ".ui-feedback" || line === ".ui-feedback/" || line === "/.ui-feedback" || line === "/.ui-feedback/");
}

async function auditLatestSession(root: string, args: string[]): Promise<string> {
  const [kind = "a11y"] = readPositionalArgs(args);

  if (kind !== "a11y" && kind !== "layout") {
    throw new Error("Usage: vernier audit a11y|layout [--json]");
  }

  const issues = await listLatestIssues(root);

  if (kind === "layout") {
    const findings = issues.flatMap((issue) => auditIssueLayout(issue.issue, issue.stableId));
    const report: LayoutAuditReport = {
      kind,
      sessionId: issues[0]?.session.sessionId ?? "unknown",
      route: issues[0]?.session.route ?? "unknown",
      checkedIssues: issues.length,
      findingCount: findings.length,
      findings
    };

    return args.includes("--json") ? JSON.stringify(report, null, 2) : renderLayoutAudit(report);
  }

  const findings = issues.flatMap((issue) => auditIssueAccessibility(issue.issue, issue.stableId));
  const report: A11yAuditReport = {
    kind: "a11y",
    sessionId: issues[0]?.session.sessionId ?? "unknown",
    route: issues[0]?.session.route ?? "unknown",
    checkedIssues: issues.length,
    findingCount: findings.length,
    findings
  };

  return args.includes("--json") ? JSON.stringify(report, null, 2) : renderA11yAudit(report);
}

interface LayoutFinding {
  issueId: string;
  rule: "overflow" | "spacing" | "layout-context";
  severity: "low" | "medium" | "high";
  message: string;
  selector: string;
  expected: string;
  actual: string;
}

interface LayoutAuditReport {
  kind: "layout";
  sessionId: string;
  route: string;
  checkedIssues: number;
  findingCount: number;
  findings: LayoutFinding[];
}

interface A11yFinding {
  issueId: string;
  rule: "contrast" | "tap-target" | "accessible-name";
  severity: "low" | "medium" | "high";
  message: string;
  selector: string;
  expected: string;
  actual: string;
}

interface A11yAuditReport {
  kind: "a11y";
  sessionId: string;
  route: string;
  checkedIssues: number;
  findingCount: number;
  findings: A11yFinding[];
}

function auditIssueAccessibility(issue: VernierIssue, stableId: string): A11yFinding[] {
  const findings: A11yFinding[] = [];
  const measurement = issue.measurement;
  const box = measurementBoundingBox(measurement);
  const computedStyle = measurementComputedStyle(measurement);
  const target = issue.target;
  const selector = issue.selector;

  if (box && isLikelyInteractive(issue)) {
    const minSide = Math.min(box.width, box.height);

    if (minSide < 44) {
      findings.push({
        issueId: stableId,
        rule: "tap-target",
        severity: "medium",
        message: "Interactive target is smaller than the recommended 44px minimum.",
        selector,
        expected: "at least 44x44px",
        actual: `${Math.round(box.width)}x${Math.round(box.height)}px`
      });
    }
  }

  if (isLikelyInteractive(issue) && !target.accessibleName && !target.text) {
    findings.push({
      issueId: stableId,
      rule: "accessible-name",
      severity: "high",
      message: "Interactive target has no captured accessible name or text.",
      selector,
      expected: "accessible name or visible text",
      actual: "missing"
    });
  }

  const color = computedStyle?.color;
  const backgroundColor = computedStyle?.["background-color"];
  const hasText = Boolean(target.text || target.accessibleName || (measurement?.kind === "single" && measurement.text));

  if (hasText && color && backgroundColor) {
    const contrast = contrastRatio(color, backgroundColor);

    if (contrast !== null && contrast < 4.5) {
      findings.push({
        issueId: stableId,
        rule: "contrast",
        severity: contrast < 3 ? "high" : "medium",
        message: "Text contrast is below WCAG AA guidance for normal text.",
        selector,
        expected: "contrast ratio >= 4.5:1",
        actual: `${contrast.toFixed(2)}:1`
      });
    }
  }

  return findings;
}

function renderA11yAudit(report: A11yAuditReport): string {
  const lines = [
    `A11y audit: ${report.route}`,
    `Checked issues: ${report.checkedIssues}`,
    `Findings: ${report.findingCount}`,
    ""
  ];

  if (report.findings.length === 0) {
    lines.push("No accessibility findings from captured Vernier evidence.");
    return lines.join("\n");
  }

  for (const finding of report.findings) {
    lines.push(
      `[${finding.severity}] ${finding.rule} ${finding.issueId}`,
      `Selector: ${finding.selector}`,
      `Expected: ${finding.expected}`,
      `Actual: ${finding.actual}`,
      finding.message,
      ""
    );
  }

  return lines.join("\n").trimEnd();
}

function auditIssueLayout(issue: VernierIssue, stableId: string): LayoutFinding[] {
  const findings: LayoutFinding[] = [];
  const measurement = issue.measurement;
  const context = measurementLayoutContext(measurement);
  const selector = issue.selector;

  if (context?.overflow?.horizontalPageScroll) {
    findings.push({
      issueId: stableId,
      rule: "overflow",
      severity: "high",
      message: "Page had horizontal overflow when this issue was captured.",
      selector,
      expected: "document width fits viewport",
      actual: "horizontal page scroll detected"
    });
  }

  if (context?.overflow?.clippedByParent) {
    findings.push({
      issueId: stableId,
      rule: "overflow",
      severity: "medium",
      message: "Selected element appears clipped by an overflowing parent.",
      selector,
      expected: "element fully visible inside parent",
      actual: `parent overflow ${context.overflow.x}/${context.overflow.y}`
    });
  }

  if (measurement?.kind === "delta") {
    const nonZeroEdges = [
      ["left", measurement.delta.left],
      ["top", measurement.delta.top],
      ["width", measurement.delta.width],
      ["height", measurement.delta.height]
    ].filter(([, value]) => Math.abs(Number(value)) > 1);

    if (nonZeroEdges.length > 0) {
      findings.push({
        issueId: stableId,
        rule: "spacing",
        severity: "medium",
        message: "Compared elements are not aligned or equally sized.",
        selector,
        expected: "deltas within 1px",
        actual: nonZeroEdges.map(([name, value]) => `${name}: ${formatSignedNumber(Number(value))}px`).join(", ")
      });
    }
  }

  if (context?.parentDisplay && !["block", "flow-root", "inline"].includes(context.parentDisplay)) {
    findings.push({
      issueId: stableId,
      rule: "layout-context",
      severity: "low",
      message: "Captured parent layout context may be relevant to the fix.",
      selector,
      expected: "use existing layout system",
      actual: [
        `display: ${context.parentDisplay}`,
        context.parentGap ? `gap: ${context.parentGap}` : null,
        context.parentPadding ? `padding: ${context.parentPadding}` : null
      ].filter(Boolean).join(", ")
    });
  }

  return findings;
}

function renderLayoutAudit(report: LayoutAuditReport): string {
  const lines = [
    `Layout audit: ${report.route}`,
    `Checked issues: ${report.checkedIssues}`,
    `Findings: ${report.findingCount}`,
    ""
  ];

  if (report.findings.length === 0) {
    lines.push("No layout findings from captured Vernier evidence.");
    return lines.join("\n");
  }

  for (const finding of report.findings) {
    lines.push(
      `[${finding.severity}] ${finding.rule} ${finding.issueId}`,
      `Selector: ${finding.selector}`,
      `Expected: ${finding.expected}`,
      `Actual: ${finding.actual}`,
      finding.message,
      ""
    );
  }

  return lines.join("\n").trimEnd();
}

function measurementBoundingBox(measurement: VernierMeasurement | undefined): BoundingBox | null {
  if (!measurement) {
    return null;
  }

  if (measurement.kind === "single") {
    return measurement.bbox;
  }

  if (measurement.kind === "delta") {
    return measurement.targetBbox;
  }

  return null;
}

function measurementComputedStyle(measurement: VernierMeasurement | undefined): Record<string, string> | null {
  if (!measurement) {
    return null;
  }

  if (measurement.kind === "single") {
    return measurement.computedStyle;
  }

  if (measurement.kind === "delta") {
    return {
      color: measurement.delta.color?.[1] ?? "",
      "background-color": measurement.delta.backgroundColor?.[1] ?? "",
      "font-size": measurement.delta.fontSize?.[1] ?? ""
    };
  }

  return null;
}

function measurementLayoutContext(measurement: VernierMeasurement | undefined): LayoutContext | undefined {
  if (!measurement || measurement.kind === "annotation") {
    return undefined;
  }

  return measurement.layoutContext;
}

function isLikelyInteractive(issue: VernierIssue): boolean {
  const target = issue.target;
  const tag = target.tag.toLowerCase();
  const role = target.role?.toLowerCase();

  return ["button", "a", "input", "select", "textarea", "summary"].includes(tag) ||
    ["button", "link", "checkbox", "radio", "switch", "menuitem", "tab"].includes(role ?? "");
}

function contrastRatio(foreground: string, background: string): number | null {
  const fg = parseCssColor(foreground);
  const bg = parseCssColor(background);

  if (!fg || !bg || fg.alpha === 0 || bg.alpha === 0) {
    return null;
  }

  const fgLuminance = relativeLuminance(fg);
  const bgLuminance = relativeLuminance(bg);
  const lighter = Math.max(fgLuminance, bgLuminance);
  const darker = Math.min(fgLuminance, bgLuminance);

  return (lighter + 0.05) / (darker + 0.05);
}

interface ParsedColor {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

function parseCssColor(value: string): ParsedColor | null {
  const normalized = value.trim().toLowerCase();

  if (normalized === "transparent") {
    return { red: 0, green: 0, blue: 0, alpha: 0 };
  }

  const hex = normalized.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/);

  if (hex) {
    return {
      red: Number.parseInt(hex[1]!.slice(0, 2), 16),
      green: Number.parseInt(hex[1]!.slice(2, 4), 16),
      blue: Number.parseInt(hex[1]!.slice(4, 6), 16),
      alpha: hex[2] ? Number.parseInt(hex[2], 16) / 255 : 1
    };
  }

  const rgb = normalized.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([.\d]+))?\)$/);

  if (!rgb) {
    return null;
  }

  return {
    red: Number(rgb[1]),
    green: Number(rgb[2]),
    blue: Number(rgb[3]),
    alpha: rgb[4] === undefined ? 1 : Number(rgb[4])
  };
}

function relativeLuminance(color: ParsedColor): number {
  const channels = [color.red, color.green, color.blue].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });

  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

async function startMcpServer(root: string): Promise<void> {
  let buffer = "";

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;

    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);

      if (line) {
        void handleMcpMessage(root, line);
      }
    }
  });

  await new Promise<void>((resolve) => {
    process.stdin.on("end", resolve);
  });
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

async function handleMcpMessage(root: string, line: string): Promise<void> {
  let request: JsonRpcRequest;

  try {
    request = JSON.parse(line) as JsonRpcRequest;
  } catch {
    writeMcpResponse(null, undefined, { code: -32700, message: "Parse error" });
    return;
  }

  if (!request.id && request.method?.startsWith("notifications/")) {
    return;
  }

  try {
    writeMcpResponse(request.id ?? null, await dispatchMcpRequest(root, request));
  } catch (error) {
    writeMcpResponse(request.id ?? null, undefined, {
      code: -32000,
      message: error instanceof Error ? error.message : "MCP request failed"
    });
  }
}

async function dispatchMcpRequest(root: string, request: JsonRpcRequest): Promise<unknown> {
  switch (request.method) {
    case "initialize":
      return {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "vernier", version: "0.0.0" },
        capabilities: {
          resources: {},
          tools: {}
        }
      };
    case "resources/list":
      return { resources: await listMcpResources(root) };
    case "resources/read":
      return readMcpResource(root, expectMcpStringParam(request.params, "uri"));
    case "tools/list":
      return { tools: listMcpTools() };
    case "tools/call":
      return callMcpTool(root, request.params);
    case "ping":
      return {};
    default:
      throw new Error(`Unsupported MCP method: ${request.method ?? "unknown"}`);
  }
}

async function listMcpResources(root: string): Promise<Array<{ uri: string; name: string; mimeType: string }>> {
  const resources = [
    { uri: "vernier://latest/session", name: "Latest Vernier session markdown", mimeType: "text/markdown" },
    { uri: "vernier://latest/issues", name: "Latest Vernier issues", mimeType: "application/json" }
  ];

  try {
    const issues = await listLatestIssues(root);
    resources.push(
      ...issues.map((issue) => ({
        uri: `vernier://issue/${issue.stableId}`,
        name: `Vernier issue ${issue.stableId}`,
        mimeType: "text/markdown"
      }))
    );
  } catch {
    // No sessions yet; static resources still describe the server shape.
  }

  return resources;
}

async function readMcpResource(root: string, uri: string): Promise<{ contents: Array<{ uri: string; mimeType: string; text: string }> }> {
  if (uri === "vernier://latest/session") {
    return {
      contents: [{ uri, mimeType: "text/markdown", text: await readLatestSessionMarkdown(root) }]
    };
  }

  if (uri === "vernier://latest/issues") {
    const issues = await listLatestIssues(root);
    return {
      contents: [{
        uri,
        mimeType: "application/json",
        text: JSON.stringify(issues.map(mcpIssueSummary), null, 2)
      }]
    };
  }

  const issueMatch = uri.match(/^vernier:\/\/issue\/(.+)$/);

  if (issueMatch) {
    const issue = await findLatestIssue(root, issueMatch[1]!);

    return {
      contents: [{ uri, mimeType: "text/markdown", text: renderIssueTask(issue) }]
    };
  }

  throw new Error(`Unknown Vernier resource: ${uri}`);
}

function listMcpTools(): Array<{ name: string; description: string; inputSchema: unknown }> {
  return [
    {
      name: "list_vernier_issues",
      description: "List issues in the latest Vernier session.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["all", "todo", "fixed"] }
        }
      }
    },
    {
      name: "get_vernier_issue",
      description: "Get an agent-ready task for a Vernier issue.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"]
      }
    },
    {
      name: "mark_vernier_issue_fixed",
      description: "Mark a Vernier issue fixed.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"]
      }
    },
    {
      name: "mark_vernier_issue_todo",
      description: "Mark a Vernier issue todo.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"]
      }
    },
    {
      name: "verify_vernier_issue",
      description: "Return Vernier verification instructions for an issue.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          target: { type: "string" }
        },
        required: ["id"]
      }
    }
  ];
}

async function callMcpTool(root: string, params: unknown): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const call = expectRecordParam(params, "params");
  const name = expectStringValue(call.name, "params.name");
  const args = call.arguments === undefined ? {} : expectRecordParam(call.arguments, "params.arguments");

  if (name === "list_vernier_issues") {
    const status = expectOptionalStatus(args.status);
    const issues = filterIssuesByStatus(await listLatestIssues(root), status);

    return mcpText(JSON.stringify(issues.map(mcpIssueSummary), null, 2));
  }

  if (name === "get_vernier_issue") {
    return mcpText(renderIssueTask(await findLatestIssue(root, expectStringValue(args.id, "id"))));
  }

  if (name === "mark_vernier_issue_fixed") {
    const issue = await markLatestIssue(root, expectStringValue(args.id, "id"), "fixed");
    return mcpText(`Marked ${issue.stableId} fixed.`);
  }

  if (name === "mark_vernier_issue_todo") {
    const issue = await markLatestIssue(root, expectStringValue(args.id, "id"), "todo");
    return mcpText(`Marked ${issue.stableId} todo.`);
  }

  if (name === "verify_vernier_issue") {
    const issue = await findLatestIssue(root, expectStringValue(args.id, "id"));
    const target = typeof args.target === "string" ? args.target : defaultTarget;
    return mcpText(renderIssueVerification(issue, createIssueTargetUrl(target, issue.session.route)));
  }

  throw new Error(`Unknown Vernier MCP tool: ${name}`);
}

function mcpIssueSummary(issue: Awaited<ReturnType<typeof listLatestIssues>>[number]): Record<string, unknown> {
  return {
    id: issue.stableId,
    number: issue.issue.id,
    status: issue.status,
    kind: issue.issue.kind,
    route: issue.session.route,
    viewport: issue.session.viewport,
    note: issue.issue.note,
    selector: issue.issue.selector,
    source: issue.issue.source,
    screenshotPath: issue.screenshotPath
  };
}

function mcpText(text: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text }] };
}

function writeMcpResponse(
  id: JsonRpcRequest["id"],
  result?: unknown,
  error?: { code: number; message: string }
): void {
  process.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id,
    ...(error ? { error } : { result })
  })}\n`);
}

function expectMcpStringParam(params: unknown, key: string): string {
  const record = expectRecordParam(params, "params");
  return expectStringValue(record[key], `params.${key}`);
}

function expectRecordParam(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }

  return value as Record<string, unknown>;
}

function expectStringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a string`);
  }

  return value;
}

function expectOptionalStatus(value: unknown): IssueStatus | "all" {
  if (value === undefined) {
    return "all";
  }

  if (value === "all" || value === "todo" || value === "fixed") {
    return value;
  }

  throw new Error("status must be all, todo, or fixed");
}

async function handleReplayRequest(root: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const issues = await listLatestIssues(root);
  const sessionDirectory = issues[0]?.sessionDirectory;

  if (!sessionDirectory) {
    sendText(response, 404, "No Vernier session found.");
    return;
  }

  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");

  try {
    if (requestUrl.pathname === "/" || requestUrl.pathname === "/index.html") {
      response.statusCode = 200;
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(await renderReplayHtml(issues));
      return;
    }

    if (requestUrl.pathname === "/session.json") {
      await sendSessionFile(response, sessionDirectory, "session.json", "application/json");
      return;
    }

    if (requestUrl.pathname.startsWith("/screenshots/")) {
      await sendSessionFile(
        response,
        sessionDirectory,
        path.join("screenshots", decodeURIComponent(requestUrl.pathname.slice("/screenshots/".length))),
        "image/png"
      );
      return;
    }

    if (requestUrl.pathname.startsWith("/verification/")) {
      const relativePath = decodeURIComponent(requestUrl.pathname.slice("/verification/".length));
      await sendSessionFile(
        response,
        sessionDirectory,
        path.join("verification", relativePath),
        replayContentType(relativePath)
      );
      return;
    }

    sendText(response, 404, "Not found");
  } catch (error) {
    sendText(response, 404, error instanceof Error ? error.message : "Not found");
  }
}

async function sendSessionFile(
  response: ServerResponse,
  sessionDirectory: string,
  relativePath: string,
  contentType: string
): Promise<void> {
  const safeRoot = path.resolve(sessionDirectory);
  const filePath = path.resolve(sessionDirectory, relativePath);

  if (filePath !== safeRoot && !filePath.startsWith(`${safeRoot}${path.sep}`)) {
    throw new Error("Unsafe replay path");
  }

  response.statusCode = 200;
  response.setHeader("Content-Type", contentType);
  await pipeline(createReadStream(filePath), response);
}

async function renderReplayHtml(issues: Awaited<ReturnType<typeof listLatestIssues>>): Promise<string> {
  const session = issues[0]!.session;
  const verificationReports = await readVerificationReports(issues[0]!.sessionDirectory);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Vernier Replay</title>
    <style>
      :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #172033; background: #eef2f7; }
      body { margin: 0; }
      header { position: sticky; top: 0; z-index: 2; display: flex; justify-content: space-between; gap: 16px; align-items: center; padding: 16px 24px; background: #ffffff; border-bottom: 1px solid #d8dde8; }
      h1, h2, h3 { margin: 0; }
      h1 { font-size: 18px; }
      h2 { font-size: 15px; }
      h3 { font-size: 14px; }
      main { display: grid; grid-template-columns: minmax(280px, 380px) minmax(0, 1fr); gap: 18px; padding: 18px; }
      aside, section.issue, section.preview { background: #ffffff; border: 1px solid #d8dde8; border-radius: 8px; }
      aside { align-self: start; position: sticky; top: 76px; overflow: hidden; }
      .meta { display: grid; gap: 4px; padding: 14px; font-size: 13px; border-bottom: 1px solid #e5e9f1; }
      .issue-list { display: grid; }
      .issue-link { display: grid; gap: 4px; padding: 12px 14px; color: inherit; text-decoration: none; border-bottom: 1px solid #eef1f6; }
      .issue-link:hover { background: #f7f9fc; }
      .tag-row { display: flex; gap: 6px; flex-wrap: wrap; }
      .tag { display: inline-flex; align-items: center; min-height: 20px; padding: 0 7px; border: 1px solid #cfd6e3; border-radius: 999px; font-size: 12px; color: #3b465c; background: #f8fafc; }
      .tag.todo { color: #7a3e00; border-color: #ffc46b; background: #fff7e8; }
      .tag.fixed { color: #0d5c38; border-color: #95ddb8; background: #ecfff4; }
      .content { display: grid; gap: 18px; min-width: 0; }
      .preview { padding: 14px; }
      .full { max-width: 100%; border: 1px solid #d8dde8; border-radius: 6px; }
      .issue { display: grid; gap: 12px; padding: 14px; scroll-margin-top: 92px; }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
      .panel { display: grid; gap: 8px; min-width: 0; }
      .panel img { width: 100%; max-height: 420px; object-fit: contain; background: #f6f8fb; border: 1px solid #d8dde8; border-radius: 6px; }
      pre { margin: 0; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; padding: 10px; border-radius: 6px; background: #172033; color: #f8fafc; font-size: 12px; line-height: 1.45; }
      code { overflow-wrap: anywhere; }
      .muted { color: #5f6c82; font-size: 13px; }
      @media (max-width: 820px) { main { grid-template-columns: 1fr; } aside { position: static; } }
    </style>
  </head>
  <body>
    <header>
      <div>
        <h1>Vernier Replay</h1>
        <div class="muted">${escapeHtml(session.route)} · ${session.viewport.width}x${session.viewport.height} @${session.viewport.devicePixelRatio}x</div>
      </div>
      <div class="tag-row">
        <span class="tag">${issues.length} issues</span>
        <a class="tag" href="/session.json">session.json</a>
      </div>
    </header>
    <main>
      <aside>
        <div class="meta">
          <strong>${escapeHtml(session.createdAt)}</strong>
          <span>${escapeHtml(session.url)}</span>
          <span>${escapeHtml(session.sessionId)}</span>
        </div>
        <nav class="issue-list">
          ${issues.map((issue) => renderReplayIssueLink(issue)).join("")}
        </nav>
      </aside>
      <div class="content">
        <section class="preview">
          <h2>Full Page</h2>
          <p class="muted">Captured screenshot for this session.</p>
          <img class="full" src="/screenshots/${encodeURIComponent(session.fullPageScreenshotName)}" alt="Full page screenshot" />
        </section>
        ${issues.map((issue) => renderReplayIssue(issue, verificationReports.get(issue.stableId))).join("")}
      </div>
    </main>
  </body>
</html>`;
}

function renderReplayIssueLink(issue: Awaited<ReturnType<typeof listLatestIssues>>[number]): string {
  return `<a class="issue-link" href="#${escapeHtml(issue.stableId)}">
    <strong>${escapeHtml(issue.stableId)} · issue ${issue.issue.id}</strong>
    <span class="muted">${escapeHtml(issue.issue.note || issue.issue.kind)}</span>
    <span class="tag-row"><span class="tag ${issue.status}">${issue.status}</span><span class="tag">${issue.issue.kind}</span></span>
  </a>`;
}

function renderReplayIssue(
  issue: Awaited<ReturnType<typeof listLatestIssues>>[number],
  verificationReport: unknown
): string {
  return `<section class="issue" id="${escapeHtml(issue.stableId)}">
    <div class="tag-row">
      <span class="tag ${issue.status}">${issue.status}</span>
      <span class="tag">${escapeHtml(issue.issue.kind)}</span>
      <span class="tag">${escapeHtml(issue.stableId)}</span>
    </div>
    <h2>${escapeHtml(issue.issue.note || "Untitled UI issue")}</h2>
    <div class="muted">Selector: <code>${escapeHtml(issue.issue.selector)}</code></div>
    <div class="grid">
      <div class="panel">
        <h3>Screenshot</h3>
        <img src="/screenshots/${encodeURIComponent(issue.issue.screenshotName)}" alt="Issue screenshot" />
      </div>
      <div class="panel">
        <h3>Measured</h3>
        <pre>${escapeHtml(issue.issue.measured)}</pre>
      </div>
      <div class="panel">
        <h3>Structured Evidence</h3>
        <pre>${escapeHtml(JSON.stringify(issue.issue.measurement ?? issue.issue.target, null, 2))}</pre>
      </div>
      <div class="panel">
        <h3>Verification</h3>
        ${renderVerificationPanel(issue.stableId, verificationReport)}
      </div>
    </div>
  </section>`;
}

function renderVerificationPanel(issueId: string, report: unknown): string {
  if (!report) {
    return `<p class="muted">No verification report yet. Run <code>vernier verify ${escapeHtml(issueId)} --compare</code>.</p>`;
  }

  const record = report as { selectorFound?: boolean; suggestedStatus?: string; differences?: unknown[] };

  return `<div class="tag-row">
      <span class="tag">selector ${record.selectorFound ? "found" : "missing"}</span>
      <span class="tag">suggested ${escapeHtml(record.suggestedStatus ?? "unknown")}</span>
    </div>
    <p><a href="/verification/${encodeURIComponent(issueId)}/report.md">report.md</a> · <a href="/verification/${encodeURIComponent(issueId)}/after.png">after.png</a></p>
    <pre>${escapeHtml(JSON.stringify(report, null, 2))}</pre>`;
}

async function readVerificationReports(sessionDirectory: string): Promise<Map<string, unknown>> {
  const reports = new Map<string, unknown>();
  const verificationDirectory = path.join(sessionDirectory, "verification");

  let entries;
  try {
    entries = await readdir(verificationDirectory, { withFileTypes: true });
  } catch {
    return reports;
  }

  await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory()) {
      return;
    }

    try {
      const raw = await readFile(path.join(verificationDirectory, entry.name, "report.json"), "utf8");
      reports.set(entry.name, JSON.parse(raw));
    } catch {
      // Ignore partial verification artifacts.
    }
  }));

  return reports;
}

function replayContentType(relativePath: string): string {
  if (relativePath.endsWith(".png")) {
    return "image/png";
  }

  if (relativePath.endsWith(".json")) {
    return "application/json";
  }

  return "text/plain; charset=utf-8";
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

function roundNumber(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatSignedNumber(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

async function markIssue(args: string[]): Promise<void> {
  const [reference, status] = readPositionalArgs(args);

  if (!reference || !isIssueStatus(status)) {
    throw new Error("Usage: vernier mark <issue-id> todo|fixed");
  }

  const issue = await markLatestIssue(process.cwd(), reference, status);

  console.log(`Marked ${issue.stableId} ${status}.`);
}

async function updateIssueNote(args: string[]): Promise<void> {
  const [reference, ...noteParts] = readPositionalArgs(args);
  const note = noteParts.join(" ").trim();

  if (!reference || !note) {
    throw new VernierError("VERNIER_INVALID_OPTION", "Usage: vernier note <issue-id> \"updated note\"", "Use quotes around notes with spaces.");
  }

  const issue = await updateLatestIssueNote(process.cwd(), reference, note);

  console.log(`Updated ${issue.stableId} note.`);
}

async function handleGitHubCommand(args: string[]): Promise<void> {
  const [action = "body", reference = "all"] = readPositionalArgs(args);

  if (action !== "body" && action !== "create") {
    throw new VernierError("VERNIER_INVALID_OPTION", "Usage: vernier github body|create [all|<issue-id>] [--label ui-feedback]", "Use `vernier github body <issue-id>` to preview without network.");
  }

  const issues = await resolveGitHubIssues(reference);

  if (action === "body") {
    console.log(renderGitHubIssuesPreview(issues));
    return;
  }

  await createGitHubIssues(issues, readOption(args, "--label") ?? "ui-feedback");
}

async function resolveGitHubIssues(reference: string): Promise<Awaited<ReturnType<typeof listLatestIssues>>> {
  if (reference === "all") {
    return filterIssuesByStatus(await listLatestIssues(process.cwd()), "todo");
  }

  return [await findLatestIssue(process.cwd(), reference)];
}

function renderGitHubIssuesPreview(issues: Awaited<ReturnType<typeof listLatestIssues>>): string {
  if (issues.length === 0) {
    return "No todo issues in latest Vernier session.";
  }

  return issues.flatMap((issue, index) => [
    index === 0 ? "" : "\n---\n",
    `Title: ${renderGitHubIssueTitle(issue)}`,
    "",
    renderGitHubIssueBody(issue)
  ]).join("\n").trim();
}

async function createGitHubIssues(
  issues: Awaited<ReturnType<typeof listLatestIssues>>,
  label: string
): Promise<void> {
  if (issues.length === 0) {
    console.log("No todo issues in latest Vernier session.");
    return;
  }

  const tempDirectory = await mkdtemp(path.join(tmpdir(), "vernier-github-"));

  try {
    for (const issue of issues) {
      const bodyPath = path.join(tempDirectory, `${issue.stableId}.md`);
      await writeFile(bodyPath, `${renderGitHubIssueBody(issue)}\n`);
      const args = ["issue", "create", "--title", renderGitHubIssueTitle(issue), "--body-file", bodyPath, "--label", label];
      const url = await runProcess("gh", args);
      console.log(`Created GitHub issue for ${issue.stableId}: ${url.trim()}`);
    }
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
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

function readAgentTemplate(args: string[], fallbackAgent?: string): AgentTemplate {
  const value = readOption(args, "--template") ?? fallbackAgent ?? "generic";

  if (value === "generic" || value === "codex" || value === "claude" || value === "cursor" || value === "aider" || value === "strict") {
    return value;
  }

  throw new VernierError("VERNIER_INVALID_OPTION", `Invalid --template value: ${value}`, "Use generic, codex, claude, cursor, aider, or strict.");
}

function readRequiredReference(args: string[], command: string): string {
  const reference = readPositionalArgs(args)[0];

  if (!reference) {
    throw new Error(`Usage: vernier ${command} <issue-id>`);
  }

  return reference;
}

async function sendIssueToAgent(args: string[], config: VernierConfig): Promise<void> {
  const reference = readPositionalArgs(args)[0] ?? "all";
  const agent = readOption(args, "--to") ?? process.env.VERNIER_AGENT ?? config.agents?.default;

  if (agent !== "codex" && agent !== "claude") {
    throw new VernierError("VERNIER_INVALID_OPTION", "Usage: vernier send <issue-id> --to codex|claude", "Set agents.default in vernier.config.json or VERNIER_AGENT to avoid passing --to every time.");
  }

  const template = readAgentTemplate(args, agent);
  const task = reference === "all"
    ? await createIssuesSendTask(args, template)
    : renderIssueTask(await findLatestIssue(process.cwd(), reference), template);

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

async function createIssuesSendTask(args: string[], template: AgentTemplate): Promise<string> {
  const issues = filterIssuesByStatus(await listLatestIssues(process.cwd()), args.includes("--all") ? "all" : "todo");

  if (issues.length === 0) {
    return args.includes("--all")
      ? "No issues in latest Vernier session."
      : "No todo issues in latest Vernier session. Use --all to include fixed issues.";
  }

  return renderIssuesTask(issues, template);
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

function runProcess(executable: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new VernierError("VERNIER_GH_MISSING", "Could not find the gh CLI on PATH.", "Install and authenticate GitHub CLI, or run `vernier github body` to preview the issue body."));
        return;
      }

      reject(new Error(`Could not start ${executable}: ${error.message}`));
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }

      reject(new VernierError("VERNIER_GH_FAILED", `${executable} exited with code ${code}`, stderr.trim() || "Run gh auth status to check authentication."));
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

async function detectLocalApps(args: string[], config: VernierConfig): Promise<void> {
  const apps = await scanLocalApps(parseDetectPorts(args, config));

  if (apps.length === 0) {
    console.log("No local web apps found.");
    console.log(`Try: vernier --target ${resolveTargetOption([], config)}`);
    return;
  }

  console.log("Found local web apps:");
  for (const app of apps) {
    console.log(`  ${app.url}  ${app.label} (${app.status})`);
  }

  console.log("");
  console.log("Attach Vernier:");
  console.log(`  vernier attach --target ${apps[0].url}`);
}

async function attachToLocalApp(args: string[], config: VernierConfig): Promise<void> {
  const target = await resolveAttachTarget(args, config);
  const options = parseProxyOptions(["--target", target, ...args.filter((arg) => arg !== "--open" && arg !== "--no-open")], config);

  await startProxyServer(options, { open: !args.includes("--no-open") });
}

async function resolveAttachTarget(args: string[], config: VernierConfig): Promise<string> {
  const explicitTarget = readOption(args, "--target") ?? readPositionalTarget(args);

  if (explicitTarget) {
    return explicitTarget;
  }

  if (config.target || process.env.VERNIER_TARGET) {
    return resolveTargetOption(args, config);
  }

  const apps = await scanLocalApps(parseDetectPorts(args, config));

  if (apps.length === 0) {
    throw new VernierError(
      "VERNIER_NO_LOCAL_APP",
      "No local web apps found.",
      `Start your app, or run: vernier attach --target ${resolveTargetOption([], config)}`
    );
  }

  console.log(`[vernier] detected ${apps[0].label} at ${apps[0].url}`);
  return apps[0].url;
}

async function scanLocalApps(ports: number[]): Promise<DetectedApp[]> {
  return (await Promise.all(ports.map((port) => detectPort(port)))).filter(
    (app): app is DetectedApp => Boolean(app)
  );
}

function parseDetectPorts(args: string[], config: VernierConfig): number[] {
  const portsValue = readOption(args, "--ports");

  if (!portsValue) {
    return config.detectPorts ?? readEnvPorts() ?? defaultDetectPorts;
  }

  const ports = portsValue.split(",").map((value) => Number(value.trim()));

  if (ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new VernierError("VERNIER_INVALID_OPTION", `Invalid --ports value: ${portsValue}`, "Use a comma-separated list of TCP ports, for example --ports 5173,3000,6006.");
  }

  return [...new Set(ports)];
}

function readEnvPorts(): number[] | null {
  const portsValue = process.env.VERNIER_PORTS;

  if (!portsValue) {
    return null;
  }

  const ports = portsValue.split(",").map((value) => Number(value.trim()));

  if (ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new VernierError("VERNIER_INVALID_OPTION", `Invalid VERNIER_PORTS value: ${portsValue}`, "Use a comma-separated list of TCP ports, for example VERNIER_PORTS=5173,3000,6006.");
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

function parseProxyOptions(args: string[], config: VernierConfig = {}): ProxyOptions {
  const targetValue = resolveTargetOption(args, config);
  const port = parsePortOption(args, resolveDefaultPort(config));

  return {
    target: parseUrlOption(targetValue, "target"),
    port,
    root: process.cwd()
  };
}

function parsePortOption(args: string[], fallbackPort: number | "auto"): number | "auto" {
  const portValue = readOption(args, "--port") ?? process.env.VERNIER_PORT ?? String(fallbackPort);
  const port = portValue === "auto" ? "auto" : Number(portValue);

  if (port !== "auto" && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new VernierError("VERNIER_INVALID_OPTION", `Invalid --port value: ${portValue}`, "Use a port from 1 to 65535, or --port auto.");
  }

  return port;
}

function resolveTargetOption(args: string[], config: VernierConfig): string {
  return readOption(args, "--target") ?? readPositionalTarget(args) ?? process.env.VERNIER_TARGET ?? config.target ?? defaultTarget;
}

function resolveDefaultPort(config: VernierConfig): number | "auto" {
  return process.env.VERNIER_PORT === undefined ? config.port ?? defaultPort : defaultPort;
}

function parseUrlOption(value: string, field: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new VernierError("VERNIER_INVALID_OPTION", `Invalid ${field} URL: ${value}`, "Use an absolute local URL, for example http://localhost:5173.");
  }
}

async function startProxyServer(options: ProxyOptions, settings: { open: boolean }): Promise<void> {
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

  if (settings.open) {
    await openUrl(proxyUrl);
  }
}

function listenWithPortFallback(server: ReturnType<typeof createServer>, requestedPort: number): Promise<number> {
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

function handleProxyUpgrade(
  options: ProxyOptions,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer
): void {
  const targetUrl = new URL(request.url ?? "/", options.target);
  const targetPort = Number(targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80));
  const upstream = targetUrl.protocol === "https:"
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
    socket.destroy();
  });
  socket.on("error", () => {
    upstream.destroy();
  });
  socket.on("close", () => {
    upstream.destroy();
  });
}

function createUpgradeRequest(request: IncomingMessage, targetUrl: URL): string {
  const pathAndQuery = `${targetUrl.pathname}${targetUrl.search}`;
  const lines = [`${request.method ?? "GET"} ${pathAndQuery} HTTP/${request.httpVersion}`];
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

  copyResponseHeaders(upstream, response, options);
  response.statusCode = upstream.status;

  if (isRedirectStatus(upstream.status)) {
    response.end();
    return;
  }

  if (contentType.includes("text/event-stream") && upstream.body) {
    await pipeline(Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]), response);
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

function copyResponseHeaders(upstream: Response, response: ServerResponse, options: ProxyOptions): void {
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

    response.setHeader(key, key.toLowerCase() === "location" ? rewriteLocationHeader(value, options) : value);
  });

  if (setCookies.length > 0) {
    response.setHeader("set-cookie", setCookies.map((cookie) => rewriteSetCookieHeader(cookie, options.target)));
  }
}

function readSetCookieHeaders(upstream: Response): string[] {
  const headers = upstream.headers as Headers & { getSetCookie?: () => string[] };
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
      return domain === targetHost || targetHost.endsWith(`.${domain}`) ? "" : trimmed;
    })
    .filter(Boolean)
    .join("; ");
}

function rewriteLocationHeader(location: string, options: ProxyOptions): string {
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
