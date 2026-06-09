import type { AuthoredStyleHint, BoundingBox, DeltaMeasurement, LayoutContext, SingleMeasurement } from "../schema";
import { getStableSelector } from "./selector";
import { getSourceLocation } from "./source";
import { createElementTarget } from "./target";

export interface MeasurementDraft {
  text: string;
  measurement: SingleMeasurement | DeltaMeasurement;
}

export function stylePropertyNames(): string[] {
  return [
    "font-size",
    "color",
    "background-color",
    "padding",
    "margin",
    "width",
    "height",
    "border-radius"
  ];
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
    "Styles:"
  ];

  for (const property of stylePropertyNames()) {
    lines.push(`  ${property}: ${styles.getPropertyValue(property)}`);
  }

  return {
    text: lines.join("\n"),
    measurement: {
      kind: "single",
      bbox: boundingBox(rect),
      computedStyle,
      text: textSummary(element),
      role: (element as HTMLElement).getAttribute?.("role") ?? undefined,
      accessibleName: accessibleName(element),
      inlineStyle: inlineStyle(element),
      authoredHints: authoredStyleHints(element, Object.keys(computedStyle)),
      layoutContext: layoutContext(element)
    }
  };
}

export function measureDelta(firstElement: Element, secondElement: Element): MeasurementDraft {
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
      `Color delta: ${firstColor} -> ${secondColor}`,
      `Background delta: ${firstBackground} -> ${secondBackground}`,
      `Font-size delta: ${firstFontSize} -> ${secondFontSize}`
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
        fontSize: [firstFontSize, secondFontSize]
      },
      layoutContext: layoutContext(secondElement)
    }
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
    left: roundNumber(rect.left)
  };
}

export function pickComputedStyles(styles: CSSStyleDeclaration): Record<string, string> {
  const result: Record<string, string> = {};

  for (const property of stylePropertyNames()) {
    result[property] = styles.getPropertyValue(property);
  }

  return result;
}

export function inlineStyle(element: Element): Record<string, string> | undefined {
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

export function authoredStyleHints(element: Element, properties: string[]): AuthoredStyleHint[] {
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
            source: sheet.href ?? "inline stylesheet"
          });
        }
      }
    }
  }

  return hints.slice(0, 20);
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
    overflow: overflowContext(element)
  };
}

export function nearestSiblingDistance(element: Element): LayoutContext["nearestSiblingDistance"] {
  const rect = element.getBoundingClientRect();
  const distances: NonNullable<LayoutContext["nearestSiblingDistance"]> = {};

  for (const sibling of Array.from(element.parentElement?.children ?? [])) {
    if (sibling === element) {
      continue;
    }

    const siblingRect = sibling.getBoundingClientRect();

    if (siblingRect.right <= rect.left) {
      distances.left = minDistance(distances.left, rect.left - siblingRect.right);
    }
    if (siblingRect.left >= rect.right) {
      distances.right = minDistance(distances.right, siblingRect.left - rect.right);
    }
    if (siblingRect.bottom <= rect.top) {
      distances.top = minDistance(distances.top, rect.top - siblingRect.bottom);
    }
    if (siblingRect.top >= rect.bottom) {
      distances.bottom = minDistance(distances.bottom, siblingRect.top - rect.bottom);
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
      (rect.left < parentRect.left || rect.right > parentRect.right || rect.top < parentRect.top || rect.bottom > parentRect.bottom)
    ),
    horizontalPageScroll: document.documentElement.scrollWidth > window.innerWidth
  };
}

export function minDistance(current: number | undefined, candidate: number): number {
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

  return (element as HTMLElement).getAttribute?.("aria-label") ?? textSummary(element);
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
  const match = value.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([.\d]+))?\)/);

  if (!match) {
    return value;
  }

  const alpha = match[4] === undefined ? 1 : Number(match[4]);

  if (alpha === 0) {
    return "transparent";
  }

  const rgb = `#${toHex(Number(match[1]))}${toHex(Number(match[2]))}${toHex(Number(match[3]))}`;

  if (alpha >= 1) {
    return rgb;
  }

  return `${rgb}${toHex(Math.round(alpha * 255))}`;
}

export function toHex(value: number): string {
  return value.toString(16).padStart(2, "0");
}
