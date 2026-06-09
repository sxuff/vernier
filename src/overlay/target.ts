import type { ElementTarget } from "../schema";
import { getStableSelector } from "./selector";
import { getSourceLocation } from "./source";

export function createElementTarget(element: Element): ElementTarget {
  const selector = getStableSelector(element);
  const source = getSourceLocation(element);
  const testId = element.getAttribute("data-testid") ?? undefined;
  const role = element.getAttribute("role") ?? implicitRole(element) ?? undefined;
  const accessibleName = element.getAttribute("aria-label") ?? textSummary(element) ?? undefined;

  return {
    selector,
    selectorConfidence: selectorConfidence(selector),
    selectorReason: selectorReason(selector),
    tag: element.tagName.toLowerCase(),
    id: element.id || undefined,
    classes: Array.from(element.classList),
    text: textSummary(element),
    role,
    accessibleName,
    testId,
    nearestTestId: nearestAttribute(element, "data-testid"),
    source,
    sourceConfidence: source === "unresolved" ? "low" : "medium",
    ancestry: ancestry(element)
  };
}

export function createViewportTarget(): ElementTarget {
  return {
    selector: "viewport",
    selectorConfidence: "high",
    selectorReason: "annotation target is the viewport",
    tag: "viewport",
    classes: [],
    source: "unresolved",
    sourceConfidence: "low",
    ancestry: []
  };
}

export function selectorConfidence(selector: string): ElementTarget["selectorConfidence"] {
  if (selector.startsWith("[data-testid=") || selector.startsWith("#")) {
    return "high";
  }

  if (selector.includes(":nth-of-type")) {
    return "low";
  }

  return "medium";
}

export function selectorReason(selector: string): string {
  if (selector.startsWith("[data-testid=")) {
    return "unique data-testid";
  }

  if (selector.startsWith("#")) {
    return "element id";
  }

  if (selector.includes(":nth-of-type")) {
    return "structural nth-of-type fallback";
  }

  return "unique DOM selector";
}

export function textSummary(element: Element): string | undefined {
  const text = element.textContent?.replace(/\s+/g, " ").trim();

  if (!text) {
    return undefined;
  }

  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

export function nearestAttribute(element: Element, attribute: string): string | undefined {
  let current: Element | null = element;

  while (current) {
    const value = current.getAttribute(attribute);

    if (value) {
      return value;
    }

    current = current.parentElement;
  }

  return undefined;
}

export function ancestry(element: Element): ElementTarget["ancestry"] {
  const chain: ElementTarget["ancestry"] = [];
  let current: Element | null = element;

  while (current && current !== document.documentElement && chain.length < 5) {
    chain.unshift({
      tag: current.tagName.toLowerCase(),
      id: current.id || undefined,
      classes: Array.from(current.classList).slice(0, 5),
      role: current.getAttribute("role") ?? implicitRole(current) ?? undefined,
      testId: current.getAttribute("data-testid") ?? undefined,
      text: textSummary(current)
    });
    current = current.parentElement;
  }

  return chain;
}

export function implicitRole(element: Element): string | null {
  const tag = element.tagName.toLowerCase();

  if (tag === "button") {
    return "button";
  }

  if (tag === "a" && element.hasAttribute("href")) {
    return "link";
  }

  if (tag === "main") {
    return "main";
  }

  if (tag === "nav") {
    return "navigation";
  }

  return null;
}
