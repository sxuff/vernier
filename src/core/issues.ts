import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { VernierIssue, VernierSession } from "../schema";

export type IssueStatus = "todo" | "fixed";

export interface IndexedVernierIssue {
  stableId: string;
  status: IssueStatus;
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
  const statuses = await readIssueStatuses(latest.sessionDirectory);

  return session.issues.map((issue) => indexIssue(latest.sessionDirectory, session, issue, statuses));
}

export async function findLatestIssue(root: string, reference: string): Promise<IndexedVernierIssue> {
  const issues = await listLatestIssues(root);
  const issue = findIssueByReference(issues, reference);

  if (!issue) {
    throw new Error(`Unknown Vernier issue: ${reference}`);
  }

  return issue;
}

export async function markLatestIssue(root: string, reference: string, status: IssueStatus): Promise<IndexedVernierIssue> {
  const issues = await listLatestIssues(root);
  const issue = findIssueByReference(issues, reference);

  if (!issue) {
    throw new Error(`Unknown Vernier issue: ${reference}`);
  }

  const statuses = await readIssueStatuses(issue.sessionDirectory);
  statuses[issue.stableId] = status;
  await writeIssueStatuses(issue.sessionDirectory, statuses);

  return { ...issue, status };
}

function findIssueByReference(issues: IndexedVernierIssue[], reference: string): IndexedVernierIssue | undefined {
  const exact = issues.find(
    (candidate) => candidate.stableId === reference || String(candidate.issue.id) === reference
  );

  if (exact) {
    return exact;
  }

  const prefixMatches = issues.filter((candidate) => candidate.stableId.startsWith(reference));

  return prefixMatches.length === 1 ? prefixMatches[0] : undefined;
}

export function filterIssuesByStatus(
  issues: IndexedVernierIssue[],
  status: IssueStatus | "all"
): IndexedVernierIssue[] {
  if (status === "all") {
    return issues;
  }

  return issues.filter((issue) => issue.status === status);
}

export function renderIssueList(issues: IndexedVernierIssue[]): string {
  if (issues.length === 0) {
    return "No issues in latest Vernier session.";
  }

  const session = issues[0]?.session;
  const lines = [
    `Latest session: ${session.createdAt}  ${session.route}  ${formatViewport(session)}`,
    "",
    "ID        Status  No.  Page        Viewport   Type        Summary"
  ];

  for (const issue of issues) {
    lines.push(
      [
        issue.stableId.padEnd(9),
        issue.status.padEnd(7),
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
    `Status: ${indexed.status}`,
    "",
    "Instruction:",
    issue.note || "Fix the measured UI issue. Prefer minimal changes.",
    "",
    "Measured:",
    ...issue.measured.split("\n").map((line) => `- ${line}`),
    ...formatStructuredMeasurement(issue),
    ...formatRedactionEvidence(issue),
    "",
    "Target:",
    `Selector: ${issue.selector}`,
    `Selector confidence: ${indexed.issue.target?.selectorConfidence ?? "unknown"}`,
    `Source: ${issue.source}`,
    `Source confidence: ${indexed.issue.target?.sourceConfidence ?? "unknown"}`,
    `Source resolver: ${indexed.issue.target?.sourceResolver ?? "unknown"}`,
    `Component: ${indexed.issue.target?.componentName ?? "unknown"}`,
    `Element: ${formatTarget(indexed)}`,
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
    `Status: ${indexed.status}`,
    `Target route: ${session.route}`,
    `Captured viewport: ${formatViewport(session)}`,
    `Issue type: ${issue.kind}`,
    "",
    "User note:",
    issue.note || "Fix the measured UI issue. Prefer minimal changes.",
    "",
    "Evidence:",
    ...issue.measured.split("\n").map((line) => `- ${line}`),
    ...formatStructuredEvidence(issue),
    ...formatRedactionEvidence(issue),
    `- Selector: ${issue.selector}`,
    `- Selector confidence: ${issue.target?.selectorConfidence ?? "unknown"}${issue.target?.selectorReason ? ` (${issue.target.selectorReason})` : ""}`,
    `- Source: ${issue.source}`,
    `- Source confidence: ${issue.target?.sourceConfidence ?? "unknown"}`,
    `- Source resolver: ${issue.target?.sourceResolver ?? "unknown"}`,
    `- Component: ${issue.target?.componentName ?? "unknown"}`,
    `- Element context: ${formatTarget(indexed)}`,
    `- Screenshot: ${indexed.screenshotPath}`,
    "",
    "Please inspect the related UI code, make the smallest safe fix, and verify at the captured viewport size.",
    "In your summary, map the code change back to this Vernier issue ID."
  ].join("\n");
}

export function renderIssuesTask(issues: IndexedVernierIssue[]): string {
  if (issues.length === 0) {
    return "No issues in latest Vernier session.";
  }

  const session = issues[0]!.session;

  return [
    "Fix the UI issues captured by Vernier.",
    "",
    `Target route: ${session.route}`,
    `Captured viewport: ${formatViewport(session)}`,
    `Issue count: ${issues.length}`,
    "",
    ...issues.flatMap((indexed) => [
      `## ${indexed.stableId} - issue ${indexed.issue.id}`,
      `Type: ${indexed.issue.kind}`,
      `Status: ${indexed.status}`,
      "",
      "User note:",
      indexed.issue.note || "Fix the measured UI issue. Prefer minimal changes.",
      "",
      "Evidence:",
      ...indexed.issue.measured.split("\n").map((line) => `- ${line}`),
      ...formatStructuredEvidence(indexed.issue),
      ...formatRedactionEvidence(indexed.issue),
      `- Selector: ${indexed.issue.selector}`,
      `- Selector confidence: ${indexed.issue.target?.selectorConfidence ?? "unknown"}${indexed.issue.target?.selectorReason ? ` (${indexed.issue.target.selectorReason})` : ""}`,
      `- Source: ${indexed.issue.source}`,
      `- Source confidence: ${indexed.issue.target?.sourceConfidence ?? "unknown"}`,
      `- Source resolver: ${indexed.issue.target?.sourceResolver ?? "unknown"}`,
      `- Component: ${indexed.issue.target?.componentName ?? "unknown"}`,
      `- Element context: ${formatTarget(indexed)}`,
      `- Screenshot: ${indexed.screenshotPath}`,
      ""
    ]),
    "Please inspect the related UI code, make the smallest safe fixes, and verify at the captured viewport size.",
    "In your summary, map each code change back to the relevant Vernier issue ID."
  ].join("\n");
}

export function renderIssueVerification(indexed: IndexedVernierIssue, targetUrl: string): string {
  const { issue, session } = indexed;

  return [
    `Verify Vernier issue ${indexed.stableId}.`,
    "",
    `URL: ${targetUrl}`,
    `Captured viewport: ${formatViewport(session)}`,
    `Status: ${indexed.status}`,
    `Type: ${issue.kind}`,
    "",
    "User note:",
    issue.note || "Fix the measured UI issue. Prefer minimal changes.",
    "",
    "Evidence:",
    ...issue.measured.split("\n").map((line) => `- ${line}`),
    ...formatStructuredEvidence(issue),
    ...formatRedactionEvidence(issue),
    `- Selector: ${issue.selector}`,
    `- Selector confidence: ${issue.target?.selectorConfidence ?? "unknown"}${issue.target?.selectorReason ? ` (${issue.target.selectorReason})` : ""}`,
    `- Source: ${issue.source}`,
    `- Source confidence: ${issue.target?.sourceConfidence ?? "unknown"}`,
    `- Source resolver: ${issue.target?.sourceResolver ?? "unknown"}`,
    `- Component: ${issue.target?.componentName ?? "unknown"}`,
    `- Element context: ${formatTarget(indexed)}`,
    `- Original screenshot: ${indexed.screenshotPath}`,
    "",
    "After inspection:",
    `- Mark fixed: vernier mark ${indexed.stableId} fixed`,
    `- Keep todo: vernier mark ${indexed.stableId} todo`
  ].join("\n");
}

function formatTarget(indexed: IndexedVernierIssue): string {
  const target = indexed.issue.target;

  if (!target) {
    return indexed.issue.selector;
  }

  const parts = [
    target.tag,
    target.testId ? `data-testid=${target.testId}` : null,
    target.id ? `id=${target.id}` : null,
    target.role ? `role=${target.role}` : null,
    target.accessibleName ? `name=${target.accessibleName}` : null,
    target.text ? `text=${target.text}` : null
  ].filter(Boolean);

  return parts.join(" ");
}

function formatStructuredMeasurement(issue: VernierIssue): string[] {
  if (!issue.measurement) {
    return [];
  }

  return ["", "Structured measurement:", JSON.stringify(issue.measurement, null, 2)];
}

function formatStructuredEvidence(issue: VernierIssue): string[] {
  if (!issue.measurement) {
    return [];
  }

  return [`- Structured measurement JSON: ${JSON.stringify(issue.measurement)}`];
}

function formatRedactionEvidence(issue: VernierIssue): string[] {
  if (!issue.redaction || (issue.redaction.autoRedactedElements === 0 && !issue.redaction.manualRedaction)) {
    return [];
  }

  return [
    `- Auto-redacted elements: ${issue.redaction.autoRedactedElements}`,
    `- Manual redaction: ${issue.redaction.manualRedaction ? "yes" : "no"}`
  ];
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

async function readIssueStatuses(sessionDirectory: string): Promise<Record<string, IssueStatus>> {
  try {
    const raw = await readFile(issueStatusesPath(sessionDirectory), "utf8");
    const parsed = JSON.parse(raw) as Record<string, string>;
    const statuses: Record<string, IssueStatus> = {};

    for (const [issueId, status] of Object.entries(parsed)) {
      if (status === "todo" || status === "fixed") {
        statuses[issueId] = status;
      }
    }

    return statuses;
  } catch {
    return {};
  }
}

async function writeIssueStatuses(
  sessionDirectory: string,
  statuses: Record<string, IssueStatus>
): Promise<void> {
  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(issueStatusesPath(sessionDirectory), `${JSON.stringify(statuses, null, 2)}\n`);
}

function issueStatusesPath(sessionDirectory: string): string {
  return path.join(sessionDirectory, "issue-status.json");
}

function indexIssue(
  sessionDirectory: string,
  session: VernierSession,
  issue: VernierIssue,
  statuses: Record<string, IssueStatus>
): IndexedVernierIssue {
  const stableId = issue.stableId ?? createStableIssueId(session, issue);

  return {
    stableId,
    status: statuses[stableId] ?? "todo",
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
