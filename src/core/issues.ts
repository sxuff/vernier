import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { VernierIssue, VernierSession } from "../schema";

export interface IndexedVernierIssue {
  stableId: string;
  session: VernierSession;
  issue: VernierIssue;
  sessionDirectory: string;
  screenshotPath: string;
}

export const latestSessionJsonPath = path.join(".ui-feedback", "latest", "session.json");

export async function readLatestSession(root: string): Promise<VernierSession> {
  const latest = await findLatestSessionFile(root);
  const raw = await readFile(latest.filePath, "utf8");

  return JSON.parse(raw) as VernierSession;
}

export async function listLatestIssues(root: string): Promise<IndexedVernierIssue[]> {
  const latest = await findLatestSessionFile(root);
  const raw = await readFile(latest.filePath, "utf8");
  const session = JSON.parse(raw) as VernierSession;

  return session.issues.map((issue) => indexIssue(latest.sessionDirectory, session, issue));
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

async function findLatestSessionFile(root: string): Promise<{ filePath: string; sessionDirectory: string }> {
  const candidates = await findSessionFiles(root);

  if (candidates.length === 0) {
    throw new Error(`No Vernier session found under ${root}`);
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);

  return {
    filePath: candidates[0]!.filePath,
    sessionDirectory: path.dirname(candidates[0]!.filePath)
  };
}

async function findSessionFiles(
  directory: string,
  candidates: Array<{ filePath: string; mtimeMs: number }> = []
): Promise<Array<{ filePath: string; mtimeMs: number }>> {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    if (shouldSkipDirectory(entry.name)) {
      continue;
    }

    const childDirectory = path.join(directory, entry.name);

    if (entry.name === ".ui-feedback") {
      await collectFeedbackSessions(childDirectory, candidates);
      continue;
    }

    await findSessionFiles(childDirectory, candidates);
  }

  return candidates;
}

async function collectFeedbackSessions(
  feedbackDirectory: string,
  candidates: Array<{ filePath: string; mtimeMs: number }>
): Promise<void> {
  const sessionsDirectory = path.join(feedbackDirectory, "sessions");

  let entries;
  try {
    entries = await readdir(sessionsDirectory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const filePath = path.join(sessionsDirectory, entry.name, "session.json");

    try {
      const fileStat = await stat(filePath);
      candidates.push({ filePath, mtimeMs: fileStat.mtimeMs });
    } catch {
      // Ignore partially written or stale feedback directories.
    }
  }
}

function shouldSkipDirectory(name: string): boolean {
  return [".git", "node_modules", "dist", "build", "test-results"].includes(name);
}

function indexIssue(sessionDirectory: string, session: VernierSession, issue: VernierIssue): IndexedVernierIssue {
  return {
    stableId: createStableIssueId(session, issue),
    session,
    issue,
    sessionDirectory,
    screenshotPath: path.join(sessionDirectory, "screenshots", issue.screenshotName)
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
