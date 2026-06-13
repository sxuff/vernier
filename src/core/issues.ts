import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { VernierAssertion, VernierIssue, VernierSession } from "../schema";
import { VernierError } from "./errors";
import { renderSessionMarkdown } from "./session-writer";

export type IssueStatus = "todo" | "fixed";
export type AgentTemplate =
  | "generic"
  | "codex"
  | "claude"
  | "cursor"
  | "aider"
  | "strict";

export interface IndexedVernierIssue {
  stableId: string;
  status: IssueStatus;
  session: VernierSession;
  issue: VernierIssue;
  sessionDirectory: string;
  screenshotPath: string;
}

export const latestSessionJsonPath = path.join(
  ".ui-feedback",
  "latest",
  "session.json",
);

export async function readLatestSession(root: string): Promise<VernierSession> {
  const latest = await findLatestSessionFile(root);
  const raw = await readFile(latest.filePath, "utf8");

  return JSON.parse(raw) as VernierSession;
}

export async function listLatestIssues(
  root: string,
): Promise<IndexedVernierIssue[]> {
  const latest = await findLatestSessionFile(root);
  const raw = await readFile(latest.filePath, "utf8");
  const session = JSON.parse(raw) as VernierSession;
  const statuses = await readIssueStatuses(latest.sessionDirectory);

  return session.issues.map((issue) =>
    indexIssue(latest.sessionDirectory, session, issue, statuses),
  );
}

export async function findLatestIssue(
  root: string,
  reference: string,
): Promise<IndexedVernierIssue> {
  const issues = await listLatestIssues(root);
  const issue = findIssueByReference(issues, reference);

  if (!issue) {
    throw unknownIssueError(reference);
  }

  return issue;
}

export async function markLatestIssue(
  root: string,
  reference: string,
  status: IssueStatus,
): Promise<IndexedVernierIssue> {
  const issues = await listLatestIssues(root);
  const issue = findIssueByReference(issues, reference);

  if (!issue) {
    throw unknownIssueError(reference);
  }

  const statuses = await readIssueStatuses(issue.sessionDirectory);
  statuses[issue.stableId] = status;
  await writeIssueStatuses(issue.sessionDirectory, statuses);

  return { ...issue, status };
}

export async function updateLatestIssueNote(
  root: string,
  reference: string,
  note: string,
): Promise<IndexedVernierIssue> {
  const latest = await findLatestSessionFile(root);
  const raw = await readFile(latest.filePath, "utf8");
  const session = JSON.parse(raw) as VernierSession;
  const statuses = await readIssueStatuses(latest.sessionDirectory);
  const issues = session.issues.map((issue) =>
    indexIssue(latest.sessionDirectory, session, issue, statuses),
  );
  const indexed = findIssueByReference(issues, reference);

  if (!indexed) {
    throw unknownIssueError(reference);
  }

  indexed.issue.note = note.trim();
  await writeFile(latest.filePath, `${JSON.stringify(session, null, 2)}\n`);
  await writeFile(
    path.join(latest.sessionDirectory, "session.md"),
    renderSessionMarkdown(session),
  );

  return indexIssue(latest.sessionDirectory, session, indexed.issue, statuses);
}

export async function assertLatestIssue(
  root: string,
  reference: string,
  property: string,
  expected: string,
  tolerance?: number,
): Promise<{ indexed: IndexedVernierIssue; assertion: VernierAssertion }> {
  const latest = await findLatestSessionFile(root);
  const raw = await readFile(latest.filePath, "utf8");
  const session = JSON.parse(raw) as VernierSession;
  const statuses = await readIssueStatuses(latest.sessionDirectory);
  const issues = session.issues.map((issue) =>
    indexIssue(latest.sessionDirectory, session, issue, statuses),
  );
  const indexed = findIssueByReference(issues, reference);

  if (!indexed) {
    throw unknownIssueError(reference);
  }

  const actual = readMeasuredProperty(indexed.issue, property);

  if (actual === undefined) {
    throw new VernierError(
      "VERNIER_UNKNOWN_ASSERTION_PROPERTY",
      `Cannot assert unknown property: ${property}`,
      "Use a measured property such as width, height, padding, background-color, or delta.left.",
    );
  }

  const assertion = createAssertion(property, expected, actual, tolerance);
  indexed.issue.assertions = [
    ...(indexed.issue.assertions ?? []).filter(
      (candidate) => candidate.property !== property,
    ),
    assertion,
  ];
  await writeFile(latest.filePath, `${JSON.stringify(session, null, 2)}\n`);
  await writeFile(
    path.join(latest.sessionDirectory, "session.md"),
    renderSessionMarkdown(session),
  );

  return {
    indexed: indexIssue(
      latest.sessionDirectory,
      session,
      indexed.issue,
      statuses,
    ),
    assertion,
  };
}

export async function renameLatestSession(
  root: string,
  title: string,
): Promise<VernierSession> {
  const latest = await findLatestSessionFile(root);
  const raw = await readFile(latest.filePath, "utf8");
  const session = JSON.parse(raw) as VernierSession;
  const trimmed = title.trim();

  if (!trimmed) {
    throw new VernierError(
      "VERNIER_INVALID_OPTION",
      "Session title cannot be empty.",
      "Pass a short label, for example `vernier rename-session pricing mobile pass`.",
    );
  }

  session.title = trimmed;
  await writeFile(latest.filePath, `${JSON.stringify(session, null, 2)}\n`);
  await writeFile(
    path.join(latest.sessionDirectory, "session.md"),
    renderSessionMarkdown(session),
  );

  return session;
}

function findIssueByReference(
  issues: IndexedVernierIssue[],
  reference: string,
): IndexedVernierIssue | undefined {
  const exact = issues.find(
    (candidate) =>
      candidate.stableId === reference ||
      String(candidate.issue.id) === reference,
  );

  if (exact) {
    return exact;
  }

  const prefixMatches = issues.filter((candidate) =>
    candidate.stableId.startsWith(reference),
  );

  return prefixMatches.length === 1 ? prefixMatches[0] : undefined;
}

export function filterIssuesByStatus(
  issues: IndexedVernierIssue[],
  status: IssueStatus | "all",
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
    `Latest session: ${session.title ? `${session.title}  ` : ""}${session.createdAt}  ${session.route}  ${formatViewport(session)}`,
    "",
    "ID        Status  No.  Page        Viewport   Type        Summary",
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
        summarizeIssue(issue.issue),
      ].join(" "),
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
    ...formatMeasuredEvidence(issue),
    ...formatStructuredMeasurement(issue),
    ...formatAssertions(issue, false),
    ...formatSuggestions(issue, false),
    ...formatRedactionEvidence(issue),
    "",
    "Target:",
    `Selector: ${issue.selector}`,
    ...formatTargetEvidence(issue),
    `Selector confidence: ${indexed.issue.target?.selectorConfidence ?? "unknown"}`,
    `Source: ${issue.source}`,
    `Source confidence: ${indexed.issue.target?.sourceConfidence ?? "unknown"}`,
    `Source resolver: ${indexed.issue.target?.sourceResolver ?? "unknown"}`,
    `Component: ${indexed.issue.target?.componentName ?? "unknown"}`,
    `Element: ${formatTarget(indexed)}`,
    "",
    `Screenshot: ${indexed.screenshotPath}`,
  ].join("\n");
}

export function renderIssueTask(
  indexed: IndexedVernierIssue,
  template: AgentTemplate = "generic",
): string {
  const { issue, session } = indexed;

  return [
    ...templatePreamble(template, false),
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
    ...formatMeasuredEvidence(issue),
    ...formatStructuredEvidence(issue),
    ...formatAssertions(issue, true),
    ...formatSuggestions(issue, true),
    ...formatRedactionEvidence(issue),
    `- Selector: ${issue.selector}`,
    ...formatTargetEvidence(issue).map((line) => `- ${line}`),
    `- Selector confidence: ${issue.target?.selectorConfidence ?? "unknown"}${issue.target?.selectorReason ? ` (${issue.target.selectorReason})` : ""}`,
    `- Source: ${issue.source}`,
    `- Source confidence: ${issue.target?.sourceConfidence ?? "unknown"}`,
    `- Source resolver: ${issue.target?.sourceResolver ?? "unknown"}`,
    `- Component: ${issue.target?.componentName ?? "unknown"}`,
    `- Element context: ${formatTarget(indexed)}`,
    `- Screenshot: ${indexed.screenshotPath}`,
    "",
    "Please inspect the related UI code, make the smallest safe fix, and verify at the captured viewport size.",
    "In your summary, map the code change back to this Vernier issue ID.",
    ...templatePostscript(template),
  ].join("\n");
}

export function renderIssuePacket(indexed: IndexedVernierIssue): string {
  const { issue, session } = indexed;

  return [
    `# Vernier Reproduction Packet - ${indexed.stableId}`,
    "",
    "## Summary",
    `- Status: ${indexed.status}`,
    `- Route: ${session.route}`,
    `- URL: ${session.url}`,
    `- Viewport: ${formatViewport(session)}`,
    `- Issue type: ${issue.kind}`,
    "",
    "## User Note",
    issue.note || "Fix the measured UI issue. Prefer minimal changes.",
    "",
    "## Target",
    `- Selector: ${issue.selector}`,
    ...formatTargetEvidence(issue).map((line) => `- ${line}`),
    `- Selector confidence: ${issue.target?.selectorConfidence ?? "unknown"}${issue.target?.selectorReason ? ` (${issue.target.selectorReason})` : ""}`,
    `- Source: ${issue.source}`,
    `- Source confidence: ${issue.target?.sourceConfidence ?? "unknown"}`,
    `- Source resolver: ${issue.target?.sourceResolver ?? "unknown"}`,
    `- Component: ${issue.target?.componentName ?? "unknown"}`,
    `- Element context: ${formatTarget(indexed)}`,
    "",
    "## Evidence",
    ...formatMeasuredEvidence(issue),
    ...formatAssertions(issue, true),
    ...formatSuggestions(issue, true),
    ...formatRedactionEvidence(issue),
    `- Screenshot: ${indexed.screenshotPath}`,
    "",
    "## Verify",
    `- Command: vernier verify ${indexed.stableId} --compare`,
    `- Mark fixed: vernier mark ${indexed.stableId} fixed`,
    `- Mark todo: vernier mark ${indexed.stableId} todo`,
    "",
  ].join("\n");
}

export function renderIssuesTask(
  issues: IndexedVernierIssue[],
  template: AgentTemplate = "generic",
): string {
  if (issues.length === 0) {
    return "No issues in latest Vernier session.";
  }

  const [firstIssue] = issues;
  const session = firstIssue.session;

  return [
    ...templatePreamble(template, true),
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
      indexed.issue.note ||
        "Fix the measured UI issue. Prefer minimal changes.",
      "",
      "Evidence:",
      ...formatMeasuredEvidence(indexed.issue),
      ...formatStructuredEvidence(indexed.issue),
      ...formatAssertions(indexed.issue, true),
      ...formatSuggestions(indexed.issue, true),
      ...formatRedactionEvidence(indexed.issue),
      `- Selector: ${indexed.issue.selector}`,
      ...formatTargetEvidence(indexed.issue).map((line) => `- ${line}`),
      `- Selector confidence: ${indexed.issue.target?.selectorConfidence ?? "unknown"}${indexed.issue.target?.selectorReason ? ` (${indexed.issue.target.selectorReason})` : ""}`,
      `- Source: ${indexed.issue.source}`,
      `- Source confidence: ${indexed.issue.target?.sourceConfidence ?? "unknown"}`,
      `- Source resolver: ${indexed.issue.target?.sourceResolver ?? "unknown"}`,
      `- Component: ${indexed.issue.target?.componentName ?? "unknown"}`,
      `- Element context: ${formatTarget(indexed)}`,
      `- Screenshot: ${indexed.screenshotPath}`,
      "",
    ]),
    "Please inspect the related UI code, make the smallest safe fixes, and verify at the captured viewport size.",
    "In your summary, map each code change back to the relevant Vernier issue ID.",
    ...templatePostscript(template),
  ].join("\n");
}

export function renderIssuePlan(indexed: IndexedVernierIssue): string {
  const { issue, session } = indexed;
  const sourceConfidence = issue.target?.sourceConfidence ?? "unknown";
  const selectorConfidence = issue.target?.selectorConfidence ?? "unknown";
  const likelySource =
    issue.source && issue.source !== "unresolved"
      ? issue.source
      : issue.target?.componentName
        ? `component ${issue.target.componentName}`
        : "source unresolved; search by selector, text, component hints, or ancestry";

  return [
    `Vernier patch plan for ${indexed.stableId}`,
    "",
    `Likely source: ${likelySource}`,
    `Likely change type: ${likelyChangeType(issue)}`,
    `Evidence confidence: ${combinedConfidence(selectorConfidence, sourceConfidence)}`,
    `Selector confidence: ${selectorConfidence}${issue.target?.selectorReason ? ` (${issue.target.selectorReason})` : ""}`,
    `Source confidence: ${sourceConfidence}`,
    `Route: ${session.route}`,
    `Viewport: ${formatViewport(session)}`,
    "",
    "Suggested approach:",
    ...suggestedPlanSteps(indexed).map((step) => `- ${step}`),
    "",
    "Suggested checks:",
    "- Run the smallest relevant typecheck/build command for the touched package.",
    `- Run: vernier verify ${indexed.stableId} --compare --target <local-app-url>`,
    `- Mark fixed: vernier mark ${indexed.stableId} fixed`,
  ].join("\n");
}

function templatePreamble(template: AgentTemplate, batch: boolean): string[] {
  if (template === "generic") {
    return [];
  }

  const count = batch ? "issues" : "issue";
  const common = [`Template: ${template}`, ""];

  if (template === "codex") {
    return [
      ...common,
      "Codex instructions:",
      `- Treat the Vernier ${count} as concrete UI repair evidence.`,
      "- Inspect the existing code before editing.",
      "- Prefer small, local changes and run relevant checks.",
      "",
    ];
  }

  if (template === "claude") {
    return [
      ...common,
      "Claude Code instructions:",
      `- Use the Vernier ${count} as visual evidence and preserve the user's intent.`,
      "- Explain uncertainty when selector/source confidence is low.",
      "- Keep the final summary issue-ID mapped.",
      "",
    ];
  }

  if (template === "cursor") {
    return [
      ...common,
      "Cursor instructions:",
      "- Use the selector/source evidence to open the closest relevant files.",
      "- Prefer existing components, CSS variables, utility classes, and design tokens.",
      "",
    ];
  }

  if (template === "aider") {
    return [
      ...common,
      "Aider instructions:",
      "- Identify the likely files first, then make the smallest patch.",
      "- Avoid broad rewrites unless the evidence shows a shared style bug.",
      "",
    ];
  }

  return [
    ...common,
    "Strict repair contract:",
    "- Do not change unrelated behavior.",
    "- Do not invent new design values when token/class evidence exists.",
    "- Verify the fix or state exactly why verification was not run.",
    "",
  ];
}

function templatePostscript(template: AgentTemplate): string[] {
  if (template === "generic") {
    return [];
  }

  return [
    "",
    "Template-specific output:",
    "- List files changed.",
    "- Map each change to the Vernier issue ID.",
    "- Include the check command and result.",
  ];
}

export function renderGitHubIssueTitle(indexed: IndexedVernierIssue): string {
  return `[Vernier] ${summarizeIssue(indexed.issue)}`;
}

export function renderGitHubIssueBody(indexed: IndexedVernierIssue): string {
  const { issue, session } = indexed;

  return [
    "## Vernier UI Feedback",
    "",
    `- Vernier issue ID: ${indexed.stableId}`,
    `- Original issue number: ${issue.id}`,
    `- Status: ${indexed.status}`,
    `- Route: ${session.route}`,
    `- URL: ${session.url}`,
    `- Viewport: ${formatViewport(session)}`,
    `- Type: ${issue.kind}`,
    "",
    "## User Note",
    "",
    issue.note || "Fix the measured UI issue. Prefer minimal changes.",
    "",
    "## Target",
    "",
    `- Selector: \`${issue.selector}\``,
    ...formatTargetEvidence(issue).map((line) => `- ${line}`),
    `- Selector confidence: ${issue.target?.selectorConfidence ?? "unknown"}${issue.target?.selectorReason ? ` (${issue.target.selectorReason})` : ""}`,
    `- Source: ${issue.source}`,
    `- Source confidence: ${issue.target?.sourceConfidence ?? "unknown"}`,
    `- Source resolver: ${issue.target?.sourceResolver ?? "unknown"}`,
    `- Component: ${issue.target?.componentName ?? "unknown"}`,
    `- Element context: ${formatTarget(indexed)}`,
    "",
    "## Evidence",
    "",
    ...formatMeasuredEvidence(issue),
    ...formatAssertions(issue, true),
    ...formatSuggestions(issue, true),
    ...formatRedactionEvidence(issue),
    `- Screenshot: \`${path.relative(process.cwd(), indexed.screenshotPath)}\``,
    "",
    "<details>",
    "<summary>Structured measurement JSON</summary>",
    "",
    "```json",
    JSON.stringify(issue.measurement ?? issue.target, null, 2),
    "```",
    "",
    "</details>",
    "",
    "## Reproduction",
    "",
    `1. Open \`${session.url}\`.`,
    `2. Set the viewport to ${formatViewport(session)}.`,
    "3. Inspect the selector and screenshot above.",
    "",
    "## Verification",
    "",
    `- Run: \`vernier verify ${indexed.stableId} --compare --target <local-app-url>\``,
    `- Mark fixed: \`vernier mark ${indexed.stableId} fixed\``,
  ].join("\n");
}

export function renderIssueVerification(
  indexed: IndexedVernierIssue,
  targetUrl: string,
): string {
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
    ...formatMeasuredEvidence(issue),
    ...formatStructuredEvidence(issue),
    ...formatAssertions(issue, true),
    ...formatSuggestions(issue, true),
    ...formatRedactionEvidence(issue),
    `- Selector: ${issue.selector}`,
    ...formatTargetEvidence(issue).map((line) => `- ${line}`),
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
    `- Keep todo: vernier mark ${indexed.stableId} todo`,
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
    target.text ? `text=${target.text}` : null,
  ].filter(Boolean);

  return parts.join(" ");
}

function formatTargetEvidence(issue: VernierIssue): string[] {
  const target = issue.target;

  if (!target) {
    return [];
  }

  return [
    target.fallbackSelector
      ? `Fallback selector: ${target.fallbackSelector}`
      : null,
    target.nearestLandmark
      ? `Nearest landmark: ${target.nearestLandmark}`
      : null,
  ].filter((line): line is string => line !== null);
}

function formatMeasuredEvidence(issue: VernierIssue): string[] {
  const lines = issue.measured.split("\n");
  const suggestionStart = issue.suggestions?.length
    ? lines.indexOf("Suggestions:")
    : -1;
  const measuredLines =
    suggestionStart >= 0 ? lines.slice(0, suggestionStart) : lines;

  return measuredLines.map((line) => `- ${line}`);
}

function formatStructuredMeasurement(issue: VernierIssue): string[] {
  if (!issue.measurement) {
    return [];
  }

  return [
    "",
    "Structured measurement:",
    JSON.stringify(issue.measurement, null, 2),
  ];
}

function formatStructuredEvidence(issue: VernierIssue): string[] {
  if (!issue.measurement) {
    return [];
  }

  return [
    `- Structured measurement JSON: ${JSON.stringify(issue.measurement)}`,
  ];
}

function formatAssertions(issue: VernierIssue, bullet: boolean): string[] {
  const assertions = issue.assertions ?? [];

  if (assertions.length === 0) {
    return [];
  }

  const prefix = bullet ? "- " : "";
  return [
    "",
    `${bullet ? "- " : ""}Assertions:`,
    ...assertions.map((assertion) => {
      const tolerance =
        assertion.tolerance === undefined ? "" : ` +/-${assertion.tolerance}`;
      const status = assertion.passed ? "pass" : "fail";
      return `${prefix}${assertion.property}: actual ${assertion.actual}, expected ${assertion.expected}${tolerance} (${status})`;
    }),
  ];
}

function formatSuggestions(issue: VernierIssue, bullet: boolean): string[] {
  const suggestions = issue.suggestions ?? [];

  if (suggestions.length === 0) {
    return [];
  }

  const prefix = bullet ? "- " : "";
  return [
    "",
    `${bullet ? "- " : ""}Suggestions:`,
    ...suggestions.map(
      (suggestion) =>
        `${prefix}[${suggestion.severity}] ${suggestion.type}: ${suggestion.message} Expected ${suggestion.expected}; actual ${suggestion.actual}.`,
    ),
  ];
}

function createAssertion(
  property: string,
  expected: string,
  actual: string,
  tolerance: number | undefined,
): VernierAssertion {
  const actualNumber = parseNumeric(actual);
  const expectedNumber = parseNumeric(expected);
  const passed =
    actualNumber !== null && expectedNumber !== null
      ? Math.abs(actualNumber - expectedNumber) <= (tolerance ?? 0)
      : actual.trim() === expected.trim();

  return {
    property,
    expected,
    actual,
    tolerance,
    passed,
    createdAt: new Date().toISOString(),
  };
}

function readMeasuredProperty(
  issue: VernierIssue,
  property: string,
): string | undefined {
  const measurement = issue.measurement;

  if (!measurement) {
    return undefined;
  }

  if (measurement.kind === "single") {
    if (property in measurement.bbox) {
      return String(
        measurement.bbox[property as keyof typeof measurement.bbox],
      );
    }

    if (property.startsWith("bbox.")) {
      const key = property.slice("bbox.".length);
      return key in measurement.bbox
        ? String(measurement.bbox[key as keyof typeof measurement.bbox])
        : undefined;
    }

    if (property.startsWith("computedStyle.")) {
      return measurement.computedStyle[property.slice("computedStyle.".length)];
    }

    if (measurement.computedStyle[property] !== undefined) {
      return measurement.computedStyle[property];
    }

    if (measurement.textMetrics && property.startsWith("textMetrics.")) {
      const key = property.slice(
        "textMetrics.".length,
      ) as keyof typeof measurement.textMetrics;
      const value = measurement.textMetrics[key];
      return value === undefined ? undefined : String(value);
    }
  }

  if (measurement.kind === "delta") {
    const deltaProperty = property.startsWith("delta.")
      ? property.slice("delta.".length)
      : property;
    const value =
      measurement.delta[deltaProperty as keyof typeof measurement.delta];
    return typeof value === "number" || typeof value === "string"
      ? String(value)
      : undefined;
  }

  if (measurement.kind === "annotation" && property.startsWith("bounds.")) {
    const key = property.slice("bounds.".length);
    return key in measurement.bounds
      ? String(measurement.bounds[key as keyof typeof measurement.bounds])
      : undefined;
  }

  return undefined;
}

function parseNumeric(value: string): number | null {
  const match = value.trim().match(/^(-?\d+(?:\.\d+)?)(?:px)?$/);
  return match ? Number(match[1]) : null;
}

function likelyChangeType(issue: VernierIssue): string {
  const measurement = issue.measurement;

  if (!measurement) {
    return "manual UI inspection";
  }

  if (measurement.kind === "annotation") {
    return measurement.label
      ? `annotation: ${measurement.label}`
      : "annotation-guided visual fix";
  }

  if (measurement.kind === "delta") {
    const deltas = [
      Math.abs(measurement.delta.left),
      Math.abs(measurement.delta.top),
      Math.abs(measurement.delta.width),
      Math.abs(measurement.delta.height),
    ];

    if (deltas.some((delta) => delta >= 2)) {
      return "layout/spacing/alignment";
    }
  }

  const tokenHints =
    measurement.kind === "single"
      ? measurement.designTokenHints
      : measurement.designTokenHints;
  const classHints =
    measurement.kind === "single"
      ? measurement.classHints
      : measurement.classHints;

  if (tokenHints.length > 0 || classHints.length > 0) {
    return "style token/class adjustment";
  }

  if (measurement.kind === "single" && measurement.textMetrics) {
    return "text styling/typography";
  }

  if (
    measurement.kind === "single" &&
    measurement.layoutContext?.overflow?.clippedByParent
  ) {
    return "overflow/clipping";
  }

  return "component styling";
}

function combinedConfidence(
  selectorConfidence: string,
  sourceConfidence: string,
): "high" | "medium" | "low" {
  if (
    selectorConfidence === "high" &&
    (sourceConfidence === "high" || sourceConfidence === "medium")
  ) {
    return "high";
  }

  if (
    selectorConfidence === "low" ||
    sourceConfidence === "low" ||
    sourceConfidence === "unknown"
  ) {
    return "low";
  }

  return "medium";
}

function suggestedPlanSteps(indexed: IndexedVernierIssue): string[] {
  const issue = indexed.issue;
  const steps = [
    issue.source && issue.source !== "unresolved"
      ? `Start at ${issue.source}.`
      : `Search for ${issue.target?.testId ? `data-testid="${issue.target.testId}"` : issue.selector} and nearby text/component hints.`,
    "Compare the captured evidence against the current implementation.",
    "Prefer existing design tokens, utility classes, and authored CSS hints from the structured measurement.",
    "Make the smallest targeted change.",
  ];

  if (issue.target?.selectorConfidence === "low") {
    steps.splice(
      1,
      0,
      "Treat the selector as brittle; confirm the target by text, ancestry, screenshot, and source hints before editing.",
    );
  }

  if (issue.measurement?.kind === "delta") {
    steps.splice(
      2,
      0,
      "Check the parent layout system before changing individual offsets.",
    );
  }

  return steps;
}

function formatRedactionEvidence(issue: VernierIssue): string[] {
  if (
    !issue.redaction ||
    (issue.redaction.autoRedactedElements === 0 &&
      !issue.redaction.manualRedaction)
  ) {
    return [];
  }

  return [
    `- Auto-redacted elements: ${issue.redaction.autoRedactedElements}`,
    `- Manual redaction: ${issue.redaction.manualRedaction ? "yes" : "no"}`,
  ];
}

async function findLatestSessionFile(
  root: string,
): Promise<{ filePath: string; sessionDirectory: string }> {
  const candidates = await findSessionFiles(root);

  if (candidates.length === 0) {
    throw new VernierError(
      "VERNIER_NO_SESSION",
      `No Vernier session found under ${root}`,
      "Open your app with Vernier, add an issue, then export a session.",
    );
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);

  const latest = candidates[0];

  return {
    filePath: latest.filePath,
    sessionDirectory: path.dirname(latest.filePath),
  };
}

function unknownIssueError(reference: string): VernierError {
  return new VernierError(
    "VERNIER_UNKNOWN_ISSUE",
    `Unknown Vernier issue: ${reference}`,
    "Run `vernier issues` to list stable issue IDs from the latest session.",
  );
}

async function findSessionFiles(
  directory: string,
  candidates: Array<{ filePath: string; mtimeMs: number }> = [],
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
  candidates: Array<{ filePath: string; mtimeMs: number }>,
): Promise<void> {
  const sessionsDirectory = path.join(feedbackDirectory, "sessions");

  let entries: Dirent[];
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
  return [".git", "node_modules", "dist", "build", "test-results"].includes(
    name,
  );
}

async function readIssueStatuses(
  sessionDirectory: string,
): Promise<Record<string, IssueStatus>> {
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
  statuses: Record<string, IssueStatus>,
): Promise<void> {
  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(
    issueStatusesPath(sessionDirectory),
    `${JSON.stringify(statuses, null, 2)}\n`,
  );
}

function issueStatusesPath(sessionDirectory: string): string {
  return path.join(sessionDirectory, "issue-status.json");
}

function indexIssue(
  sessionDirectory: string,
  session: VernierSession,
  issue: VernierIssue,
  statuses: Record<string, IssueStatus>,
): IndexedVernierIssue {
  const stableId = issue.stableId ?? createStableIssueId(session, issue);

  return {
    stableId,
    status: statuses[stableId] ?? "todo",
    session,
    issue,
    sessionDirectory,
    screenshotPath: path.join(
      sessionDirectory,
      "screenshots",
      issue.screenshotName,
    ),
  };
}

function createStableIssueId(
  session: VernierSession,
  issue: VernierIssue,
): string {
  const hash = createHash("sha1")
    .update(
      [
        session.createdAt,
        session.route,
        String(issue.id),
        issue.kind,
        issue.selector,
        issue.source,
      ].join("\n"),
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
