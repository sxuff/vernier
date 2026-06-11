import { spawn } from "node:child_process";
import {
  filterIssuesByStatus,
  findLatestIssue,
  type AgentTemplate,
  type IssueStatus,
  listLatestIssues,
  renderIssueDetail,
  renderIssueList,
  renderIssuePlan,
  renderIssueTask,
  renderIssuesTask
} from "../../core/issues";
import { parseArgs } from "../lib/args";
import { VernierError } from "../lib/errors";

export interface HandoffConfig {
  agents?: {
    default?: "codex" | "claude";
  };
}

export async function listIssuesCommand(root: string, args: string[]): Promise<void> {
  console.log(renderIssueList(filterIssuesByStatus(await listLatestIssues(root), readIssueStatusFilter(args))));
}

export async function showIssueCommand(root: string, args: string[]): Promise<void> {
  console.log(renderIssueDetail(await findLatestIssue(root, readRequiredReference(args, "show"))));
}

export async function copyIssueCommand(root: string, args: string[]): Promise<void> {
  const task = renderIssueTask(await findLatestIssue(root, readRequiredReference(args, "copy")), readAgentTemplate(args));

  if (parseArgs(args).flag("--print")) {
    console.log(task);
    return;
  }

  await copyToClipboard(task);
  console.log("Copied Vernier issue task to clipboard.");
}

export async function planIssueCommand(root: string, args: string[]): Promise<void> {
  console.log(renderIssuePlan(await findLatestIssue(root, readRequiredReference(args, "plan"))));
}

export async function sendIssueToAgent(root: string, args: string[], config: HandoffConfig): Promise<void> {
  const parsed = parseArgs(args, { valueOptions: ["--to", "--template"] });
  const reference = parsed.positionals()[0] ?? "all";
  const agent = parsed.option("--to") ?? process.env.VERNIER_AGENT ?? config.agents?.default;

  if (agent !== "codex" && agent !== "claude") {
    throw new VernierError("VERNIER_INVALID_OPTION", "Usage: vernier send <issue-id> --to codex|claude", "Set agents.default in vernier.config.json or VERNIER_AGENT to avoid passing --to every time.");
  }

  const template = readAgentTemplate(args, agent);
  const task = reference === "all"
    ? await createIssuesSendTask(root, args, template)
    : renderIssueTask(await findLatestIssue(root, reference), template);

  if (parsed.flag("--print")) {
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

async function createIssuesSendTask(root: string, args: string[], template: AgentTemplate): Promise<string> {
  const parsed = parseArgs(args);
  const issues = filterIssuesByStatus(await listLatestIssues(root), parsed.flag("--all") ? "all" : "todo");

  if (issues.length === 0) {
    return parsed.flag("--all")
      ? "No issues in latest Vernier session."
      : "No todo issues in latest Vernier session. Use --all to include fixed issues.";
  }

  return renderIssuesTask(issues, template);
}

function readIssueStatusFilter(args: string[]): IssueStatus | "all" {
  const parsed = parseArgs(args);

  if (parsed.flag("--todo")) {
    return "todo";
  }

  if (parsed.flag("--fixed")) {
    return "fixed";
  }

  return "all";
}

function readAgentTemplate(args: string[], fallbackAgent?: string): AgentTemplate {
  const value = parseArgs(args, { valueOptions: ["--template"] }).option("--template") ?? fallbackAgent ?? "generic";

  if (value === "generic" || value === "codex" || value === "claude" || value === "cursor" || value === "aider" || value === "strict") {
    return value;
  }

  throw new VernierError("VERNIER_INVALID_OPTION", `Invalid --template value: ${value}`, "Use generic, codex, claude, cursor, aider, or strict.");
}

function readRequiredReference(args: string[], command: string): string {
  const reference = parseArgs(args, { valueOptions: ["--template", "--to"] }).positionals()[0];

  if (!reference) {
    throw new VernierError("VERNIER_INVALID_OPTION", `Usage: vernier ${command} <issue-id>`, "Use `vernier issues` to find an issue id.");
  }

  return reference;
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

  throw new VernierError("VERNIER_CLIPBOARD_UNAVAILABLE", "No clipboard command available.", "Run with --print to write the task to stdout.");
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
