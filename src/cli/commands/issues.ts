import {
  assertLatestIssue,
  type IssueStatus,
  markLatestIssue,
  renameLatestSession,
  updateLatestIssueNote,
} from "../../core/issues";
import { parseArgs } from "../lib/args";
import { VernierError } from "../lib/errors";

export async function markIssue(root: string, args: string[]): Promise<void> {
  const [reference, status] = parseArgs(args).positionals();

  if (!reference || !isIssueStatus(status)) {
    throw new VernierError(
      "VERNIER_INVALID_OPTION",
      "Usage: vernier mark <issue-id> todo|fixed",
      "Use `vernier issues` to find an issue id.",
    );
  }

  const issue = await markLatestIssue(root, reference, status);

  console.log(`Marked ${issue.stableId} ${status}.`);
}

export async function updateIssueNote(
  root: string,
  args: string[],
): Promise<void> {
  const [reference, ...noteParts] = parseArgs(args).positionals();
  const note = noteParts.join(" ").trim();

  if (!reference || !note) {
    throw new VernierError(
      "VERNIER_INVALID_OPTION",
      'Usage: vernier note <issue-id> "updated note"',
      "Use quotes around notes with spaces.",
    );
  }

  const issue = await updateLatestIssueNote(root, reference, note);

  console.log(`Updated ${issue.stableId} note.`);
}

export async function renameSession(
  root: string,
  args: string[],
): Promise<void> {
  const title = parseArgs(args).positionals().join(" ").trim();

  if (!title) {
    throw new VernierError(
      "VERNIER_INVALID_OPTION",
      'Usage: vernier rename-session "short title"',
      "Use a short label that helps you recognize the latest feedback session.",
    );
  }

  const session = await renameLatestSession(root, title);

  console.log(
    `Renamed latest session ${session.sessionId} to "${session.title}".`,
  );
}

export async function assertIssue(root: string, args: string[]): Promise<void> {
  const parsed = parseArgs(args, { valueOptions: ["--tolerance"] });
  const [reference, assignment] = parsed.positionals();
  const separator = assignment?.indexOf("=") ?? -1;

  if (!reference || !assignment || separator <= 0) {
    throw new VernierError(
      "VERNIER_INVALID_OPTION",
      "Usage: vernier assert <issue-id> <property>=<expected> [--tolerance n]",
      "Example: vernier assert i-abc123 width=180 --tolerance 2",
    );
  }

  const toleranceValue = parsed.option("--tolerance");
  const tolerance =
    toleranceValue === undefined ? undefined : Number(toleranceValue);

  if (
    tolerance !== undefined &&
    (!Number.isFinite(tolerance) || tolerance < 0)
  ) {
    throw new VernierError(
      "VERNIER_INVALID_OPTION",
      "--tolerance must be a non-negative number.",
    );
  }

  const property = assignment.slice(0, separator).trim();
  const expected = assignment.slice(separator + 1).trim();

  if (!property || !expected) {
    throw new VernierError(
      "VERNIER_INVALID_OPTION",
      "Assertion property and expected value cannot be empty.",
    );
  }

  const { indexed, assertion } = await assertLatestIssue(
    root,
    reference,
    property,
    expected,
    tolerance,
  );
  const status = assertion.passed ? "passed" : "failed";

  console.log(
    `Assertion ${status} for ${indexed.stableId}: ${assertion.property} actual ${assertion.actual}, expected ${assertion.expected}.`,
  );
}

function isIssueStatus(value: string | undefined): value is IssueStatus {
  return value === "todo" || value === "fixed";
}
