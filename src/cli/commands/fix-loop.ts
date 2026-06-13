import { spawn } from "node:child_process";
import {
  type AgentTemplate,
  filterIssuesByStatus,
  findLatestIssue,
  type IndexedVernierIssue,
  listLatestIssues,
  markLatestIssue,
  renderIssuesTask,
  renderIssueTask,
} from "../../core/issues";
import { parseArgs } from "../lib/args";
import { VernierError } from "../lib/errors";
import { resolveTargetOption } from "./proxy";
import {
  type CompareViewport,
  compareLatestIssue,
  createIssueTargetUrl,
} from "./verify";

interface FixLoopConfig {
  target?: string;
  verification?: {
    bboxTolerancePx?: number;
  };
  agents?: {
    default?: "codex" | "claude";
  };
}

const fixLoopValueOptions = [
  "--to",
  "--target",
  "--tolerance",
  "--max-attempts",
  "--template",
  "--config",
];

export async function runFixLoop(
  root: string,
  args: string[],
  config: FixLoopConfig,
): Promise<void> {
  const parsed = parseArgs(args, { valueOptions: fixLoopValueOptions });
  const agent =
    parsed.option("--to") ??
    process.env.VERNIER_AGENT ??
    config.agents?.default;

  if (agent !== "codex" && agent !== "claude") {
    throw new VernierError(
      "VERNIER_INVALID_OPTION",
      "Usage: vernier fix-loop [all|<issue-id>] --to codex|claude",
      "Set agents.default in vernier.config.json or VERNIER_AGENT to avoid passing --to every time.",
    );
  }

  const issues = await readFixLoopIssues(
    root,
    parsed.positionals()[0] ?? "all",
  );
  const maxAttempts = readMaxAttempts(args);
  const tolerance = readTolerance(args, config);
  const template = readAgentTemplate(args, agent);

  if (issues.length === 0) {
    console.log("No todo issues in latest Vernier session.");
    return;
  }

  if (parsed.flag("--print")) {
    console.log(
      renderFixLoopTask(
        issues,
        template,
        resolveTargetOption(args, config),
        maxAttempts,
        tolerance,
      ),
    );
    return;
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    console.log(`[vernier] fix-loop attempt ${attempt}/${maxAttempts}`);
    const task = renderFixLoopTask(
      issues,
      template,
      resolveTargetOption(args, config),
      maxAttempts,
      tolerance,
    );
    const result = await runAgent(agent, task);

    if (result === "missing") {
      console.log(`Could not find the ${agent} CLI on PATH.`);
      console.log(
        "Run again with --print and paste the task into the desktop app, or install the CLI.",
      );
      return;
    }

    const remaining: IndexedVernierIssue[] = [];

    for (const issue of issues) {
      const targetUrl = createIssueTargetUrl(
        resolveTargetOption(args, config),
        issue.session.route,
      );
      const comparison = await compareLatestIssue(issue, targetUrl, tolerance, [
        capturedViewport(issue),
      ]);
      console.log(comparison.output);

      if (comparison.suggestedStatus === "fixed") {
        await markLatestIssue(root, issue.stableId, "fixed");
        console.log(`[vernier] marked ${issue.stableId} fixed`);
      } else {
        remaining.push(issue);
      }
    }

    if (remaining.length === 0) {
      console.log("[vernier] fix-loop complete");
      return;
    }

    issues.splice(0, issues.length, ...remaining);
  }

  console.log(
    `[vernier] fix-loop stopped with ${issues.length} todo issue${issues.length === 1 ? "" : "s"} remaining.`,
  );
}

async function readFixLoopIssues(
  root: string,
  reference: string,
): Promise<IndexedVernierIssue[]> {
  if (reference === "all") {
    return filterIssuesByStatus(await listLatestIssues(root), "todo");
  }

  return [await findLatestIssue(root, reference)];
}

function renderFixLoopTask(
  issues: IndexedVernierIssue[],
  template: AgentTemplate,
  target: string,
  maxAttempts: number,
  tolerance: number,
): string {
  const [firstIssue] = issues;
  const issueTask =
    issues.length === 1 && firstIssue
      ? renderIssueTask(firstIssue, template)
      : renderIssuesTask(issues, template);
  const verifyCommands = issues.map(
    (issue) =>
      `vernier verify ${issue.stableId} --compare --target ${target} --tolerance ${tolerance}`,
  );

  return [
    issueTask.trim(),
    "",
    "Fix-loop contract:",
    "- Make the smallest code changes that address the Vernier evidence.",
    "- Do not mark issues fixed manually; Vernier will remeasure after the agent exits.",
    `- Maximum attempts for this run: ${maxAttempts}.`,
    "- Verification commands Vernier will run:",
    ...verifyCommands.map((command) => `  ${command}`),
    "",
  ].join("\n");
}

function readMaxAttempts(args: string[]): number {
  const value =
    parseArgs(args, { valueOptions: fixLoopValueOptions }).option(
      "--max-attempts",
    ) ?? "1";
  const attempts = Number(value);

  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) {
    throw new VernierError(
      "VERNIER_INVALID_OPTION",
      `Invalid --max-attempts value: ${value}`,
      "Use an integer from 1 to 10.",
    );
  }

  return attempts;
}

function readTolerance(args: string[], config: FixLoopConfig): number {
  const value =
    parseArgs(args, { valueOptions: fixLoopValueOptions }).option(
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

function readAgentTemplate(
  args: string[],
  fallbackAgent: "codex" | "claude",
): AgentTemplate {
  const value =
    parseArgs(args, { valueOptions: fixLoopValueOptions }).option(
      "--template",
    ) ?? fallbackAgent;

  if (
    value === "generic" ||
    value === "codex" ||
    value === "claude" ||
    value === "cursor" ||
    value === "aider" ||
    value === "strict"
  ) {
    return value;
  }

  throw new VernierError(
    "VERNIER_INVALID_OPTION",
    `Invalid --template value: ${value}`,
    "Use generic, codex, claude, cursor, aider, or strict.",
  );
}

function capturedViewport(issue: IndexedVernierIssue): CompareViewport {
  return {
    label: "captured",
    width: issue.session.viewport.width,
    height: issue.session.viewport.height,
    devicePixelRatio: issue.session.viewport.devicePixelRatio,
  };
}

async function runAgent(
  agent: "codex" | "claude",
  task: string,
): Promise<"started" | "missing"> {
  const executable = agent === "codex" ? "codex" : "claude";

  return new Promise((resolve, reject) => {
    const child = spawn(executable, [task], {
      cwd: process.cwd(),
      stdio: "inherit",
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
