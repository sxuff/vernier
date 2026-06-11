import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  filterIssuesByStatus,
  findLatestIssue,
  listLatestIssues,
  renderGitHubIssueBody,
  renderGitHubIssueTitle
} from "../../core/issues";
import { VernierError } from "../lib/errors";

export async function handleGitHubCommand(root: string, args: string[]): Promise<void> {
  const [action = "body", reference = "all"] = readPositionalArgs(args);

  if (action !== "body" && action !== "create") {
    throw new VernierError("VERNIER_INVALID_OPTION", "Usage: vernier github body|create [all|<issue-id>] [--label ui-feedback]", "Use `vernier github body <issue-id>` to preview without network.");
  }

  const issues = await resolveGitHubIssues(root, reference);

  if (action === "body") {
    console.log(renderGitHubIssuesPreview(issues));
    return;
  }

  await createGitHubIssues(issues, readOption(args, "--label") ?? "ui-feedback");
}

async function resolveGitHubIssues(root: string, reference: string): Promise<Awaited<ReturnType<typeof listLatestIssues>>> {
  if (reference === "all") {
    return filterIssuesByStatus(await listLatestIssues(root), "todo");
  }

  return [await findLatestIssue(root, reference)];
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

function readOption(args: string[], name: string): string | null {
  const index = args.indexOf(name);

  if (index === -1) {
    return null;
  }

  return args[index + 1] ?? null;
}

function readPositionalArgs(args: string[]): string[] {
  return args.filter((arg) => !arg.startsWith("--"));
}
