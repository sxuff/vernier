import type { AnnotationMeasurement } from "../schema";

export interface AnnotationLayer {
  setMode(mode: string): void;
  clear(): void;
  destroy(): void;
}

interface AnnotationOptions {
  onDraft(measured: string, measurement: AnnotationMeasurement): void;
  getLabel?: () => string | undefined;
  signal?: AbortSignal;
}

interface Point {
  x: number;
  y: number;
}

export function createAnnotationLayer(
  root: HTMLElement,
  options: AnnotationOptions,
): AnnotationLayer {
  let mode = "measure";
  let drawing = false;
  let points: Point[] = [];

  const canvas = document.createElement("canvas");
  canvas.dataset.vernierAnnotationCanvas = "true";
  canvas.width = window.innerWidth * window.devicePixelRatio;
  canvas.height = window.innerHeight * window.devicePixelRatio;
  canvas.style.position = "fixed";
  canvas.style.inset = "0";
  canvas.style.width = "100vw";
  canvas.style.height = "100vh";
  canvas.style.zIndex = "1";
  canvas.style.pointerEvents = "none";

  const context = canvas.getContext("2d");
  root.append(canvas);
  options.signal?.addEventListener("abort", destroy, { once: true });

  function setMode(nextMode: string): void {
    mode = nextMode;
    canvas.style.pointerEvents = mode === "measure" ? "none" : "auto";
  }

  function clear(): void {
    points = [];

    if (context) {
      context.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  function toPoint(event: PointerEvent): Point {
    return { x: event.clientX, y: event.clientY };
  }

  function scalePoint(point: Point): Point {
    return {
      x: point.x * window.devicePixelRatio,
      y: point.y * window.devicePixelRatio,
    };
  }

  function draw(): void {
    if (!context || points.length === 0) {
      return;
    }

    context.clearRect(0, 0, canvas.width, canvas.height);
    context.lineWidth = 3 * window.devicePixelRatio;
    context.strokeStyle = "#ff3366";
    context.fillStyle = "rgba(255, 51, 102, 0.08)";
    context.lineCap = "round";
    context.lineJoin = "round";

    if ((mode === "box" || mode === "redact") && points.length >= 2) {
      const start = scalePoint(points[0]);
      const end = scalePoint(points[points.length - 1]);
      if (mode === "redact") {
        context.fillStyle = "#111827";
        context.fillRect(start.x, start.y, end.x - start.x, end.y - start.y);
        return;
      }
      context.strokeRect(start.x, start.y, end.x - start.x, end.y - start.y);
      context.fillRect(start.x, start.y, end.x - start.x, end.y - start.y);
      return;
    }

    context.beginPath();
    points.forEach((point, index) => {
      const scaled = scalePoint(point);

      if (index === 0) {
        context.moveTo(scaled.x, scaled.y);
      } else {
        context.lineTo(scaled.x, scaled.y);
      }
    });
    context.stroke();
  }

  function finishDraft(): void {
    if (points.length < 2) {
      return;
    }

    const bounds = getBounds(points);
    const normalizedBounds = normalizeBounds(bounds);
    const relativePoints = points.map((point) => ({
      x: round(point.x / window.innerWidth),
      y: round(point.y / window.innerHeight),
    }));
    const measurement: AnnotationMeasurement = {
      kind: "annotation",
      mode: mode === "box" || mode === "redact" ? mode : "pen",
      label: options.getLabel?.(),
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
      },
      bounds: normalizedBounds,
      relativeBounds: {
        x: round(normalizedBounds.x / window.innerWidth),
        y: round(normalizedBounds.y / window.innerHeight),
        width: round(normalizedBounds.width / window.innerWidth),
        height: round(normalizedBounds.height / window.innerHeight),
      },
      points: points.map((point) => ({
        x: round(point.x),
        y: round(point.y),
      })),
      relativePoints,
    };

    options.onDraft(
      [
        `Annotation: ${mode}`,
        measurement.label ? `Label: ${measurement.label}` : null,
        `Viewport: ${window.innerWidth}x${window.innerHeight} @${window.devicePixelRatio}x`,
        `Region: x=${Math.round(normalizedBounds.x)}, y=${Math.round(normalizedBounds.y)}, w=${Math.round(normalizedBounds.width)}, h=${Math.round(normalizedBounds.height)}`,
        `Relative points: ${JSON.stringify(relativePoints)}`,
      ]
        .filter((line): line is string => line !== null)
        .join("\n"),
      measurement,
    );
  }

  canvas.addEventListener(
    "pointerdown",
    (event) => {
      if (mode === "measure") {
        return;
      }

      drawing = true;
      points = [toPoint(event)];
      canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
    },
    { signal: options.signal },
  );

  canvas.addEventListener(
    "pointermove",
    (event) => {
      if (!drawing) {
        return;
      }

      points.push(toPoint(event));
      draw();
      event.preventDefault();
    },
    { signal: options.signal },
  );

  canvas.addEventListener(
    "pointerup",
    (event) => {
      if (!drawing) {
        return;
      }

      drawing = false;
      points.push(toPoint(event));
      draw();
      finishDraft();
      event.preventDefault();
    },
    { signal: options.signal },
  );

  window.addEventListener(
    "resize",
    () => {
      canvas.width = window.innerWidth * window.devicePixelRatio;
      canvas.height = window.innerHeight * window.devicePixelRatio;
      draw();
    },
    { signal: options.signal },
  );

  return { setMode, clear, destroy };

  function destroy(): void {
    clear();
    canvas.remove();
  }

  function getBounds(boundPoints: Point[]): {
    x: number;
    y: number;
    w: number;
    h: number;
  } {
    const xs = boundPoints.map((point) => point.x);
    const ys = boundPoints.map((point) => point.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const maxX = Math.max(...xs);
    const maxY = Math.max(...ys);

    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  function normalizeBounds(bounds: {
    x: number;
    y: number;
    w: number;
    h: number;
  }): AnnotationMeasurement["bounds"] {
    return {
      x: round(bounds.w < 0 ? bounds.x + bounds.w : bounds.x),
      y: round(bounds.h < 0 ? bounds.y + bounds.h : bounds.y),
      width: round(Math.abs(bounds.w)),
      height: round(Math.abs(bounds.h)),
    };
  }

  function round(value: number): number {
    return Math.round(value * 10_000) / 10_000;
  }
}
