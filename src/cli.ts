#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { attachToLocalApp, detectLocalApps } from "./cli/commands/attach";
import { auditLatestSession } from "./cli/commands/audit";
import { cleanSessions } from "./cli/commands/clean";
import { runDoctor } from "./cli/commands/doctor";
import { exportLatestSession } from "./cli/commands/export";
import { runFixLoop } from "./cli/commands/fix-loop";
import { handleGitHubCommand } from "./cli/commands/github";
import {
  copyIssueCommand,
  listIssuesCommand,
  planIssueCommand,
  sendIssueToAgent,
  showIssueCommand,
} from "./cli/commands/handoff";
import { importSessionArtifact } from "./cli/commands/import";
import {
  assertIssue,
  markIssue,
  renameSession,
  updateIssueNote,
} from "./cli/commands/issues";
import { startMcpServer } from "./cli/commands/mcp";
import {
  isUrlLike,
  listenWithPortFallback,
  openUrl,
  parseProxyOptions,
  parseUrlOption,
  resolveTargetOption,
  startProxyServer,
} from "./cli/commands/proxy";
import { startReplayViewer } from "./cli/commands/replay";
import { printSnippet, startStandaloneServer } from "./cli/commands/snippet";
import { summarizeLatestStatus } from "./cli/commands/status";
import { captureStorybook } from "./cli/commands/storybook";
import {
  captureRoutes,
  diffArtifacts,
  verifyIssue,
} from "./cli/commands/verify";
import { parseArgs } from "./cli/lib/args";
import { debugLog, setDebugEnabled } from "./cli/lib/debug";
import { VernierError } from "./cli/lib/errors";
import {
  createAgentPrompt,
  latestSessionMarkdownPath,
  readLatestSessionMarkdown,
} from "./core/handoff";
import {
  normalizeOverlayRuntimeOptions,
  type OverlayRuntimeOptions,
} from "./core/overlay-options";
import { resolveFeedbackDirectory } from "./core/session-writer";

interface VernierConfig {
  target?: string;
  port?: number | "auto";
  outDir?: string;
  detectPorts?: number[];
  verification?: {
    bboxTolerancePx?: number;
  };
  overlay?: OverlayRuntimeOptions;
  agents?: {
    default?: "codex" | "claude";
  };
}

interface CliContext {
  config: VernierConfig;
  verbose: boolean;
}

async function createCliContext(args: string[]): Promise<CliContext> {
  const parsed = parseArgs(args);
  const verbose =
    parsed.flag("--verbose") ||
    process.env.VERNIER_DEBUG === "1" ||
    process.env.DEBUG?.split(",").some(
      (value) => value.trim() === "vernier:*",
    ) === true;
  setDebugEnabled(verbose);
  const config = await loadConfig(args);

  return { config, verbose };
}

async function loadConfig(args: string[]): Promise<VernierConfig> {
  const configPath = await findConfigPath(args);

  if (!configPath) {
    debugLog("config", "no config file found");
    return {};
  }

  const loaded = await readConfigFile(configPath);
  const config = validateConfig(loaded, configPath);
  debugLog("config", `loaded ${configPath}`);
  return config;
}

async function findConfigPath(args: string[]): Promise<string | null> {
  const explicit = parseArgs(args, { valueOptions: ["--config"] }).option(
    "--config",
  );

  if (explicit) {
    const resolved = path.resolve(process.cwd(), explicit);
    await access(resolved).catch(() => {
      throw new VernierError(
        "VERNIER_CONFIG_NOT_FOUND",
        `Config file was not found: ${resolved}`,
        "Check the --config path or create vernier.config.json.",
      );
    });
    return resolved;
  }

  for (const filename of [
    "vernier.config.json",
    "vernier.config.mjs",
    "vernier.config.js",
    "vernier.config.cjs",
  ]) {
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
      throw new VernierError(
        "VERNIER_INVALID_CONFIG",
        `Could not parse ${configPath}`,
        error instanceof Error ? error.message : undefined,
      );
    }
  }

  if (extension === ".cjs") {
    return require(configPath);
  }

  if (extension === ".js" || extension === ".mjs") {
    const module = await import(pathToFileURL(configPath).href);
    return "default" in module ? module.default : module;
  }

  throw new VernierError(
    "VERNIER_UNSUPPORTED_CONFIG",
    `Unsupported config file extension: ${extension}`,
    "Use vernier.config.json, .js, .mjs, or .cjs.",
  );
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

  if (config.outDir !== undefined) {
    result.outDir = expectConfigString(config.outDir, "outDir");
    resolveFeedbackDirectory(process.cwd(), result.outDir);
  }

  if (config.detectPorts !== undefined) {
    result.detectPorts = expectConfigPorts(config.detectPorts, "detectPorts");
  }

  if (config.verification !== undefined) {
    const verification = expectOptionalRecord(
      config.verification,
      "verification",
    );
    result.verification = {};

    if (verification.bboxTolerancePx !== undefined) {
      result.verification.bboxTolerancePx = expectConfigNonNegativeNumber(
        verification.bboxTolerancePx,
        "verification.bboxTolerancePx",
      );
    }
  }

  if (config.overlay !== undefined) {
    const overlay = expectOptionalRecord(config.overlay, "overlay");
    result.overlay = normalizeOverlayRuntimeOptions({
      hotkey:
        overlay.hotkey === undefined
          ? undefined
          : expectConfigString(overlay.hotkey, "overlay.hotkey"),
      styleProperties:
        overlay.styleProperties === undefined
          ? undefined
          : expectConfigStringArray(
              overlay.styleProperties,
              "overlay.styleProperties",
            ),
      redact:
        overlay.redact === undefined
          ? undefined
          : expectConfigStringArray(overlay.redact, "overlay.redact"),
      sessionEndpoint:
        overlay.sessionEndpoint === undefined
          ? undefined
          : expectConfigString(
              overlay.sessionEndpoint,
              "overlay.sessionEndpoint",
            ),
      captureFullPage:
        overlay.captureFullPage === undefined
          ? undefined
          : expectConfigBoolean(
              overlay.captureFullPage,
              "overlay.captureFullPage",
            ),
      screenshotMaxWidth:
        overlay.screenshotMaxWidth === undefined
          ? undefined
          : expectConfigPositiveInteger(
              overlay.screenshotMaxWidth,
              "overlay.screenshotMaxWidth",
            ),
      captureStrategy:
        overlay.captureStrategy === undefined
          ? undefined
          : expectOverlayCaptureStrategy(
              overlay.captureStrategy,
              "overlay.captureStrategy",
            ),
    });
  }

  if (config.agents !== undefined) {
    const agents = expectOptionalRecord(config.agents, "agents");
    result.agents = {};

    if (agents.default !== undefined) {
      result.agents.default = expectConfigAgent(
        agents.default,
        "agents.default",
      );
    }
  }

  return result;
}

function expectOptionalRecord(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new VernierError(
      "VERNIER_INVALID_CONFIG",
      `${field} must export an object.`,
    );
  }

  return value as Record<string, unknown>;
}

function expectConfigString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new VernierError(
      "VERNIER_INVALID_CONFIG",
      `Config ${field} must be a non-empty string.`,
    );
  }

  return value;
}

function expectConfigPort(value: unknown, field: string): number | "auto" {
  if (value === "auto") {
    return value;
  }

  if (
    !Number.isInteger(value) ||
    (value as number) < 1 ||
    (value as number) > 65535
  ) {
    throw new VernierError(
      "VERNIER_INVALID_CONFIG",
      `Config ${field} must be a TCP port or "auto".`,
    );
  }

  return value as number;
}

function expectConfigPorts(value: unknown, field: string): number[] {
  if (!Array.isArray(value)) {
    throw new VernierError(
      "VERNIER_INVALID_CONFIG",
      `Config ${field} must be an array of TCP ports.`,
    );
  }

  return [
    ...new Set(
      value
        .map((port, index) => expectConfigPort(port, `${field}[${index}]`))
        .filter((port): port is number => port !== "auto"),
    ),
  ];
}

function expectConfigNonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new VernierError(
      "VERNIER_INVALID_CONFIG",
      `Config ${field} must be a non-negative number.`,
    );
  }

  return value;
}

function expectConfigPositiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new VernierError(
      "VERNIER_INVALID_CONFIG",
      `Config ${field} must be a positive integer.`,
    );
  }

  return value as number;
}

function expectConfigAgent(value: unknown, field: string): "codex" | "claude" {
  if (value !== "codex" && value !== "claude") {
    throw new VernierError(
      "VERNIER_INVALID_CONFIG",
      `Config ${field} must be codex or claude.`,
    );
  }

  return value;
}

function expectOverlayCaptureStrategy(
  value: unknown,
  field: string,
): "html2canvas" | "modern-screenshot" {
  if (value !== "html2canvas" && value !== "modern-screenshot") {
    throw new VernierError(
      "VERNIER_INVALID_CONFIG",
      `Config ${field} must be html2canvas or modern-screenshot.`,
    );
  }

  return value;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  const context = await createCliContext(process.argv.slice(2));

  if (
    !command ||
    command === "proxy" ||
    command === "start" ||
    isUrlLike(command) ||
    command.startsWith("--")
  ) {
    const proxyArgs =
      command && command !== "proxy" && command !== "start"
        ? [command, ...args]
        : args;
    const options = parseProxyOptions(proxyArgs, context.config);
    await startProxyServer(options, { open: false });
    return;
  }

  if (command === "attach") {
    await attachToLocalApp(args, context.config, {
      parseProxyOptions,
      resolveTargetOption,
      startProxyServer,
    });
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

  if (command === "status") {
    console.log(await summarizeLatestStatus(process.cwd(), args));
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

  if (command === "assert") {
    await assertIssue(process.cwd(), args);
    return;
  }

  if (command === "rename-session") {
    await renameSession(process.cwd(), args);
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

  if (command === "export") {
    console.log(await exportLatestSession(process.cwd(), args));
    return;
  }

  if (command === "import") {
    console.log(await importSessionArtifact(process.cwd(), args));
    return;
  }

  if (command === "fix-loop") {
    await runFixLoop(process.cwd(), args, context.config);
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

  if (command === "storybook") {
    console.log(await captureStorybook(args));
    return;
  }

  if (command === "replay") {
    await startReplayViewer(args, {
      root: process.cwd(),
      listenWithPortFallback,
      openUrl,
    });
    return;
  }

  if (command === "serve") {
    await startStandaloneServer(args, context.config);
    return;
  }

  if (command === "snippet") {
    console.log(printSnippet(args, context.config));
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
    console.log(
      createAgentPrompt(await readLatestSessionMarkdown(process.cwd())),
    );
    return;
  }

  if (command === "open") {
    await openLatestSessionDirectory(process.cwd());
    return;
  }

  printHelp();
  process.exit(command ? 1 : 0);
}

function expectConfigStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new VernierError(
      "VERNIER_INVALID_CONFIG",
      `Config ${field} must be an array of non-empty strings.`,
    );
  }

  return value.map((item, index) =>
    expectConfigString(item, `${field}[${index}]`),
  );
}

function expectConfigBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new VernierError(
      "VERNIER_INVALID_CONFIG",
      `Config ${field} must be a boolean.`,
    );
  }

  return value;
}

async function openLatestSessionDirectory(root: string): Promise<void> {
  const latestDirectory = path.join(root, ".ui-feedback", "latest");

  await access(latestDirectory);

  if (process.platform === "win32") {
    spawn("explorer.exe", [latestDirectory], {
      detached: true,
      stdio: "ignore",
    }).unref();
    return;
  }

  if (process.platform === "darwin") {
    spawn("open", [latestDirectory], {
      detached: true,
      stdio: "ignore",
    }).unref();
    return;
  }

  spawn("xdg-open", [latestDirectory], {
    detached: true,
    stdio: "ignore",
  }).unref();
}

function printHelp(): void {
  console.log(
    [
      "Usage:",
      "  vernier [--target http://localhost:5173] [--port 3333|auto] [--config vernier.config.json] [--verbose]",
      "  vernier attach [--target <url>] [--ports 5173,3000,6006] [--open|--no-open]",
      "  vernier start [--target <url>] [--port 3333|auto]",
      "  vernier proxy [--target <url>] [--port 3333|auto]",
      "  vernier http://localhost:5173",
      "  vernier detect [--ports 5173,3000,6006] [--json]",
      "  vernier issues [--todo|--fixed|--all] [--json]",
      "  vernier status [--json]",
      "  vernier show <issue-id>",
      "  vernier copy <issue-id> [--format task|packet] [--template generic|codex|claude|cursor|aider|strict] [--print]",
      '  vernier note <issue-id> "updated note"',
      "  vernier assert <issue-id> <property>=<expected> [--tolerance n]",
      '  vernier rename-session "short title"',
      "  vernier plan <issue-id>",
      "  vernier export [--format md|json|zip] [--out <path>]",
      "  vernier import <session-directory-or-zip> [--out-dir .ui-feedback]",
      "  vernier github body|create [all|<issue-id>] [--label ui-feedback] [--dry-run]",
      "  vernier fix-loop [all|<issue-id>] --to codex|claude [--target <url>] [--print]",
      "  vernier mark <issue-id> todo|fixed",
      "  vernier verify <issue-id> [--target <url>] [--open]",
      "  vernier verify <issue-id> --compare [--target <url>] [--tolerance 2] [--viewports mobile,tablet,desktop|390x844,1440x900]",
      "  vernier capture --target <url> --routes /,/pricing [--viewports mobile,desktop]",
      "  vernier diff <left-session-or-capture> <right-session-or-capture>",
      "  vernier storybook [--url http://localhost:6006] [--stories id-a,id-b] [--viewports mobile,desktop]",
      "  vernier replay latest [--port 3340|auto] [--no-open]",
      "  vernier serve [--port 3333|auto]",
      "  vernier snippet [--port 3333]",
      "  vernier doctor",
      "  vernier clean [--keep 20] [--older-than 14d] [--dry-run]",
      "  vernier audit a11y|layout [--json]",
      "  vernier mcp",
      "  vernier send [all|<issue-id>] --to codex|claude [--template generic|codex|claude|cursor|aider|strict] [--all] [--print]",
      "  vernier latest",
      "  vernier open",
      "",
      "Config:",
      "  vernier.config.json|js|mjs|cjs can set target, port, outDir, detectPorts, overlay.hotkey, overlay.styleProperties, overlay.redact, overlay.captureFullPage, overlay.screenshotMaxWidth, overlay.captureStrategy, overlay.sessionEndpoint, verification.bboxTolerancePx, and agents.default.",
      "  Debug logging: pass --verbose, VERNIER_DEBUG=1, or DEBUG=vernier:*.",
      "  Environment defaults: VERNIER_TARGET, VERNIER_PORT, VERNIER_PORTS, VERNIER_AGENT, VERNIER_DEBUG=1.",
      "",
      `Latest session path: ${latestSessionMarkdownPath}`,
    ].join("\n"),
  );
}

main().catch((error) => {
  if (error instanceof VernierError) {
    console.error(error.code);
    console.error(error.message);
    if (error.hint) {
      console.error(`Hint: ${error.hint}`);
    }
    debugLog("error", error.stack ?? error.message);
    process.exit(1);
  }

  console.error(error instanceof Error ? error.message : error);
  if (error instanceof Error) {
    debugLog("error", error.stack ?? error.message);
  }
  process.exit(1);
});
