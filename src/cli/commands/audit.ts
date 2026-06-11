import type { BoundingBox, LayoutContext, VernierIssue, VernierMeasurement } from "../../schema";
import { listLatestIssues } from "../../core/issues";
import { parseArgs } from "../lib/args";
import { VernierError } from "../lib/errors";

export async function auditLatestSession(root: string, args: string[]): Promise<string> {
  const parsed = parseArgs(args);
  const [kind = "a11y"] = parsed.positionals();

  if (kind !== "a11y" && kind !== "layout") {
    throw new VernierError("VERNIER_INVALID_OPTION", "Usage: vernier audit a11y|layout [--json]", "Use `vernier audit a11y` or `vernier audit layout`.");
  }

  const issues = await listLatestIssues(root);

  if (kind === "layout") {
    const findings = issues.flatMap((issue) => auditIssueLayout(issue.issue, issue.stableId));
    const report: LayoutAuditReport = {
      kind,
      sessionId: issues[0]?.session.sessionId ?? "unknown",
      route: issues[0]?.session.route ?? "unknown",
      checkedIssues: issues.length,
      findingCount: findings.length,
      findings
    };

    return parsed.flag("--json") ? JSON.stringify(report, null, 2) : renderLayoutAudit(report);
  }

  const findings = issues.flatMap((issue) => auditIssueAccessibility(issue.issue, issue.stableId));
  const report: A11yAuditReport = {
    kind: "a11y",
    sessionId: issues[0]?.session.sessionId ?? "unknown",
    route: issues[0]?.session.route ?? "unknown",
    checkedIssues: issues.length,
    findingCount: findings.length,
    findings
  };

  return parsed.flag("--json") ? JSON.stringify(report, null, 2) : renderA11yAudit(report);
}

interface LayoutFinding {
  issueId: string;
  rule: "overflow" | "spacing" | "layout-context";
  severity: "low" | "medium" | "high";
  message: string;
  selector: string;
  expected: string;
  actual: string;
}

interface LayoutAuditReport {
  kind: "layout";
  sessionId: string;
  route: string;
  checkedIssues: number;
  findingCount: number;
  findings: LayoutFinding[];
}

interface A11yFinding {
  issueId: string;
  rule: "contrast" | "tap-target" | "accessible-name";
  severity: "low" | "medium" | "high";
  message: string;
  selector: string;
  expected: string;
  actual: string;
}

interface A11yAuditReport {
  kind: "a11y";
  sessionId: string;
  route: string;
  checkedIssues: number;
  findingCount: number;
  findings: A11yFinding[];
}

function auditIssueAccessibility(issue: VernierIssue, stableId: string): A11yFinding[] {
  const findings: A11yFinding[] = [];
  const measurement = issue.measurement;
  const box = measurementBoundingBox(measurement);
  const computedStyle = measurementComputedStyle(measurement);
  const target = issue.target;
  const selector = issue.selector;

  if (box && isLikelyInteractive(issue)) {
    const minSide = Math.min(box.width, box.height);

    if (minSide < 44) {
      findings.push({
        issueId: stableId,
        rule: "tap-target",
        severity: "medium",
        message: "Interactive target is smaller than the recommended 44px minimum.",
        selector,
        expected: "at least 44x44px",
        actual: `${Math.round(box.width)}x${Math.round(box.height)}px`
      });
    }
  }

  if (isLikelyInteractive(issue) && !target.accessibleName && !target.text) {
    findings.push({
      issueId: stableId,
      rule: "accessible-name",
      severity: "high",
      message: "Interactive target has no captured accessible name or text.",
      selector,
      expected: "accessible name or visible text",
      actual: "missing"
    });
  }

  const color = computedStyle?.color;
  const backgroundColor = computedStyle?.["background-color"];
  const hasText = Boolean(target.text || target.accessibleName || (measurement?.kind === "single" && measurement.text));

  if (hasText && color && backgroundColor) {
    const contrast = contrastRatio(color, backgroundColor);

    if (contrast !== null && contrast < 4.5) {
      findings.push({
        issueId: stableId,
        rule: "contrast",
        severity: contrast < 3 ? "high" : "medium",
        message: "Text contrast is below WCAG AA guidance for normal text.",
        selector,
        expected: "contrast ratio >= 4.5:1",
        actual: `${contrast.toFixed(2)}:1`
      });
    }
  }

  return findings;
}

function renderA11yAudit(report: A11yAuditReport): string {
  const lines = [
    `A11y audit: ${report.route}`,
    `Checked issues: ${report.checkedIssues}`,
    `Findings: ${report.findingCount}`,
    ""
  ];

  if (report.findings.length === 0) {
    lines.push("No accessibility findings from captured Vernier evidence.");
    return lines.join("\n");
  }

  for (const finding of report.findings) {
    lines.push(
      `[${finding.severity}] ${finding.rule} ${finding.issueId}`,
      `Selector: ${finding.selector}`,
      `Expected: ${finding.expected}`,
      `Actual: ${finding.actual}`,
      finding.message,
      ""
    );
  }

  return lines.join("\n").trimEnd();
}

function auditIssueLayout(issue: VernierIssue, stableId: string): LayoutFinding[] {
  const findings: LayoutFinding[] = [];
  const measurement = issue.measurement;
  const context = measurementLayoutContext(measurement);
  const selector = issue.selector;

  if (context?.overflow?.horizontalPageScroll) {
    findings.push({
      issueId: stableId,
      rule: "overflow",
      severity: "high",
      message: "Page had horizontal overflow when this issue was captured.",
      selector,
      expected: "document width fits viewport",
      actual: "horizontal page scroll detected"
    });
  }

  if (context?.overflow?.clippedByParent) {
    findings.push({
      issueId: stableId,
      rule: "overflow",
      severity: "medium",
      message: "Selected element appears clipped by an overflowing parent.",
      selector,
      expected: "element fully visible inside parent",
      actual: `parent overflow ${context.overflow.x}/${context.overflow.y}`
    });
  }

  if (measurement?.kind === "delta") {
    const nonZeroEdges = [
      ["left", measurement.delta.left],
      ["top", measurement.delta.top],
      ["width", measurement.delta.width],
      ["height", measurement.delta.height]
    ].filter(([, value]) => Math.abs(Number(value)) > 1);

    if (nonZeroEdges.length > 0) {
      findings.push({
        issueId: stableId,
        rule: "spacing",
        severity: "medium",
        message: "Compared elements are not aligned or equally sized.",
        selector,
        expected: "deltas within 1px",
        actual: nonZeroEdges.map(([name, value]) => `${name}: ${formatSignedNumber(Number(value))}px`).join(", ")
      });
    }
  }

  if (context?.parentDisplay && !["block", "flow-root", "inline"].includes(context.parentDisplay)) {
    findings.push({
      issueId: stableId,
      rule: "layout-context",
      severity: "low",
      message: "Captured parent layout context may be relevant to the fix.",
      selector,
      expected: "use existing layout system",
      actual: [
        `display: ${context.parentDisplay}`,
        context.parentGap ? `gap: ${context.parentGap}` : null,
        context.parentPadding ? `padding: ${context.parentPadding}` : null
      ].filter(Boolean).join(", ")
    });
  }

  return findings;
}

function renderLayoutAudit(report: LayoutAuditReport): string {
  const lines = [
    `Layout audit: ${report.route}`,
    `Checked issues: ${report.checkedIssues}`,
    `Findings: ${report.findingCount}`,
    ""
  ];

  if (report.findings.length === 0) {
    lines.push("No layout findings from captured Vernier evidence.");
    return lines.join("\n");
  }

  for (const finding of report.findings) {
    lines.push(
      `[${finding.severity}] ${finding.rule} ${finding.issueId}`,
      `Selector: ${finding.selector}`,
      `Expected: ${finding.expected}`,
      `Actual: ${finding.actual}`,
      finding.message,
      ""
    );
  }

  return lines.join("\n").trimEnd();
}

function measurementBoundingBox(measurement: VernierMeasurement | undefined): BoundingBox | null {
  if (!measurement) {
    return null;
  }

  if (measurement.kind === "single") {
    return measurement.bbox;
  }

  if (measurement.kind === "delta") {
    return measurement.targetBbox;
  }

  return null;
}

function measurementComputedStyle(measurement: VernierMeasurement | undefined): Record<string, string> | null {
  if (!measurement) {
    return null;
  }

  if (measurement.kind === "single") {
    return measurement.computedStyle;
  }

  if (measurement.kind === "delta") {
    return {
      color: measurement.delta.color?.[1] ?? "",
      "background-color": measurement.delta.backgroundColor?.[1] ?? "",
      "font-size": measurement.delta.fontSize?.[1] ?? ""
    };
  }

  return null;
}

function measurementLayoutContext(measurement: VernierMeasurement | undefined): LayoutContext | undefined {
  if (!measurement || measurement.kind === "annotation") {
    return undefined;
  }

  return measurement.layoutContext;
}

function isLikelyInteractive(issue: VernierIssue): boolean {
  const target = issue.target;
  const tag = target.tag.toLowerCase();
  const role = target.role?.toLowerCase();

  return ["button", "a", "input", "select", "textarea", "summary"].includes(tag) ||
    ["button", "link", "checkbox", "radio", "switch", "menuitem", "tab"].includes(role ?? "");
}

function contrastRatio(foreground: string, background: string): number | null {
  const fg = parseCssColor(foreground);
  const bg = parseCssColor(background);

  if (!fg || !bg || fg.alpha === 0 || bg.alpha === 0) {
    return null;
  }

  const fgLuminance = relativeLuminance(fg);
  const bgLuminance = relativeLuminance(bg);
  const lighter = Math.max(fgLuminance, bgLuminance);
  const darker = Math.min(fgLuminance, bgLuminance);

  return (lighter + 0.05) / (darker + 0.05);
}

interface ParsedColor {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

function parseCssColor(value: string): ParsedColor | null {
  const normalized = value.trim().toLowerCase();

  if (normalized === "transparent") {
    return { red: 0, green: 0, blue: 0, alpha: 0 };
  }

  const hex = normalized.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/);

  if (hex) {
    return {
      red: Number.parseInt(hex[1]!.slice(0, 2), 16),
      green: Number.parseInt(hex[1]!.slice(2, 4), 16),
      blue: Number.parseInt(hex[1]!.slice(4, 6), 16),
      alpha: hex[2] ? Number.parseInt(hex[2], 16) / 255 : 1
    };
  }

  const rgb = normalized.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([.\d]+))?\)$/);

  if (!rgb) {
    return null;
  }

  return {
    red: Number(rgb[1]),
    green: Number(rgb[2]),
    blue: Number(rgb[3]),
    alpha: rgb[4] === undefined ? 1 : Number(rgb[4])
  };
}

function relativeLuminance(color: ParsedColor): number {
  const channels = [color.red, color.green, color.blue].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });

  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

function formatSignedNumber(value: number): string {
  const rounded = Math.round(value * 100) / 100;

  return rounded > 0 ? `+${rounded}` : String(rounded);
}
