import { readFile } from "node:fs/promises";
import path from "node:path";

export const latestSessionMarkdownPath = path.join(
  ".ui-feedback",
  "latest",
  "session.md",
);

export function createAgentPrompt(sessionMarkdown: string): string {
  return [
    "Use the Vernier UI feedback session below.",
    "Fix each issue with minimal changes.",
    "Map each code change back to an issue number.",
    "Run the smallest relevant checks and summarize verification.",
    "",
    sessionMarkdown.trim(),
    "",
  ].join("\n");
}

export async function readLatestSessionMarkdown(root: string): Promise<string> {
  return readFile(path.join(root, latestSessionMarkdownPath), "utf8");
}
