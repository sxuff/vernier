import { markLatestIssue, type IssueStatus, updateLatestIssueNote } from "../../core/issues";
import { parseArgs } from "../lib/args";
import { VernierError } from "../lib/errors";

export async function markIssue(root: string, args: string[]): Promise<void> {
  const [reference, status] = parseArgs(args).positionals();

  if (!reference || !isIssueStatus(status)) {
    throw new VernierError("VERNIER_INVALID_OPTION", "Usage: vernier mark <issue-id> todo|fixed", "Use `vernier issues` to find an issue id.");
  }

  const issue = await markLatestIssue(root, reference, status);

  console.log(`Marked ${issue.stableId} ${status}.`);
}

export async function updateIssueNote(root: string, args: string[]): Promise<void> {
  const [reference, ...noteParts] = parseArgs(args).positionals();
  const note = noteParts.join(" ").trim();

  if (!reference || !note) {
    throw new VernierError("VERNIER_INVALID_OPTION", "Usage: vernier note <issue-id> \"updated note\"", "Use quotes around notes with spaces.");
  }

  const issue = await updateLatestIssueNote(root, reference, note);

  console.log(`Updated ${issue.stableId} note.`);
}

function isIssueStatus(value: string | undefined): value is IssueStatus {
  return value === "todo" || value === "fixed";
}
