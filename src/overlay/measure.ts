import type {
  AuthoredStyleHint,
  BoundingBox,
  DeltaMeasurement,
  DesignTokenHint,
  LayoutContext,
  SingleMeasurement,
  StackingContext,
  TextMetrics,
  VernierSuggestion,
} from "../schema";
import { getStylePropertyNames } from "./options";
import { getStableSelector } from "./selector";
import { getSourceLocation } from "./source";
import { createElementSuggestions } from "./suggestions";
import { createElementTarget } from "./target";

export interface MeasurementDraft {
  text: string;
  measurement: SingleMeasurement | DeltaMeasurement;
  suggestions?: VernierSuggestion[];
}

export function stylePropertyNames(): string[] {
  return getStylePropertyNames();
}

export function measureElement(element: Element): MeasurementDraft {
  const rect = element.getBoundingClientRect();
  const styles = window.getComputedStyle(element);
  const selector = getStableSelector(element);
  const source = getSourceLocation(element);
  const computedStyle = pickComputedStyles(styles);
  const lines = [
    `Selector: ${selector}`,
    `Source: ${source}`,
    `Bbox: x=${formatNumber(rect.x)}, y=${formatNumber(rect.y)}, w=${formatNumber(rect.width)}, h=${formatNumber(rect.height)}`,
    "Styles:",
  ];

  for (const property of stylePropertyNames()) {
    lines.push(`  ${property}: ${styles.getPropertyValue(property)}`);
  }

  const measurement: SingleMeasurement = {
    kind: "single",
    bbox: boundingBox(rect),
    computedStyle,
    text: textSummary(element),
    role: (element as HTMLElement).getAttribute?.("role") ?? undefined,
    accessibleName: accessibleName(element),
    inlineStyle: inlineStyle(element),
    authoredHints: authoredStyleHints(element, Object.keys(computedStyle)),
    classHints: classHints(element),
    designTokenHints: designTokenHints(computedStyle),
    layoutContext: layoutContext(element),
    textMetrics: textMetrics(element),
    stackingContext: stackingContext(element),
  };
  const suggestions = createElementSuggestions(element, measurement);

  if (suggestions.length > 0) {
    lines.push(
      "Suggestions:",
      ...suggestions.map(
        (suggestion) =>
          `  [${suggestion.severity}] ${suggestion.type}: ${suggestion.message} Expected ${suggestion.expected}; actual ${suggestion.actual}.`,
      ),
    );
  }

  return {
    text: lines.join("\n"),
    measurement,
    suggestions,
  };
}

export function measureDelta(
  firstElement: Element,
  secondElement: Element,
): MeasurementDraft {
  const firstTarget = createElementTarget(firstElement);
  const secondTarget = createElementTarget(secondElement);
  const firstRect = firstElement.getBoundingClientRect();
  const secondRect = secondElement.getBoundingClientRect();
  const firstStyles = window.getComputedStyle(firstElement);
  const secondStyles = window.getComputedStyle(secondElement);
  const leftDelta = roundNumber(secondRect.left - firstRect.left);
  const topDelta = roundNumber(secondRect.top - firstRect.top);
  const widthDelta = roundNumber(secondRect.width - firstRect.width);
  const heightDelta = roundNumber(secondRect.height - firstRect.height);
  const centerDelta = roundNumber(
    secondRect.left +
      secondRect.width / 2 -
      (firstRect.left + firstRect.width / 2),
  );
  const horizontalGap = roundNumber(secondRect.left - firstRect.right);
  const verticalGap = roundNumber(secondRect.top - firstRect.bottom);
  const firstColor = toHexColor(firstStyles.color);
  const secondColor = toHexColor(secondStyles.color);
  const firstBackground = toHexColor(firstStyles.backgroundColor);
  const secondBackground = toHexColor(secondStyles.backgroundColor);
  const firstFontSize = firstStyles.fontSize;
  const secondFontSize = secondStyles.fontSize;

  return {
    text: [
      `Reference: ${firstTarget.selector}`,
      `Target: ${secondTarget.selector}`,
      `Left edge delta: ${formatSigned(leftDelta)}px`,
      `Top edge delta: ${formatSigned(topDelta)}px`,
      `Width delta: ${formatSigned(widthDelta)}px`,
      `Height delta: ${formatSigned(heightDelta)}px`,
      `Center delta: ${formatSigned(centerDelta)}px`,
      `Horizontal gap: ${formatSigned(horizontalGap)}px`,
      `Vertical gap: ${formatSigned(verticalGap)}px`,
      `Color delta: ${firstColor} -> ${secondColor}`,
      `Background delta: ${firstBackground} -> ${secondBackground}`,
      `Font-size delta: ${firstFontSize} -> ${secondFontSize}`,
    ].join("\n"),
    measurement: {
      kind: "delta",
      reference: firstTarget,
      target: secondTarget,
      referenceBbox: boundingBox(firstRect),
      targetBbox: boundingBox(secondRect),
      delta: {
        left: leftDelta,
        top: topDelta,
        width: widthDelta,
        height: heightDelta,
        color: [firstColor, secondColor],
        backgroundColor: [firstBackground, secondBackground],
        fontSize: [firstFontSize, secondFontSize],
      },
      alignment: {
        leftAligned: Math.abs(leftDelta) <= 1,
        topAligned: Math.abs(topDelta) <= 1,
        centerAligned: Math.abs(centerDelta) <= 1,
        centerDelta,
        horizontalGap,
        verticalGap,
      },
      layoutContext: layoutContext(secondElement),
      classHints: classHints(secondElement),
      designTokenHints: designTokenHints({
        color: secondColor,
        "background-color": secondBackground,
        "font-size": secondFontSize,
      }),
      textMetrics: textMetrics(secondElement),
      stackingContext: stackingContext(secondElement),
    },
  };
}

export function boundingBox(rect: DOMRect): BoundingBox {
  return {
    x: roundNumber(rect.x),
    y: roundNumber(rect.y),
    width: roundNumber(rect.width),
    height: roundNumber(rect.height),
    top: roundNumber(rect.top),
    right: roundNumber(rect.right),
    bottom: roundNumber(rect.bottom),
    left: roundNumber(rect.left),
  };
}

export function pickComputedStyles(
  styles: CSSStyleDeclaration,
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const property of stylePropertyNames()) {
    result[property] = styles.getPropertyValue(property);
  }

  return result;
}

export function inlineStyle(
  element: Element,
): Record<string, string> | undefined {
  if (!(element instanceof HTMLElement) || element.style.length === 0) {
    return undefined;
  }

  const result: Record<string, string> = {};

  for (let index = 0; index < element.style.length; index += 1) {
    const property = element.style.item(index);
    result[property] = element.style.getPropertyValue(property);
  }

  return result;
}

export function authoredStyleHints(
  element: Element,
  properties: string[],
): AuthoredStyleHint[] {
  const hints: AuthoredStyleHint[] = [];

  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;

    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }

    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSStyleRule)) {
        continue;
      }

      try {
        if (!element.matches(rule.selectorText)) {
          continue;
        }
      } catch {
        continue;
      }

      for (const property of properties) {
        const value = rule.style.getPropertyValue(property);

        if (value) {
          hints.push({
            selector: rule.selectorText,
            property,
            value,
            source: sheet.href ?? "inline stylesheet",
          });
        }
      }
    }
  }

  return hints.slice(0, 20);
}

export function classHints(element: Element): string[] {
  return Array.from(element.classList)
    .filter(
      (className) =>
        /^(bg|text|border|ring|fill|stroke|p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|gap|rounded|w|h|min-w|min-h|max-w|max-h|font|leading|tracking|shadow|grid|flex|items|justify|content|self|col|row)-/.test(
          className,
        ) ||
        /^(btn|button|card|panel|surface|token|color|space|radius|size)-/.test(
          className,
        ),
    )
    .slice(0, 24);
}

export function designTokenHints(
  computedStyle: Record<string, string>,
): DesignTokenHint[] {
  const tokens = cssVariableTokens();
  const hints: DesignTokenHint[] = [];

  for (const [property, computed] of Object.entries(computedStyle)) {
    const best = nearestToken(computed, tokens);

    if (best) {
      hints.push({
        property,
        computed,
        token: best.token,
        value: best.value,
        distance: best.distance,
      });
    }
  }

  return hints.slice(0, 20);
}

export function cssVariableTokens(): Array<{ token: string; value: string }> {
  const tokens = new Map<string, string>();
  const rootStyles = window.getComputedStyle(document.documentElement);

  for (let index = 0; index < rootStyles.length; index += 1) {
    const property = rootStyles.item(index);

    if (property.startsWith("--")) {
      tokens.set(property, rootStyles.getPropertyValue(property).trim());
    }
  }

  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;

    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }

    collectRuleTokens(rules, tokens);
  }

  return Array.from(tokens.entries())
    .filter(([, value]) => Boolean(value))
    .map(([token, value]) => ({ token, value }));
}

export function collectRuleTokens(
  rules: CSSRuleList,
  tokens: Map<string, string>,
): void {
  for (const rule of Array.from(rules)) {
    if (rule instanceof CSSStyleRule) {
      for (let index = 0; index < rule.style.length; index += 1) {
        const property = rule.style.item(index);

        if (property.startsWith("--")) {
          tokens.set(property, rule.style.getPropertyValue(property).trim());
        }
      }
      continue;
    }

    const nestedRules = (rule as CSSGroupingRule).cssRules;

    if (nestedRules) {
      collectRuleTokens(nestedRules, tokens);
    }
  }
}

export function nearestToken(
  computed: string,
  tokens: Array<{ token: string; value: string }>,
): { token: string; value: string; distance: number } | null {
  let best: { token: string; value: string; distance: number } | null = null;

  for (const token of tokens) {
    const distance = tokenDistance(computed, token.value);

    if (distance === null || distance > 4) {
      continue;
    }

    if (!best || distance < best.distance) {
      best = { ...token, distance };
    }
  }

  return best;
}

export function tokenDistance(left: string, right: string): number | null {
  const leftColor = parseColor(left);
  const rightColor = parseColor(right);

  if (leftColor && rightColor) {
    return Math.round(
      Math.sqrt(
        (leftColor.red - rightColor.red) ** 2 +
          (leftColor.green - rightColor.green) ** 2 +
          (leftColor.blue - rightColor.blue) ** 2,
      ),
    );
  }

  const leftPx = parsePixelValue(left);
  const rightPx = parsePixelValue(right);

  if (leftPx !== null && rightPx !== null) {
    return Math.abs(leftPx - rightPx);
  }

  return left.trim() === right.trim() ? 0 : null;
}

export function parsePixelValue(value: string): number | null {
  const match = value.trim().match(/^(-?[\d.]+)px$/);
  return match ? Number(match[1]) : null;
}

export function parseColor(
  value: string,
): { red: number; green: number; blue: number } | null {
  const normalized = value.trim().toLowerCase();
  const hex = normalized.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/);

  if (hex) {
    const hexValue = hex[1];

    return {
      red: Number.parseInt(hexValue.slice(0, 2), 16),
      green: Number.parseInt(hexValue.slice(2, 4), 16),
      blue: Number.parseInt(hexValue.slice(4, 6), 16),
    };
  }

  const rgb = normalized.match(
    /^rgba?\((\d+)(?:,\s*|\s+)(\d+)(?:,\s*|\s+)(\d+)(?:\s*\/\s*([.\d]+%?)|,\s*([.\d]+))?\)$/,
  );

  if (!rgb) {
    return null;
  }

  return {
    red: Number(rgb[1]),
    green: Number(rgb[2]),
    blue: Number(rgb[3]),
  };
}

export function layoutContext(element: Element): LayoutContext {
  const parent = element.parentElement;
  const parentStyles = parent ? window.getComputedStyle(parent) : null;

  return {
    parentSelector: parent ? getStableSelector(parent) : undefined,
    parentDisplay: parentStyles?.display,
    parentGap: parentStyles?.gap,
    parentRowGap: parentStyles?.rowGap,
    parentColumnGap: parentStyles?.columnGap,
    parentPadding: parentStyles?.padding,
    gridTemplateColumns: parentStyles?.gridTemplateColumns,
    flexDirection: parentStyles?.flexDirection,
    nearestSiblingDistance: nearestSiblingDistance(element),
    overflow: overflowContext(element),
  };
}

export function nearestSiblingDistance(
  element: Element,
): LayoutContext["nearestSiblingDistance"] {
  const rect = element.getBoundingClientRect();
  const distances: NonNullable<LayoutContext["nearestSiblingDistance"]> = {};

  for (const sibling of Array.from(element.parentElement?.children ?? [])) {
    if (sibling === element) {
      continue;
    }

    const siblingRect = sibling.getBoundingClientRect();

    if (siblingRect.right <= rect.left) {
      distances.left = minDistance(
        distances.left,
        rect.left - siblingRect.right,
      );
    }
    if (siblingRect.left >= rect.right) {
      distances.right = minDistance(
        distances.right,
        siblingRect.left - rect.right,
      );
    }
    if (siblingRect.bottom <= rect.top) {
      distances.top = minDistance(distances.top, rect.top - siblingRect.bottom);
    }
    if (siblingRect.top >= rect.bottom) {
      distances.bottom = minDistance(
        distances.bottom,
        siblingRect.top - rect.bottom,
      );
    }
  }

  return distances;
}

export function overflowContext(element: Element): LayoutContext["overflow"] {
  const parent = element.parentElement;
  const rect = element.getBoundingClientRect();
  const parentRect = parent?.getBoundingClientRect();
  const parentStyles = parent ? window.getComputedStyle(parent) : null;
  const clipsOverflow = parentStyles
    ? ["hidden", "clip", "auto", "scroll"].includes(parentStyles.overflowX) ||
      ["hidden", "clip", "auto", "scroll"].includes(parentStyles.overflowY)
    : false;

  return {
    x: parentStyles?.overflowX ?? "visible",
    y: parentStyles?.overflowY ?? "visible",
    clippedByParent: Boolean(
      clipsOverflow &&
        parentRect &&
        (rect.left < parentRect.left ||
          rect.right > parentRect.right ||
          rect.top < parentRect.top ||
          rect.bottom > parentRect.bottom),
    ),
    horizontalPageScroll:
      document.documentElement.scrollWidth > window.innerWidth,
  };
}

export function textMetrics(element: Element): TextMetrics | undefined {
  if (!element.textContent?.trim()) {
    return undefined;
  }

  const styles = window.getComputedStyle(element);
  const lineHeight = styles.lineHeight;
  const lineHeightPixels = parsePixelValue(lineHeight);
  const renderedLineCount =
    lineHeightPixels && lineHeightPixels > 0
      ? Math.max(
          1,
          Math.round(element.getBoundingClientRect().height / lineHeightPixels),
        )
      : undefined;

  return {
    fontFamily: styles.fontFamily,
    fontSize: styles.fontSize,
    fontWeight: styles.fontWeight,
    lineHeight,
    letterSpacing: styles.letterSpacing,
    textTransform: styles.textTransform,
    textOverflow: styles.textOverflow,
    whiteSpace: styles.whiteSpace,
    renderedLineCount,
  };
}

export function stackingContext(element: Element): StackingContext {
  const styles = window.getComputedStyle(element);

  return {
    position: styles.position,
    zIndex: styles.zIndex,
    opacity: styles.opacity,
    transform: styles.transform,
    isolation: styles.isolation,
    stackingAncestors: stackingAncestors(element),
  };
}

export function stackingAncestors(
  element: Element,
): StackingContext["stackingAncestors"] {
  const ancestors: StackingContext["stackingAncestors"] = [];
  let current = element.parentElement;

  while (current && current !== document.documentElement) {
    const styles = window.getComputedStyle(current);

    if (createsStackingContext(styles)) {
      ancestors.push({
        selector: getStableSelector(current),
        position: styles.position,
        zIndex: styles.zIndex,
        opacity: styles.opacity,
        transform: styles.transform,
        isolation: styles.isolation,
      });
    }

    current = current.parentElement;
  }

  return ancestors.slice(0, 8);
}

export function createsStackingContext(styles: CSSStyleDeclaration): boolean {
  return (
    styles.position === "fixed" ||
    styles.position === "sticky" ||
    (styles.position !== "static" && styles.zIndex !== "auto") ||
    Number(styles.opacity) < 1 ||
    styles.transform !== "none" ||
    styles.filter !== "none" ||
    styles.perspective !== "none" ||
    styles.mixBlendMode !== "normal" ||
    styles.isolation === "isolate" ||
    styles.contain.includes("paint") ||
    styles.willChange
      .split(",")
      .map((value) => value.trim())
      .some((value) =>
        ["transform", "opacity", "filter", "perspective"].includes(value),
      )
  );
}

export function minDistance(
  current: number | undefined,
  candidate: number,
): number {
  const rounded = roundNumber(candidate);
  return current === undefined ? rounded : Math.min(current, rounded);
}

export function textSummary(element: Element): string | undefined {
  const text = element.textContent?.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 120) : undefined;
}

export function accessibleName(element: Element): string | undefined {
  const labelledBy = (element as HTMLElement).getAttribute?.("aria-labelledby");

  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim())
      .filter(Boolean)
      .join(" ");

    if (text) {
      return text;
    }
  }

  return (
    (element as HTMLElement).getAttribute?.("aria-label") ??
    (element as HTMLElement).getAttribute?.("alt") ??
    (element as HTMLElement).getAttribute?.("title") ??
    textSummary(element)
  );
}

export function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

export function formatSigned(value: number): string {
  const rounded = Math.round(value);

  return rounded > 0 ? `+${rounded}` : String(rounded);
}

export function roundNumber(value: number): number {
  return Math.round(value * 100) / 100;
}

export function toHexColor(value: string): string {
  const match = value
    .trim()
    .match(
      /^rgba?\(\s*(\d+)(?:,\s*|\s+)(\d+)(?:,\s*|\s+)(\d+)(?:(?:\s*\/\s*|,\s*)([.\d]+%?))?\s*\)$/,
    );

  if (!match) {
    return value;
  }

  const alpha = parseAlpha(match[4]);

  if (alpha === 0) {
    return "transparent";
  }

  const rgb = `#${toHex(Number(match[1]))}${toHex(Number(match[2]))}${toHex(Number(match[3]))}`;

  if (alpha >= 1) {
    return rgb;
  }

  return `${rgb}${toHex(Math.round(alpha * 255))}`;
}

function parseAlpha(value: string | undefined): number {
  if (value === undefined) {
    return 1;
  }

  if (value.endsWith("%")) {
    return Number(value.slice(0, -1)) / 100;
  }

  return Number(value);
}

export function toHex(value: number): string {
  return value.toString(16).padStart(2, "0");
}
