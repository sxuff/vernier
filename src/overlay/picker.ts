export interface Picker {
  clear(): void;
  destroy(): void;
}

export interface PickerOptions {
  onSelect(element: Element): void;
  onCompare(firstElement: Element, secondElement: Element): void;
  signal?: AbortSignal;
}

export function createPicker(root: HTMLElement, options: PickerOptions): Picker {
  let hoveredElement: Element | null = null;
  let frozenElement: Element | null = null;
  let anchorElement: Element | null = null;

  const highlight = document.createElement("div");
  highlight.dataset.vernierHighlight = "true";
  highlight.hidden = true;
  highlight.style.position = "fixed";
  highlight.style.border = "2px solid #1f6feb";
  highlight.style.borderRadius = "4px";
  highlight.style.background = "rgba(31, 111, 235, 0.08)";
  highlight.style.boxShadow = "0 0 0 1px rgba(255, 255, 255, 0.85)";
  highlight.style.pointerEvents = "none";

  const label = document.createElement("div");
  label.dataset.vernierSizeLabel = "true";
  label.style.position = "fixed";
  label.style.padding = "3px 6px";
  label.style.borderRadius = "4px";
  label.style.background = "#1f6feb";
  label.style.color = "#ffffff";
  label.style.font = "600 12px/1.2 ui-monospace, SFMono-Regular, Consolas, monospace";
  label.style.pointerEvents = "none";
  label.hidden = true;

  root.append(highlight, label);
  options.signal?.addEventListener("abort", destroy, { once: true });

  function isActive(): boolean {
    return root.dataset.vernierActive === "true" && !root.hidden;
  }

  function isOverlayElement(element: Element | null): boolean {
    const rootNode = root.getRootNode();
    const host = rootNode instanceof ShadowRoot ? rootNode.host : null;

    return element === null || element === root || root.contains(element) || element === host;
  }

  function getCandidate(event: MouseEvent): Element | null {
    const candidate = document.elementFromPoint(event.clientX, event.clientY);

    if (!candidate || isOverlayElement(candidate)) {
      return null;
    }

    return candidate.closest("[data-testid]") ?? candidate;
  }

  function formatSize(rect: DOMRect): string {
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);

    return `${width}x${height}`;
  }

  function renderTarget(target: Element | null): void {
    if (!target) {
      highlight.hidden = true;
      label.hidden = true;
      hoveredElement = null;
      return;
    }

    const rect = target.getBoundingClientRect();
    const size = formatSize(rect);

    hoveredElement = target;
    highlight.hidden = false;
    highlight.style.left = `${rect.left}px`;
    highlight.style.top = `${rect.top}px`;
    highlight.style.width = `${rect.width}px`;
    highlight.style.height = `${rect.height}px`;
    highlight.dataset.vernierTarget = target.tagName.toLowerCase();

    label.hidden = false;
    label.textContent = size;
    label.style.left = `${rect.left}px`;
    label.style.top = `${Math.max(0, rect.top - 24)}px`;
  }

  function clear(): void {
    frozenElement = null;
    anchorElement = null;
    renderTarget(null);
  }

  window.addEventListener(
    "mousemove",
    (event) => {
      if (!isActive() || frozenElement) {
        return;
      }

      renderTarget(getCandidate(event));
    },
    { capture: true, signal: options.signal }
  );

  window.addEventListener(
    "click",
    (event) => {
      if (!isActive()) {
        return;
      }

      if (event.target instanceof Element && isOverlayElement(event.target)) {
        return;
      }

      const clickedElement = getCandidate(event) ?? hoveredElement;

      if (!clickedElement) {
        return;
      }

      if (anchorElement && clickedElement !== anchorElement) {
        frozenElement = clickedElement;
        renderTarget(clickedElement);
        options.onCompare(anchorElement, clickedElement);
        anchorElement = clickedElement;
      } else {
        frozenElement = clickedElement;
        anchorElement = clickedElement;
        renderTarget(clickedElement);
        options.onSelect(clickedElement);
      }

      event.preventDefault();
      event.stopImmediatePropagation();
    },
    { capture: true, signal: options.signal }
  );

  window.addEventListener(
    "keydown",
    (event) => {
      if (!isActive() || event.key !== "Escape") {
        return;
      }

      event.preventDefault();
      clear();
    },
    { capture: true, signal: options.signal }
  );

  return { clear, destroy };

  function destroy(): void {
    clear();
    highlight.remove();
    label.remove();
  }
}
