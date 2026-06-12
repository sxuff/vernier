import { markLatestIssue, renameLatestSession, type IssueStatus, updateLatestIssueNote } from "../../core/issues";
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

export async function renameSession(root: string, args: string[]): Promise<void> {
  const title = parseArgs(args).positionals().join(" ").trim();

  if (!title) {
    throw new VernierError("VERNIER_INVALID_OPTION", "Usage: vernier rename-session \"short title\"", "Use a short label that helps you recognize the latest feedback session.");
  }

  const session = await renameLatestSession(root, title);

  console.log(`Renamed latest session ${session.sessionId} to "${session.title}".`);
}

function isIssueStatus(value: string | undefined): value is IssueStatus {
  return value === "todo" || value === "fixed";
}
