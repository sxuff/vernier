export function getStableSelector(element: Element): string {
  const testId = element.getAttribute("data-testid");

  if (testId) {
    return `[data-testid="${escapeAttribute(testId)}"]`;
  }

  if (element.id) {
    return `#${CSS.escape(element.id)}`;
  }

  const path: string[] = [];
  let current: Element | null = element;

  while (current && current !== document.documentElement) {
    const segment = getSegment(current);
    path.unshift(segment);
    const selector = path.join(" > ");

    if (document.querySelectorAll(selector).length === 1) {
      return selector;
    }

    current = current.parentElement;
  }

  return path.join(" > ") || element.tagName.toLowerCase();

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
}
