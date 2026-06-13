export interface Picker {
  clear(): void;
  destroy(): void;
}

export interface PickerOptions {
  onSelect(element: Element): void;
  onCompare(firstElement: Element, secondElement: Element): void;
  signal?: AbortSignal;
}

export function createPicker(
  root: HTMLElement,
  options: PickerOptions,
): Picker {
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
  label.style.font =
    "600 12px/1.2 ui-monospace, SFMono-Regular, Consolas, monospace";
  label.style.pointerEvents = "none";
  label.hidden = true;

  const anchorHighlight = createBox(
    "vernierAnchorHighlight",
    "#ff8a00",
    "rgba(255, 138, 0, 0.08)",
  );
  const targetHighlight = createBox(
    "vernierTargetHighlight",
    "#1f6feb",
    "rgba(31, 111, 235, 0.08)",
  );
  const guideLayer = document.createElement("div");
  guideLayer.dataset.vernierGuideLayer = "true";
  guideLayer.hidden = true;
  guideLayer.style.position = "fixed";
  guideLayer.style.inset = "0";
  guideLayer.style.pointerEvents = "none";
  guideLayer.style.zIndex = "2";

  root.append(guideLayer, anchorHighlight, targetHighlight, highlight, label);
  options.signal?.addEventListener("abort", destroy, { once: true });

  function isActive(): boolean {
    return root.dataset.vernierActive === "true" && !root.hidden;
  }

  function isOverlayElement(element: Element | null): boolean {
    const rootNode = root.getRootNode();
    const host = rootNode instanceof ShadowRoot ? rootNode.host : null;

    return (
      element === null ||
      element === root ||
      root.contains(element) ||
      element === host
    );
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

    if (anchorElement && target !== anchorElement) {
      renderGuides(anchorElement, target);
    }
  }

  function clear(): void {
    frozenElement = null;
    anchorElement = null;
    renderTarget(null);
    clearGuides();
  }

  window.addEventListener(
    "mousemove",
    (event) => {
      if (!isActive()) {
        return;
      }

      if (frozenElement && !anchorElement) {
        return;
      }

      const candidate = getCandidate(event);
      renderTarget(candidate);

      if (anchorElement && candidate && candidate !== anchorElement) {
        renderGuides(anchorElement, candidate);
      }
    },
    { capture: true, signal: options.signal },
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
        const previousAnchor = anchorElement;
        frozenElement = clickedElement;
        renderTarget(clickedElement);
        renderGuides(previousAnchor, clickedElement);
        options.onCompare(previousAnchor, clickedElement);
        anchorElement = clickedElement;
      } else {
        frozenElement = clickedElement;
        anchorElement = clickedElement;
        clearGuides();
        renderTarget(clickedElement);
        options.onSelect(clickedElement);
      }

      event.preventDefault();
      event.stopImmediatePropagation();
    },
    { capture: true, signal: options.signal },
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
    { capture: true, signal: options.signal },
  );

  return { clear, destroy };

  function destroy(): void {
    clear();
    highlight.remove();
    label.remove();
    anchorHighlight.remove();
    targetHighlight.remove();
    guideLayer.remove();
  }

  function createBox(
    dataKey: string,
    color: string,
    background: string,
  ): HTMLDivElement {
    const box = document.createElement("div");
    box.dataset[dataKey] = "true";
    box.hidden = true;
    box.style.position = "fixed";
    box.style.border = `2px solid ${color}`;
    box.style.borderRadius = "4px";
    box.style.background = background;
    box.style.boxShadow = "0 0 0 1px rgba(255, 255, 255, 0.88)";
    box.style.pointerEvents = "none";

    return box;
  }

  function renderGuides(reference: Element, target: Element): void {
    guideLayer.textContent = "";
    guideLayer.hidden = false;

    const referenceRect = reference.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();

    renderGuideBox(anchorHighlight, referenceRect);
    renderGuideBox(targetHighlight, targetRect);
    drawEdgeGuide(referenceRect.left, referenceRect, "left", "#ff8a00");
    drawEdgeGuide(targetRect.left, targetRect, "left", "#1f6feb");
    drawCenterGuide(referenceRect, targetRect);
    drawHorizontalRuler(referenceRect, targetRect);
    drawVerticalRuler(referenceRect, targetRect);
  }

  function clearGuides(): void {
    guideLayer.textContent = "";
    guideLayer.hidden = true;
    anchorHighlight.hidden = true;
    targetHighlight.hidden = true;
  }

  function renderGuideBox(element: HTMLElement, rect: DOMRect): void {
    element.hidden = false;
    element.style.left = `${rect.left}px`;
    element.style.top = `${rect.top}px`;
    element.style.width = `${rect.width}px`;
    element.style.height = `${rect.height}px`;
  }

  function drawEdgeGuide(
    x: number,
    rect: DOMRect,
    labelText: string,
    color: string,
  ): void {
    const top = Math.max(0, rect.top - 18);
    const height = rect.height + 36;
    const line = createGuideLine(x, top, 0, height, color, "dashed");
    const marker = createGuideLabel(
      labelText,
      x + 4,
      Math.max(0, rect.top - 18),
      color,
    );

    line.dataset.vernierAlignmentGuide = "edge";
    guideLayer.append(line, marker);
  }

  function drawCenterGuide(referenceRect: DOMRect, targetRect: DOMRect): void {
    const referenceCenter = referenceRect.left + referenceRect.width / 2;
    const targetCenter = targetRect.left + targetRect.width / 2;
    const delta = Math.round(targetCenter - referenceCenter);
    const minTop = Math.min(referenceRect.top, targetRect.top);
    const maxBottom = Math.max(referenceRect.bottom, targetRect.bottom);
    const color = Math.abs(delta) <= 1 ? "#18a058" : "#8b5cf6";
    const line = createGuideLine(
      targetCenter,
      minTop,
      0,
      maxBottom - minTop,
      color,
      "solid",
    );
    const labelElement = createGuideLabel(
      `center ${formatSigned(delta)}px`,
      targetCenter + 6,
      Math.max(0, minTop - 22),
      color,
    );

    line.dataset.vernierAlignmentGuide = "center";
    guideLayer.append(line, labelElement);
  }

  function drawHorizontalRuler(
    referenceRect: DOMRect,
    targetRect: DOMRect,
  ): void {
    const referenceRight = referenceRect.right;
    const targetLeft = targetRect.left;
    const y = Math.min(
      window.innerHeight - 18,
      Math.max(18, Math.min(referenceRect.bottom, targetRect.bottom) + 14),
    );
    const gap = Math.round(targetLeft - referenceRight);
    const start = gap >= 0 ? referenceRight : referenceRect.left;
    const end = gap >= 0 ? targetLeft : targetRect.left;
    const left = Math.min(start, end);
    const width = Math.max(1, Math.abs(end - start));
    const color = gap >= 0 ? "#1f6feb" : "#d1242f";

    const line = createGuideLine(left, y, width, 0, color, "solid");
    line.dataset.vernierRuler = "horizontal";
    guideLayer.append(
      line,
      createRulerCap(left, y, "vertical", color),
      createRulerCap(left + width, y, "vertical", color),
    );
    guideLayer.append(
      createGuideLabel(
        `gap ${formatSigned(gap)}px`,
        left + width / 2,
        y + 6,
        color,
      ),
    );
  }

  function drawVerticalRuler(
    referenceRect: DOMRect,
    targetRect: DOMRect,
  ): void {
    const referenceBottom = referenceRect.bottom;
    const targetTop = targetRect.top;
    const x = Math.min(
      window.innerWidth - 80,
      Math.max(18, Math.max(referenceRect.right, targetRect.right) + 14),
    );
    const gap = Math.round(targetTop - referenceBottom);
    const start = gap >= 0 ? referenceBottom : referenceRect.top;
    const end = gap >= 0 ? targetTop : targetRect.top;
    const top = Math.min(start, end);
    const height = Math.max(1, Math.abs(end - start));
    const color = gap >= 0 ? "#1f6feb" : "#d1242f";

    const line = createGuideLine(x, top, 0, height, color, "solid");
    line.dataset.vernierRuler = "vertical";
    guideLayer.append(
      line,
      createRulerCap(x, top, "horizontal", color),
      createRulerCap(x, top + height, "horizontal", color),
    );
    guideLayer.append(
      createGuideLabel(
        `gap ${formatSigned(gap)}px`,
        x + 8,
        top + height / 2,
        color,
      ),
    );
  }

  function createGuideLine(
    x: number,
    y: number,
    width: number,
    height: number,
    color: string,
    style: "solid" | "dashed",
  ): HTMLDivElement {
    const line = document.createElement("div");
    line.style.position = "fixed";
    line.style.left = `${x}px`;
    line.style.top = `${y}px`;
    line.style.width = `${Math.max(1, width)}px`;
    line.style.height = `${Math.max(1, height)}px`;
    line.style.background = color;
    line.style.opacity = "0.92";
    line.style.pointerEvents = "none";

    if (style === "dashed") {
      line.style.background = `repeating-linear-gradient(${height > width ? "to bottom" : "to right"}, ${color} 0 6px, transparent 6px 10px)`;
    }

    return line;
  }

  function createRulerCap(
    x: number,
    y: number,
    direction: "horizontal" | "vertical",
    color: string,
  ): HTMLDivElement {
    return createGuideLine(
      direction === "horizontal" ? x - 5 : x,
      direction === "horizontal" ? y : y - 5,
      direction === "horizontal" ? 10 : 1,
      direction === "horizontal" ? 1 : 10,
      color,
      "solid",
    );
  }

  function createGuideLabel(
    text: string,
    x: number,
    y: number,
    color: string,
  ): HTMLDivElement {
    const labelElement = document.createElement("div");
    labelElement.dataset.vernierGuideLabel = text;
    labelElement.textContent = text;
    labelElement.style.position = "fixed";
    labelElement.style.left = `${Math.max(0, Math.round(x))}px`;
    labelElement.style.top = `${Math.max(0, Math.round(y))}px`;
    labelElement.style.transform = "translate(-50%, 0)";
    labelElement.style.maxWidth = "160px";
    labelElement.style.padding = "3px 6px";
    labelElement.style.borderRadius = "4px";
    labelElement.style.background = color;
    labelElement.style.color = "#ffffff";
    labelElement.style.font =
      "700 11px/1.2 ui-monospace, SFMono-Regular, Consolas, monospace";
    labelElement.style.whiteSpace = "nowrap";
    labelElement.style.boxShadow = "0 1px 4px rgba(23, 32, 51, 0.22)";
    labelElement.style.pointerEvents = "none";

    return labelElement;
  }

  function formatSigned(value: number): string {
    return value > 0 ? `+${value}` : String(value);
  }
}
