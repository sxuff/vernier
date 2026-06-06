export interface AnnotationLayer {
  setMode(mode: string): void;
  clear(): void;
}

interface AnnotationOptions {
  onDraft(measured: string): void;
}

interface Point {
  x: number;
  y: number;
}

export function createAnnotationLayer(root: HTMLElement, options: AnnotationOptions): AnnotationLayer {
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
      y: point.y * window.devicePixelRatio
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

    if (mode === "box" && points.length >= 2) {
      const start = scalePoint(points[0]);
      const end = scalePoint(points[points.length - 1]);
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
    const relativePoints = points.map((point) => ({
      x: round(point.x / window.innerWidth),
      y: round(point.y / window.innerHeight)
    }));

    options.onDraft(
      [
        `Annotation: ${mode}`,
        `Viewport: ${window.innerWidth}x${window.innerHeight} @${window.devicePixelRatio}x`,
        `Region: x=${Math.round(bounds.x)}, y=${Math.round(bounds.y)}, w=${Math.round(bounds.w)}, h=${Math.round(bounds.h)}`,
        `Relative points: ${JSON.stringify(relativePoints)}`
      ].join("\n")
    );
  }

  canvas.addEventListener("pointerdown", (event) => {
    if (mode === "measure") {
      return;
    }

    drawing = true;
    points = [toPoint(event)];
    canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!drawing) {
      return;
    }

    points.push(toPoint(event));
    draw();
    event.preventDefault();
  });

  canvas.addEventListener("pointerup", (event) => {
    if (!drawing) {
      return;
    }

    drawing = false;
    points.push(toPoint(event));
    draw();
    finishDraft();
    event.preventDefault();
  });

  window.addEventListener("resize", () => {
    canvas.width = window.innerWidth * window.devicePixelRatio;
    canvas.height = window.innerHeight * window.devicePixelRatio;
    draw();
  });

  return { setMode, clear };

  function getBounds(boundPoints: Point[]): { x: number; y: number; w: number; h: number } {
    const xs = boundPoints.map((point) => point.x);
    const ys = boundPoints.map((point) => point.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const maxX = Math.max(...xs);
    const maxY = Math.max(...ys);

    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  function round(value: number): number {
    return Math.round(value * 10_000) / 10_000;
  }
}
