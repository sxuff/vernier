export function getStableSelector(element: Element): string {
  const testId = element.getAttribute("data-testid");

  if (testId) {
    return `[data-testid="${escapeAttribute(testId)}"]`;
  }

  if (element.id) {
    return `#${CSS.escape(element.id)}`;
  }

  return getShortestUniqueSelector(element) ?? getFallbackSelector(element);
}

export function getFallbackSelector(element: Element): string {
  const path: string[] = [];
  let current: Element | null = element;

  while (current && current !== document.documentElement) {
    path.unshift(getSegment(current));
    current = current.parentElement;
  }

  return path.join(" > ") || element.tagName.toLowerCase();
}

function getShortestUniqueSelector(element: Element): string | null {
  const path: string[] = [];
  let current: Element | null = element;

  while (current && current !== document.documentElement) {
    path.unshift(getSegment(current));
    const selector = path.join(" > ");

    if (document.querySelectorAll(selector).length === 1) {
      return selector;
    }

    current = current.parentElement;
  }

  return null;
}

function getSegment(segmentElement: Element): string {
  const tagName = segmentElement.tagName.toLowerCase();
  const parent = segmentElement.parentElement;

  if (!parent) {
    return tagName;
  }

  const siblings = Array.from(parent.children).filter((sibling) => sibling.tagName === segmentElement.tagName);
  const index = siblings.indexOf(segmentElement) + 1;

  return siblings.length <= 1 ? tagName : `${tagName}:nth-of-type(${index})`;
}

function escapeAttribute(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
