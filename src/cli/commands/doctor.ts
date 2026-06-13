import { access, readFile } from "node:fs/promises";
import path from "node:path";

export async function runDoctor(root: string): Promise<string> {
  const gitignorePath = path.join(root, ".gitignore");
  const lines = ["Vernier doctor", ""];
  let gitignore = "";

  try {
    gitignore = await readFile(gitignorePath, "utf8");
  } catch {
    lines.push("Warning: .gitignore was not found.");
    lines.push(
      "Hint: add .ui-feedback/ so captured screenshots are not committed.",
    );
  }

  if (gitignore) {
    if (gitignoreIgnoresFeedback(gitignore)) {
      lines.push("OK: .ui-feedback is ignored by .gitignore.");
    } else {
      lines.push("Warning: .ui-feedback is not ignored by .gitignore.");
      lines.push(
        "Hint: add .ui-feedback/ so captured screenshots are not committed.",
      );
    }
  }

  const feedbackDirectory = path.join(root, ".ui-feedback");
  try {
    await access(feedbackDirectory);
    lines.push(`OK: feedback directory exists at ${feedbackDirectory}`);
  } catch {
    lines.push("OK: no .ui-feedback directory yet.");
  }

  lines.push(
    "OK: Vernier captures are local files; no network uploads are performed by Vernier.",
  );

  return lines.join("\n");
}

function gitignoreIgnoresFeedback(gitignore: string): boolean {
  let ignored = false;

  for (const rawLine of gitignore.split(/\r?\n/).map((line) => line.trim())) {
    if (!rawLine || rawLine.startsWith("#")) {
      continue;
    }

    const negated = rawLine.startsWith("!");
    const line = negated ? rawLine.slice(1) : rawLine;

    if (matchesFeedbackIgnore(line)) {
      ignored = !negated;
    }
  }

  return ignored;
}

function matchesFeedbackIgnore(line: string): boolean {
  return [
    ".ui-feedback",
    ".ui-feedback/",
    ".ui-feedback/**",
    "/.ui-feedback",
    "/.ui-feedback/",
    "/.ui-feedback/**",
  ].includes(line);
}
