import { getStableSelector } from "./selector";
import { getSourceLocation } from "./source";

export function measureElement(element: Element): string {
  const styleProperties = [
    "font-size",
    "color",
    "background-color",
    "padding",
    "margin",
    "width",
    "height",
    "border-radius"
  ] as const;
  const rect = element.getBoundingClientRect();
  const styles = window.getComputedStyle(element);
  const selector = getStableSelector(element);
  const source = getSourceLocation(element);
  const lines = [
    `Selector: ${selector}`,
    `Source: ${source}`,
    `Bbox: x=${formatNumber(rect.x)}, y=${formatNumber(rect.y)}, w=${formatNumber(rect.width)}, h=${formatNumber(rect.height)}`,
    "Styles:"
  ];

  for (const property of styleProperties) {
    lines.push(`  ${property}: ${styles.getPropertyValue(property)}`);
  }

  return lines.join("\n");

  function formatNumber(value: number): string {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
}

export function measureDelta(firstElement: Element, secondElement: Element): string {
  const firstRect = firstElement.getBoundingClientRect();
  const secondRect = secondElement.getBoundingClientRect();
  const firstStyles = window.getComputedStyle(firstElement);
  const secondStyles = window.getComputedStyle(secondElement);
  const firstSelector = getStableSelector(firstElement);
  const secondSelector = getStableSelector(secondElement);
  const leftDelta = secondRect.left - firstRect.left;
  const topDelta = secondRect.top - firstRect.top;
  const widthDelta = secondRect.width - firstRect.width;
  const heightDelta = secondRect.height - firstRect.height;
  const firstColor = toHexColor(firstStyles.color);
  const secondColor = toHexColor(secondStyles.color);
  const firstBackground = toHexColor(firstStyles.backgroundColor);
  const secondBackground = toHexColor(secondStyles.backgroundColor);
  const firstFontSize = firstStyles.fontSize;
  const secondFontSize = secondStyles.fontSize;

  return [
    `Reference: ${firstSelector}`,
    `Target: ${secondSelector}`,
    `Left edge delta: ${formatSigned(leftDelta)}px`,
    `Top edge delta: ${formatSigned(topDelta)}px`,
    `Width delta: ${formatSigned(widthDelta)}px`,
    `Height delta: ${formatSigned(heightDelta)}px`,
    `Color delta: ${firstColor} -> ${secondColor}`,
    `Background delta: ${firstBackground} -> ${secondBackground}`,
    `Font-size delta: ${firstFontSize} -> ${secondFontSize}`
  ].join("\n");

  function formatSigned(value: number): string {
    const rounded = Math.round(value);

    return rounded > 0 ? `+${rounded}` : String(rounded);
  }

  function toHexColor(value: string): string {
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

  function toHex(value: number): string {
    return value.toString(16).padStart(2, "0");
  }
}
