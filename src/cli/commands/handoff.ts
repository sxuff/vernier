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

  if (args.includes("--print")) {
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
  const reference = readPositionalArgs(args)[0] ?? "all";
  const agent = readOption(args, "--to") ?? process.env.VERNIER_AGENT ?? config.agents?.default;

  if (agent !== "codex" && agent !== "claude") {
    throw new VernierError("VERNIER_INVALID_OPTION", "Usage: vernier send <issue-id> --to codex|claude", "Set agents.default in vernier.config.json or VERNIER_AGENT to avoid passing --to every time.");
  }

  const template = readAgentTemplate(args, agent);
  const task = reference === "all"
    ? await createIssuesSendTask(root, args, template)
    : renderIssueTask(await findLatestIssue(root, reference), template);

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

async function createIssuesSendTask(root: string, args: string[], template: AgentTemplate): Promise<string> {
  const issues = filterIssuesByStatus(await listLatestIssues(root), args.includes("--all") ? "all" : "todo");

  if (issues.length === 0) {
    return args.includes("--all")
      ? "No issues in latest Vernier session."
      : "No todo issues in latest Vernier session. Use --all to include fixed issues.";
  }

  return renderIssuesTask(issues, template);
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

function readOption(args: string[], name: string): string | null {
  const index = args.indexOf(name);

  if (index === -1) {
    return null;
  }

  return args[index + 1] ?? null;
}

function readPositionalArgs(args: string[]): string[] {
  const positional: string[] = [];
  const optionsWithValues = new Set(["--template", "--to"]);

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
