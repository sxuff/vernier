import type { ElementTarget } from "../schema";
import { getFallbackSelector, getStableSelector } from "./selector";
import { resolveSource } from "./source";

export function createElementTarget(element: Element): ElementTarget {
  const selector = getStableSelector(element);
  const fallbackSelector = getFallbackSelector(element);
  const source = resolveSource(element);
  const testId = element.getAttribute("data-testid") ?? undefined;
  const role = element.getAttribute("role") ?? implicitRole(element) ?? undefined;
  const accessibleName = accessibleNameForTarget(element);

  return {
    selector,
    fallbackSelector: fallbackSelector === selector ? undefined : fallbackSelector,
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
    nearestLandmark: nearestLandmark(element),
    source: source.source,
    sourceConfidence: source.confidence,
    sourceResolver: source.resolver,
    componentName: source.componentName,
    ownerChain: source.ownerChain,
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
    sourceResolver: "viewport",
    ownerChain: [],
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

export function accessibleNameForTarget(element: Element): string | undefined {
  const labelledBy = element.getAttribute("aria-labelledby");

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

  return element.getAttribute("aria-label") ??
    element.getAttribute("alt") ??
    element.getAttribute("title") ??
    textSummary(element) ??
    undefined;
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

export function nearestLandmark(element: Element): string | undefined {
  let current: Element | null = element;

  while (current && current !== document.documentElement) {
    const landmark = landmarkSummary(current);

    if (landmark) {
      return landmark;
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

function landmarkSummary(element: Element): string | null {
  const tag = element.tagName.toLowerCase();
  const role = element.getAttribute("role");
  const label = element.getAttribute("aria-label");
  const landmarkRoles = new Set(["banner", "complementary", "contentinfo", "form", "main", "navigation", "region", "search"]);

  if (tag === "main" || tag === "nav" || tag === "header" || tag === "footer" || tag === "aside" || tag === "form") {
    return label ? `${tag}[aria-label="${label}"]` : tag;
  }

  if (tag === "section" && label) {
    return `${tag}[aria-label="${label}"]`;
  }

  if (role && landmarkRoles.has(role)) {
    return label ? `[role="${role}"][aria-label="${label}"]` : `[role="${role}"]`;
  }

  return null;
}
