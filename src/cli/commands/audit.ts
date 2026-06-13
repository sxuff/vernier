import { listLatestIssues } from "../../core/issues";
import type {
  BoundingBox,
  LayoutContext,
  StackingContext,
  TextMetrics,
  VernierIssue,
  VernierMeasurement,
} from "../../schema";
import { parseArgs } from "../lib/args";
import { VernierError } from "../lib/errors";

export async function auditLatestSession(
  root: string,
  args: string[],
): Promise<string> {
  const parsed = parseArgs(args);
  const [kind = "a11y"] = parsed.positionals();

  if (kind !== "a11y" && kind !== "layout") {
    throw new VernierError(
      "VERNIER_INVALID_OPTION",
      "Usage: vernier audit a11y|layout [--json]",
      "Use `vernier audit a11y` or `vernier audit layout`.",
    );
  }

  const issues = await listLatestIssues(root);

  if (kind === "layout") {
    const findings = issues.flatMap((issue) =>
      auditIssueLayout(issue.issue, issue.stableId),
    );
    const report: LayoutAuditReport = {
      kind,
      sessionId: issues[0]?.session.sessionId ?? "unknown",
      route: issues[0]?.session.route ?? "unknown",
      checkedIssues: issues.length,
      findingCount: findings.length,
      findings,
    };

    return parsed.flag("--json")
      ? JSON.stringify(report, null, 2)
      : renderLayoutAudit(report);
  }

  const findings = [
    ...issues.flatMap((issue) =>
      auditIssueAccessibility(issue.issue, issue.stableId),
    ),
    ...auditDuplicateIds(
      issues.map((issue) => ({ issue: issue.issue, stableId: issue.stableId })),
    ),
  ];
  const report: A11yAuditReport = {
    kind: "a11y",
    sessionId: issues[0]?.session.sessionId ?? "unknown",
    route: issues[0]?.session.route ?? "unknown",
    checkedIssues: issues.length,
    findingCount: findings.length,
    findings,
  };

  return parsed.flag("--json")
    ? JSON.stringify(report, null, 2)
    : renderA11yAudit(report);
}

interface LayoutFinding {
  issueId: string;
  rule:
    | "overflow"
    | "spacing"
    | "layout-context"
    | "text-overflow"
    | "stacking-context";
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
  rule:
    | "contrast"
    | "tap-target"
    | "accessible-name"
    | "focus-ring"
    | "image-alt"
    | "role-name"
    | "duplicate-id";
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

function auditIssueAccessibility(
  issue: VernierIssue,
  stableId: string,
): A11yFinding[] {
  const findings: A11yFinding[] = [];
  const measurement = issue.measurement;
  const box = measurementBoundingBox(measurement);
  const computedStyle = measurementComputedStyle(measurement);
  const target = issue.target;
  const selector = issue.selector;
  const hasAccessibleName = Boolean(
    target.accessibleName ||
      target.text ||
      (measurement?.kind === "single" &&
        (measurement.accessibleName || measurement.text)),
  );

  if (box && isLikelyInteractive(issue)) {
    const minSide = Math.min(box.width, box.height);

    if (minSide < 44) {
      findings.push({
        issueId: stableId,
        rule: "tap-target",
        severity: "medium",
        message:
          "Interactive target is smaller than the recommended 44px minimum.",
        selector,
        expected: "at least 44x44px",
        actual: `${Math.round(box.width)}x${Math.round(box.height)}px`,
      });
    }
  }

  if (isLikelyInteractive(issue) && !hasAccessibleName) {
    findings.push({
      issueId: stableId,
      rule: "accessible-name",
      severity: "high",
      message: "Interactive target has no captured accessible name or text.",
      selector,
      expected: "accessible name or visible text",
      actual: "missing",
    });
  }

  if (target.tag === "img" && !hasAccessibleName) {
    findings.push({
      issueId: stableId,
      rule: "image-alt",
      severity: "high",
      message: "Image target has no captured alt text or accessible name.",
      selector,
      expected: "meaningful alt text or decorative role/presentation",
      actual: "missing",
    });
  }

  if (
    target.role &&
    roleRequiresAccessibleName(target.role) &&
    !hasAccessibleName
  ) {
    findings.push({
      issueId: stableId,
      rule: "role-name",
      severity: "high",
      message: "Captured ARIA role normally requires an accessible name.",
      selector,
      expected: `${target.role} role with accessible name`,
      actual: "missing",
    });
  }

  const color = computedStyle?.color;
  const backgroundColor = computedStyle?.["background-color"];
  const hasText = hasAccessibleName;

  if (
    isLikelyInteractive(issue) &&
    computedStyle &&
    hasSuppressedFocusRing(computedStyle)
  ) {
    findings.push({
      issueId: stableId,
      rule: "focus-ring",
      severity: "medium",
      message:
        "Interactive target appears to suppress the browser focus indicator.",
      selector,
      expected: "visible focus outline or custom focus style",
      actual: formatFocusRing(computedStyle),
    });
  }

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
        actual: `${contrast.toFixed(2)}:1`,
      });
    }
  }

  return findings;
}

function auditDuplicateIds(
  issues: Array<{ issue: VernierIssue; stableId: string }>,
): A11yFinding[] {
  const occurrences = new Map<
    string,
    Array<{ issueId: string; selector: string; location: string }>
  >();

  for (const { issue, stableId } of issues) {
    const ancestryOccurrences = issue.target.ancestry
      .map((ancestor, index) => ({
        id: ancestor.id,
        location: `${ancestor.tag}${ancestor.testId ? `[data-testid=${ancestor.testId}]` : ""} ancestry[${index}]`,
      }))
      .filter((item): item is { id: string; location: string } =>
        Boolean(item.id),
      );
    const targetAlreadyInAncestry = issue.target.id
      ? ancestryOccurrences.some(
          (occurrence) => occurrence.id === issue.target.id,
        )
      : false;
    const targetOccurrences =
      issue.target.id && !targetAlreadyInAncestry
        ? [{ id: issue.target.id, location: `${issue.target.tag} target` }]
        : [];

    for (const occurrence of [...ancestryOccurrences, ...targetOccurrences]) {
      const list = occurrences.get(occurrence.id) ?? [];
      list.push({
        issueId: stableId,
        selector: issue.selector,
        location: occurrence.location,
      });
      occurrences.set(occurrence.id, list);
    }
  }

  return [...occurrences.entries()].flatMap(([id, matches]) => {
    if (matches.length < 2) {
      return [];
    }

    const first = matches[0];

    return [
      {
        issueId: first.issueId,
        rule: "duplicate-id" as const,
        severity: "high" as const,
        message:
          "Captured DOM evidence contains a duplicate id, which can break labels, selectors, and assistive technology navigation.",
        selector: first.selector,
        expected: `id "${id}" appears once`,
        actual: matches
          .map((match) => `${match.issueId} ${match.location}`)
          .join("; "),
      },
    ];
  });
}

function renderA11yAudit(report: A11yAuditReport): string {
  const lines = [
    `A11y audit: ${report.route}`,
    `Checked issues: ${report.checkedIssues}`,
    `Findings: ${report.findingCount}`,
    "",
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
      "",
    );
  }

  return lines.join("\n").trimEnd();
}

function auditIssueLayout(
  issue: VernierIssue,
  stableId: string,
): LayoutFinding[] {
  const findings: LayoutFinding[] = [];
  const measurement = issue.measurement;
  const context = measurementLayoutContext(measurement);
  const textMetrics = measurementTextMetrics(measurement);
  const stackingContext = measurementStackingContext(measurement);
  const selector = issue.selector;

  if (context?.overflow?.horizontalPageScroll) {
    findings.push({
      issueId: stableId,
      rule: "overflow",
      severity: "high",
      message: "Page had horizontal overflow when this issue was captured.",
      selector,
      expected: "document width fits viewport",
      actual: "horizontal page scroll detected",
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
      actual: `parent overflow ${context.overflow.x}/${context.overflow.y}`,
    });
  }

  if (context?.overflow?.clippedByParent && textMetrics) {
    findings.push({
      issueId: stableId,
      rule: "text-overflow",
      severity: "medium",
      message:
        "Captured text metrics plus parent clipping suggest possible hidden or truncated text.",
      selector,
      expected: "text fully visible or intentionally truncated with affordance",
      actual: [
        `overflow: ${context.overflow.x}/${context.overflow.y}`,
        `text-overflow: ${textMetrics.textOverflow}`,
        `white-space: ${textMetrics.whiteSpace}`,
        textMetrics.renderedLineCount
          ? `lines: ${textMetrics.renderedLineCount}`
          : null,
      ]
        .filter(Boolean)
        .join(", "),
    });
  }

  if (measurement?.kind === "delta") {
    const nonZeroEdges = [
      ["left", measurement.delta.left],
      ["top", measurement.delta.top],
      ["width", measurement.delta.width],
      ["height", measurement.delta.height],
    ].filter(([, value]) => Math.abs(Number(value)) > 1);

    if (nonZeroEdges.length > 0) {
      findings.push({
        issueId: stableId,
        rule: "spacing",
        severity: "medium",
        message: "Compared elements are not aligned or equally sized.",
        selector,
        expected: "deltas within 1px",
        actual: nonZeroEdges
          .map(
            ([name, value]) =>
              `${name}: ${formatSignedNumber(Number(value))}px`,
          )
          .join(", "),
      });
    }
  }

  if (
    context?.parentDisplay &&
    !["block", "flow-root", "inline"].includes(context.parentDisplay)
  ) {
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
        context.parentPadding ? `padding: ${context.parentPadding}` : null,
      ]
        .filter(Boolean)
        .join(", "),
    });
  }

  if (stackingContext && createsStackingContext(stackingContext)) {
    findings.push({
      issueId: stableId,
      rule: "stacking-context",
      severity: "low",
      message:
        "Captured stacking context may affect popovers, overlays, or clipped elements near this issue.",
      selector,
      expected: "z-index and stacking ancestors are intentional",
      actual: [
        `position: ${stackingContext.position}`,
        `z-index: ${stackingContext.zIndex}`,
        `opacity: ${stackingContext.opacity}`,
        `transform: ${stackingContext.transform}`,
        stackingContext.stackingAncestors.length
          ? `ancestors: ${stackingContext.stackingAncestors.length}`
          : null,
      ]
        .filter(Boolean)
        .join(", "),
    });
  }

  return findings;
}

function renderLayoutAudit(report: LayoutAuditReport): string {
  const lines = [
    `Layout audit: ${report.route}`,
    `Checked issues: ${report.checkedIssues}`,
    `Findings: ${report.findingCount}`,
    "",
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
      "",
    );
  }

  return lines.join("\n").trimEnd();
}

function measurementBoundingBox(
  measurement: VernierMeasurement | undefined,
): BoundingBox | null {
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

function measurementComputedStyle(
  measurement: VernierMeasurement | undefined,
): Record<string, string> | null {
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
      "font-size": measurement.delta.fontSize?.[1] ?? "",
    };
  }

  return null;
}

function measurementLayoutContext(
  measurement: VernierMeasurement | undefined,
): LayoutContext | undefined {
  if (!measurement || measurement.kind === "annotation") {
    return undefined;
  }

  return measurement.layoutContext;
}

function measurementTextMetrics(
  measurement: VernierMeasurement | undefined,
): TextMetrics | undefined {
  if (!measurement || measurement.kind === "annotation") {
    return undefined;
  }

  return measurement.textMetrics;
}

function measurementStackingContext(
  measurement: VernierMeasurement | undefined,
): StackingContext | undefined {
  if (!measurement || measurement.kind === "annotation") {
    return undefined;
  }

  return measurement.stackingContext;
}

function isLikelyInteractive(issue: VernierIssue): boolean {
  const target = issue.target;
  const tag = target.tag.toLowerCase();
  const role = target.role?.toLowerCase();

  return (
    ["button", "a", "input", "select", "textarea", "summary"].includes(tag) ||
    [
      "button",
      "link",
      "checkbox",
      "radio",
      "switch",
      "menuitem",
      "tab",
    ].includes(role ?? "")
  );
}

function roleRequiresAccessibleName(role: string): boolean {
  return new Set([
    "button",
    "checkbox",
    "combobox",
    "link",
    "menuitem",
    "radio",
    "searchbox",
    "slider",
    "spinbutton",
    "switch",
    "tab",
    "textbox",
    "treeitem",
  ]).has(role.toLowerCase());
}

function hasSuppressedFocusRing(
  computedStyle: Record<string, string>,
): boolean {
  const outlineStyle = computedStyle["outline-style"]?.toLowerCase();
  const outlineWidth = computedStyle["outline-width"]?.toLowerCase();
  const outline = computedStyle.outline?.toLowerCase();
  const boxShadow = computedStyle["box-shadow"]?.toLowerCase();

  return (
    (outlineStyle === "none" ||
      outlineWidth === "0px" ||
      outline === "none" ||
      outline === "0px none") &&
    (!boxShadow || boxShadow === "none")
  );
}

function formatFocusRing(computedStyle: Record<string, string>): string {
  return (
    [
      computedStyle.outline ? `outline: ${computedStyle.outline}` : null,
      computedStyle["outline-style"]
        ? `outline-style: ${computedStyle["outline-style"]}`
        : null,
      computedStyle["outline-width"]
        ? `outline-width: ${computedStyle["outline-width"]}`
        : null,
      computedStyle["box-shadow"]
        ? `box-shadow: ${computedStyle["box-shadow"]}`
        : null,
    ]
      .filter(Boolean)
      .join(", ") || "outline not captured"
  );
}

function createsStackingContext(context: StackingContext): boolean {
  return (
    context.zIndex !== "auto" ||
    context.opacity !== "1" ||
    context.transform !== "none" ||
    context.isolation === "isolate" ||
    context.stackingAncestors.length > 0
  );
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
    const hexValue = hex[1];

    return {
      red: Number.parseInt(hexValue.slice(0, 2), 16),
      green: Number.parseInt(hexValue.slice(2, 4), 16),
      blue: Number.parseInt(hexValue.slice(4, 6), 16),
      alpha: hex[2] ? Number.parseInt(hex[2], 16) / 255 : 1,
    };
  }

  const rgb = normalized.match(
    /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([.\d]+))?\)$/,
  );

  if (!rgb) {
    return null;
  }

  return {
    red: Number(rgb[1]),
    green: Number(rgb[2]),
    blue: Number(rgb[3]),
    alpha: rgb[4] === undefined ? 1 : Number(rgb[4]),
  };
}

function relativeLuminance(color: ParsedColor): number {
  const [red, green, blue] = [color.red, color.green, color.blue].map(
    (channel) => {
      const normalized = channel / 255;
      return normalized <= 0.03928
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
    },
  );

  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

function formatSignedNumber(value: number): string {
  const rounded = Math.round(value * 100) / 100;

  return rounded > 0 ? `+${rounded}` : String(rounded);
}
