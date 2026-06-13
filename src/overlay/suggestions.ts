import type { SingleMeasurement, VernierSuggestion } from "../schema";

export interface SuggestionInput {
  tag: string;
  role?: string;
  accessibleName?: string;
  text?: string;
  measurement: SingleMeasurement;
}

export function createElementSuggestions(
  element: Element,
  measurement: SingleMeasurement,
): VernierSuggestion[] {
  return auditElementMeasurement({
    tag: element.tagName.toLowerCase(),
    role: element.getAttribute("role") ?? measurement.role,
    accessibleName: measurement.accessibleName,
    text: measurement.text,
    measurement,
  });
}

export function auditElementMeasurement(
  input: SuggestionInput,
): VernierSuggestion[] {
  const suggestions: VernierSuggestion[] = [];
  const interactive = isLikelyInteractive(input.tag, input.role);
  const hasName = Boolean(input.accessibleName || input.text);
  const box = input.measurement.bbox;
  const styles = input.measurement.computedStyle;

  if (interactive && Math.min(box.width, box.height) < 44) {
    suggestions.push({
      type: "tap-target",
      severity: "medium",
      message: "Interactive target is smaller than common touch guidance.",
      expected: "at least 44x44px",
      actual: `${Math.round(box.width)}x${Math.round(box.height)}px`,
    });
  }

  if (interactive && !hasName) {
    suggestions.push({
      type: "missing-accessible-name",
      severity: "high",
      message:
        "Interactive target has no captured accessible name or visible text.",
      expected: "accessible name or visible text",
      actual: "missing",
    });
  }

  if (interactive && hasSuppressedFocusRing(styles)) {
    suggestions.push({
      type: "focus-ring",
      severity: "medium",
      message: "Interactive target appears to suppress the focus indicator.",
      expected: "visible focus outline or custom focus style",
      actual: formatFocusRing(styles),
    });
  }

  const contrast = contrastRatio(styles.color, styles["background-color"]);
  if (hasName && contrast !== null && contrast < 4.5) {
    suggestions.push({
      type: "low-contrast",
      severity: contrast < 3 ? "high" : "medium",
      message: "Text contrast is below WCAG AA guidance for normal text.",
      expected: "contrast ratio >= 4.5:1",
      actual: `${contrast.toFixed(2)}:1`,
    });
  }

  if (input.measurement.layoutContext?.overflow?.clippedByParent) {
    suggestions.push({
      type: input.measurement.textMetrics ? "text-overflow" : "clipping",
      severity: "medium",
      message: input.measurement.textMetrics
        ? "Text may be clipped by an overflowing parent."
        : "Element appears clipped by an overflowing parent.",
      expected: "element fully visible inside parent",
      actual: `parent overflow ${input.measurement.layoutContext.overflow.x}/${input.measurement.layoutContext.overflow.y}`,
    });
  }

  if (
    input.measurement.designTokenHints.length > 0 ||
    input.measurement.classHints.length > 0
  ) {
    suggestions.push({
      type: "token-hint",
      severity: "low",
      message:
        "Existing token or class hints are available for safer style fixes.",
      expected: "reuse nearby token/class evidence",
      actual: [
        input.measurement.designTokenHints[0]?.token,
        input.measurement.classHints[0],
      ]
        .filter(Boolean)
        .join(", "),
    });
  }

  if (createsStackingContext(input.measurement)) {
    suggestions.push({
      type: "stacking-context",
      severity: "low",
      message:
        "Stacking context may affect overlays, clipped content, or z-index fixes.",
      expected: "z-index and stacking ancestors are intentional",
      actual: [
        `position: ${input.measurement.stackingContext?.position}`,
        `z-index: ${input.measurement.stackingContext?.zIndex}`,
        input.measurement.stackingContext?.stackingAncestors.length
          ? `ancestors: ${input.measurement.stackingContext.stackingAncestors.length}`
          : null,
      ]
        .filter(Boolean)
        .join(", "),
    });
  }

  return suggestions.slice(0, 6);
}

function isLikelyInteractive(tag: string, role: string | undefined): boolean {
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
    ].includes(role?.toLowerCase() ?? "")
  );
}

function hasSuppressedFocusRing(styles: Record<string, string>): boolean {
  const outlineStyle = styles["outline-style"]?.toLowerCase();
  const outlineWidth = styles["outline-width"]?.toLowerCase();
  const outline = styles.outline?.toLowerCase();
  const boxShadow = styles["box-shadow"]?.toLowerCase();

  return (
    (outlineStyle === "none" ||
      outlineWidth === "0px" ||
      outline === "none" ||
      outline === "0px none") &&
    (!boxShadow || boxShadow === "none")
  );
}

function formatFocusRing(styles: Record<string, string>): string {
  return (
    [
      styles.outline ? `outline: ${styles.outline}` : null,
      styles["outline-style"]
        ? `outline-style: ${styles["outline-style"]}`
        : null,
      styles["outline-width"]
        ? `outline-width: ${styles["outline-width"]}`
        : null,
      styles["box-shadow"] ? `box-shadow: ${styles["box-shadow"]}` : null,
    ]
      .filter(Boolean)
      .join(", ") || "outline not captured"
  );
}

function createsStackingContext(measurement: SingleMeasurement): boolean {
  const context = measurement.stackingContext;

  return Boolean(
    context &&
      (context.zIndex !== "auto" ||
        context.opacity !== "1" ||
        context.transform !== "none" ||
        context.isolation === "isolate" ||
        context.stackingAncestors.length > 0),
  );
}

export function contrastRatio(
  foreground: string | undefined,
  background: string | undefined,
): number | null {
  if (!foreground || !background) {
    return null;
  }

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
