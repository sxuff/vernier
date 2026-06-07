import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { VernierIssue, VernierSession } from "../schema";

export interface IndexedVernierIssue {
  stableId: string;
  session: VernierSession;
  issue: VernierIssue;
  screenshotPath: string;
}

export const latestSessionJsonPath = path.join(".ui-feedback", "latest", "session.json");

export async function readLatestSession(root: string): Promise<VernierSession> {
  const raw = await readFile(path.join(root, latestSessionJsonPath), "utf8");

  return JSON.parse(raw) as VernierSession;
}

export async function listLatestIssues(root: string): Promise<IndexedVernierIssue[]> {
  const session = await readLatestSession(root);

  return session.issues.map((issue) => indexIssue(root, session, issue));
}

export async function findLatestIssue(root: string, reference: string): Promise<IndexedVernierIssue> {
  const issues = await listLatestIssues(root);
  const issue = issues.find(
    (candidate) => candidate.stableId === reference || String(candidate.issue.id) === reference
  );

  if (!issue) {
    throw new Error(`Unknown Vernier issue: ${reference}`);
  }

  return issue;
}

export function renderIssueList(issues: IndexedVernierIssue[]): string {
  if (issues.length === 0) {
    return "No issues in latest Vernier session.";
  }

  const session = issues[0]?.session;
  const lines = [
    `Latest session: ${session.createdAt}  ${session.route}  ${formatViewport(session)}`,
    "",
    "ID        No.  Page        Viewport   Type        Summary"
  ];

  for (const issue of issues) {
    lines.push(
      [
        issue.stableId.padEnd(9),
        String(issue.issue.id).padEnd(4),
        issue.session.route.padEnd(11),
        viewportLabel(issue.session).padEnd(10),
        issue.issue.kind.padEnd(11),
        summarizeIssue(issue.issue)
      ].join(" ")
    );
  }

  return lines.join("\n");
}

export function renderIssueDetail(indexed: IndexedVernierIssue): string {
  const { issue, session } = indexed;

  return [
    `ID: ${indexed.stableId}`,
    `Issue: ${issue.id}`,
    `Route: ${session.route}`,
    `Viewport: ${formatViewport(session)}`,
    `Type: ${issue.kind}`,
    "",
    "Instruction:",
    issue.note || "Fix the measured UI issue. Prefer minimal changes.",
    "",
    "Measured:",
    ...issue.measured.split("\n").map((line) => `- ${line}`),
    "",
    "Target:",
    `Selector: ${issue.selector}`,
    `Source: ${issue.source}`,
    "",
    `Screenshot: ${indexed.screenshotPath}`
  ].join("\n");
}

export function renderIssueTask(indexed: IndexedVernierIssue): string {
  const { issue, session } = indexed;

  return [
    "Fix the UI issue captured by Vernier.",
    "",
    `Vernier issue ID: ${indexed.stableId}`,
    `Original issue number: ${issue.id}`,
    `Target route: ${session.route}`,
    `Captured viewport: ${formatViewport(session)}`,
    `Issue type: ${issue.kind}`,
    "",
    "User note:",
    issue.note || "Fix the measured UI issue. Prefer minimal changes.",
    "",
    "Evidence:",
    ...issue.measured.split("\n").map((line) => `- ${line}`),
    `- Selector: ${issue.selector}`,
    `- Source: ${issue.source}`,
    `- Screenshot: ${indexed.screenshotPath}`,
    "",
    "Please inspect the related UI code, make the smallest safe fix, and verify at the captured viewport size.",
    "In your summary, map the code change back to this Vernier issue ID."
  ].join("\n");
}

function indexIssue(root: string, session: VernierSession, issue: VernierIssue): IndexedVernierIssue {
  return {
    stableId: createStableIssueId(session, issue),
    session,
    issue,
    screenshotPath: path.join(root, ".ui-feedback", "latest", "screenshots", issue.screenshotName)
  };
}

function createStableIssueId(session: VernierSession, issue: VernierIssue): string {
  const hash = createHash("sha1")
    .update(
      [
        session.createdAt,
        session.route,
        String(issue.id),
        issue.kind,
        issue.selector,
        issue.source,
        issue.note,
        issue.measured
      ].join("\n")
    )
    .digest("hex")
    .slice(0, 6);

  return `i-${hash}`;
}

function summarizeIssue(issue: VernierIssue): string {
  const note = issue.note.trim();

  if (note) {
    return oneLine(note);
  }

  return oneLine(issue.measured.split("\n")[0] ?? "Measured UI issue");
}

function oneLine(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();

  return compact.length > 72 ? `${compact.slice(0, 69)}...` : compact;
}

function formatViewport(session: VernierSession): string {
  return `${session.viewport.width}x${session.viewport.height} @${session.viewport.devicePixelRatio}x`;
}

function viewportLabel(session: VernierSession): string {
  if (session.viewport.width < 640) {
    return "mobile";
  }

  if (session.viewport.width < 1024) {
    return "tablet";
  }

  return "desktop";
}
