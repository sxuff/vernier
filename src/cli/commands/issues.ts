import { markLatestIssue, type IssueStatus, updateLatestIssueNote } from "../../core/issues";
import { VernierError } from "../lib/errors";

export async function markIssue(root: string, args: string[]): Promise<void> {
  const [reference, status] = readPositionalArgs(args);

  if (!reference || !isIssueStatus(status)) {
    throw new Error("Usage: vernier mark <issue-id> todo|fixed");
  }

  const issue = await markLatestIssue(root, reference, status);

  console.log(`Marked ${issue.stableId} ${status}.`);
}

export async function updateIssueNote(root: string, args: string[]): Promise<void> {
  const [reference, ...noteParts] = readPositionalArgs(args);
  const note = noteParts.join(" ").trim();

  if (!reference || !note) {
    throw new VernierError("VERNIER_INVALID_OPTION", "Usage: vernier note <issue-id> \"updated note\"", "Use quotes around notes with spaces.");
  }

  const issue = await updateLatestIssueNote(root, reference, note);

  console.log(`Updated ${issue.stableId} note.`);
}

function readPositionalArgs(args: string[]): string[] {
  return args.filter((arg) => !arg.startsWith("--"));
}

function isIssueStatus(value: string | undefined): value is IssueStatus {
  return value === "todo" || value === "fixed";
}
