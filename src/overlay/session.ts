import type {
  ElementTarget,
  ScreenshotArtifact,
  VernierMeasurement,
  VernierSuggestion,
} from "../schema";
import {
  getCaptureStrategy,
  getRedactionSelectors,
  getScreenshotMaxWidth,
  getSessionEndpoint,
  shouldCaptureFullPage,
} from "./options";
import { createElementTarget, createViewportTarget } from "./target";

declare const html2canvas: (
  element: HTMLElement,
  options?: {
    backgroundColor?: string | null;
    onclone?: (document: Document) => void;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    windowWidth?: number;
    windowHeight?: number;
  },
) => Promise<HTMLCanvasElement>;

declare const modernScreenshot: {
  domToCanvas(
    element: HTMLElement,
    options?: {
      backgroundColor?: string | null;
      width?: number;
      height?: number;
      scale?: number;
      onCloneNode?: (cloned: Node) => void | Promise<void>;
    },
  ): Promise<HTMLCanvasElement>;
};

type IssueKind = "single" | "delta" | "annotation";

interface SessionIssue {
  id: number;
  stableId: string;
  kind: IssueKind;
  measured: string;
  selector: string;
  source: string;
  target: ElementTarget;
  measurement: VernierMeasurement;
  suggestions?: VernierSuggestion[];
  note: string;
  createdAt: string;
  screenshotName: string;
  screenshotDataUrl: string;
  screenshot: ScreenshotArtifact;
  redaction: {
    autoRedactedElements: number;
    manualRedaction: boolean;
  };
}

interface DraftIssue {
  kind: IssueKind;
  measured: string;
  selector: string;
  source: string;
  target: ElementTarget;
  measurement: VernierMeasurement;
  suggestions?: VernierSuggestion[];
  screenshotTarget: Element;
}

interface SessionController {
  setMeasurementDraft(
    kind: "single" | "delta",
    element: Element,
    measured: string,
    measurement: VernierMeasurement,
    suggestions?: VernierSuggestion[],
  ): void;
  setAnnotationDraft(measured: string, measurement: VernierMeasurement): void;
  addDraftIssue(): Promise<SessionIssue | null>;
  updateIssueNote(
    id: number,
    note: string,
    label?: string,
  ): SessionIssue | null;
  deleteIssue(id: number): void;
  clearIssues(): void;
  getIssues(): SessionIssue[];
  createMarkdownPreview(): string;
  createAgentPrompt(): string;
  exportSession(): Promise<void>;
}

export function createSessionController(
  noteInput: HTMLTextAreaElement,
): SessionController {
  const issues: SessionIssue[] = [];
  let draft: DraftIssue | null = null;

  function setMeasurementDraft(
    kind: "single" | "delta",
    element: Element,
    measured: string,
    measurement: VernierMeasurement,
    suggestions?: VernierSuggestion[],
  ): void {
    const target = createElementTarget(element);

    draft = {
      kind,
      measured,
      selector: target.selector,
      source: target.source,
      target,
      measurement,
      suggestions,
      screenshotTarget: element,
    };
  }

  function setAnnotationDraft(
    measured: string,
    measurement: VernierMeasurement,
  ): void {
    draft = {
      kind: "annotation",
      measured,
      selector: "viewport",
      source: "unresolved",
      target: createViewportTarget(),
      measurement,
      screenshotTarget: document.documentElement,
    };
  }

  async function addDraftIssue(): Promise<SessionIssue | null> {
    if (!draft) {
      return null;
    }

    const id = issues.length + 1;
    const stableId = createStableId();
    const screenshotName = `issue-${stableId}.png`;
    const screenshot = await captureScreenshot(
      draft.screenshotTarget,
      screenshotName,
      "element",
    );
    const issue: SessionIssue = {
      id,
      stableId,
      kind: draft.kind,
      measured: draft.measured,
      selector: draft.selector,
      source: draft.source,
      target: draft.target,
      measurement: draft.measurement,
      suggestions: draft.suggestions,
      note: noteInput.value.trim(),
      createdAt: new Date().toISOString(),
      screenshotName,
      screenshotDataUrl: screenshot.dataUrl,
      screenshot: screenshot.artifact,
      redaction: {
        autoRedactedElements: screenshot.autoRedactedElements,
        manualRedaction:
          draft.measurement.kind === "annotation" &&
          draft.measurement.mode === "redact",
      },
    };

    issues.push(issue);
    draft = null;
    noteInput.value = "";

    return issue;
  }

  function getIssues(): SessionIssue[] {
    return [...issues];
  }

  function updateIssueNote(
    id: number,
    note: string,
    label?: string,
  ): SessionIssue | null {
    const issue = issues.find((candidate) => candidate.id === id);

    if (!issue) {
      return null;
    }

    issue.note = note.trim();
    if (issue.measurement.kind === "annotation") {
      issue.measurement.label = label || undefined;
      issue.measured = withAnnotationLabel(
        issue.measured,
        issue.measurement.label,
      );
    }

    return issue;
  }

  function deleteIssue(id: number): void {
    const index = issues.findIndex((issue) => issue.id === id);

    if (index < 0) {
      return;
    }

    issues.splice(index, 1);
    renumberIssues();
  }

  function clearIssues(): void {
    issues.splice(0, issues.length);
    draft = null;
  }

  async function exportSession(): Promise<void> {
    if (issues.length === 0) {
      throw new Error("Add at least one issue before export");
    }

    const fullPageScreenshot = await captureFullPageScreenshot();
    const response = await fetch(getSessionEndpoint(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 1,
        toolVersion: "0.0.0",
        sessionId: createStableId("s"),
        route: window.location.pathname,
        url: window.location.href,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio,
        },
        createdAt: new Date().toISOString(),
        issueCount: issues.length,
        issues,
        fullPageScreenshotName: fullPageScreenshot.artifact.name,
        fullPageScreenshotDataUrl: fullPageScreenshot.dataUrl,
        fullPageScreenshot: fullPageScreenshot.artifact,
      }),
    });

    if (!response.ok) {
      throw new Error(`Export failed with ${response.status}`);
    }
  }

  function createMarkdownPreview(): string {
    return [
      "# UI Feedback Session - Vernier",
      `Route: ${window.location.pathname}`,
      `Viewport: ${window.innerWidth}x${window.innerHeight} @${window.devicePixelRatio}x`,
      `Issue count: ${issues.length}`,
      "",
      ...issues.flatMap((issue) => [
        `## Issue ${issue.id} - ${issue.kind}`,
        "Instruction:",
        issue.note || "Fix the measured UI issue. Prefer minimal changes.",
        "",
        "Measured:",
        ...issue.measured.split("\n").map((line) => `- ${line}`),
        "",
        "Target:",
        `Selector: ${issue.selector}`,
        `Source: ${issue.source}`,
        "",
      ]),
    ].join("\n");
  }

  function createAgentPrompt(): string {
    return [
      "Use the Vernier UI feedback session below.",
      "Fix each issue with minimal changes.",
      "Map each code change back to an issue number.",
      "Run the smallest relevant checks and summarize verification.",
      "",
      createMarkdownPreview().trim(),
      "",
    ].join("\n");
  }

  async function captureScreenshot(
    element: Element,
    name: string,
    kind: ScreenshotArtifact["kind"],
  ): Promise<{
    dataUrl: string;
    artifact: ScreenshotArtifact;
    autoRedactedElements: number;
  }> {
    const strategy = getCaptureStrategy();
    let canvas: HTMLCanvasElement;
    const autoRedactedElements = countAutoRedactionTargets(element);

    try {
      canvas = await captureWithStrategy(strategy, element, kind);
    } catch (error) {
      throw new Error(
        `Screenshot capture failed: ${formatCaptureError(error)}`,
      );
    }

    const outputCanvas = resizeScreenshotCanvas(canvas);
    const dataUrl = outputCanvas.toDataURL("image/png");
    return {
      dataUrl,
      artifact: await createScreenshotArtifact(
        name,
        kind,
        strategy,
        outputCanvas,
        dataUrl,
      ),
      autoRedactedElements,
    };
  }

  async function captureWithStrategy(
    strategy: ScreenshotArtifact["captureStrategy"],
    element: Element,
    kind: ScreenshotArtifact["kind"],
  ): Promise<HTMLCanvasElement> {
    if (strategy === "modern-screenshot") {
      return modernScreenshot.domToCanvas(element as HTMLElement, {
        backgroundColor: null,
        ...modernScreenshotSizeOptions(kind, element),
        scale: window.devicePixelRatio,
        onCloneNode(cloned) {
          if (cloned instanceof Element && isAutoRedactionTarget(cloned)) {
            redactElement(cloned);
          }
        },
      });
    }

    if (strategy !== "html2canvas") {
      throw new Error(`Unsupported overlay capture strategy: ${strategy}`);
    }

    return html2canvas(element as HTMLElement, {
      backgroundColor: null,
      ...viewportCropOptions(kind),
      onclone(clonedDocument) {
        applyAutoRedaction(clonedDocument);
      },
    });
  }

  function modernScreenshotSizeOptions(
    kind: ScreenshotArtifact["kind"],
    element: Element,
  ): { width?: number; height?: number } {
    if (kind === "full-page" && !shouldCaptureFullPage()) {
      return {
        width: window.innerWidth,
        height: window.innerHeight,
      };
    }

    if (element === document.documentElement) {
      return {};
    }

    const rect = element.getBoundingClientRect();
    return {
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
    };
  }

  async function captureFullPageScreenshot(): Promise<{
    dataUrl: string;
    artifact: ScreenshotArtifact;
  }> {
    try {
      const captured = await captureScreenshot(
        document.documentElement,
        "full-page.png",
        "full-page",
      );
      return { dataUrl: captured.dataUrl, artifact: captured.artifact };
    } catch (error) {
      throw new Error(
        `Full-page screenshot capture failed: ${formatCaptureError(error)}`,
      );
    }
  }

  function viewportCropOptions(kind: ScreenshotArtifact["kind"]): {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    windowWidth?: number;
    windowHeight?: number;
  } {
    if (kind !== "full-page" || shouldCaptureFullPage()) {
      return {};
    }

    return {
      x: window.scrollX,
      y: window.scrollY,
      width: window.innerWidth,
      height: window.innerHeight,
      windowWidth: window.innerWidth,
      windowHeight: window.innerHeight,
    };
  }

  async function createScreenshotArtifact(
    name: string,
    kind: ScreenshotArtifact["kind"],
    captureStrategy: ScreenshotArtifact["captureStrategy"],
    canvas: HTMLCanvasElement,
    dataUrl: string,
  ): Promise<ScreenshotArtifact> {
    const bytes = dataUrlBytes(dataUrl);

    return {
      name,
      kind,
      width: canvas.width,
      height: canvas.height,
      devicePixelRatio: window.devicePixelRatio,
      captureStrategy,
      mimeType: "image/png",
      byteLength: bytes.byteLength,
      hash: await sha256(bytes),
    };
  }

  function dataUrlBytes(dataUrl: string): Uint8Array {
    const base64 = dataUrl.split(",")[1] ?? "";
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return bytes;
  }

  function resizeScreenshotCanvas(
    canvas: HTMLCanvasElement,
  ): HTMLCanvasElement {
    const maxWidth = getScreenshotMaxWidth();

    if (!maxWidth || canvas.width <= maxWidth) {
      return canvas;
    }

    const scale = maxWidth / canvas.width;
    const resized = document.createElement("canvas");
    resized.width = maxWidth;
    resized.height = Math.max(1, Math.round(canvas.height * scale));

    const context = resized.getContext("2d");
    if (!context) {
      return canvas;
    }

    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(canvas, 0, 0, resized.width, resized.height);

    return resized;
  }

  async function sha256(bytes: Uint8Array): Promise<string> {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const digest = await crypto.subtle.digest(
      "SHA-256",
      copy.buffer as ArrayBuffer,
    );
    const hashBytes = Array.from(new Uint8Array(digest));

    return `sha256-${hashBytes.map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }

  function formatCaptureError(error: unknown): string {
    return error instanceof Error ? error.message : "unknown capture error";
  }

  function countAutoRedactionTargets(root: Element): number {
    return autoRedactionTargets(root).length;
  }

  function autoRedactionTargets(root: ParentNode): Element[] {
    const selectors = getRedactionSelectors();
    const targets = selectors.flatMap((selector) => {
      try {
        return Array.from(root.querySelectorAll(selector));
      } catch {
        return [];
      }
    });

    const rootMatches =
      root instanceof Element &&
      selectors.some((selector) => {
        try {
          return root.matches(selector);
        } catch {
          return false;
        }
      });

    return rootMatches ? [root, ...targets] : targets;
  }

  function applyAutoRedaction(clonedDocument: Document): void {
    for (const element of autoRedactionTargets(clonedDocument)) {
      redactElement(element);
    }
  }

  function isAutoRedactionTarget(element: Element): boolean {
    return getRedactionSelectors().some((selector) => {
      try {
        return element.matches(selector);
      } catch {
        return false;
      }
    });
  }

  function redactElement(element: Element): void {
    const htmlElement = element as HTMLElement;

    if (
      htmlElement instanceof HTMLInputElement ||
      htmlElement instanceof HTMLTextAreaElement
    ) {
      htmlElement.value = "";
      htmlElement.setAttribute("value", "");
    }

    htmlElement.textContent = "";
    htmlElement.style.setProperty("background", "#111827", "important");
    htmlElement.style.setProperty("background-color", "#111827", "important");
    htmlElement.style.setProperty("color", "transparent", "important");
    htmlElement.style.setProperty("border-color", "#111827", "important");
    htmlElement.style.setProperty("box-shadow", "none", "important");
    htmlElement.style.setProperty("text-shadow", "none", "important");
  }

  function renumberIssues(): void {
    issues.forEach((issue, index) => {
      const nextId = index + 1;
      issue.id = nextId;
    });
  }

  function withAnnotationLabel(
    measured: string,
    label: string | undefined,
  ): string {
    const lines = measured
      .split("\n")
      .filter((line) => !line.startsWith("Label: "));

    if (label) {
      lines.splice(1, 0, `Label: ${label}`);
    }

    return lines.join("\n");
  }

  function createStableId(prefix = "i"): string {
    const random = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    const length = prefix === "i" ? 6 : 12;

    return `${prefix}-${random
      .replace(/[^a-zA-Z0-9]/g, "")
      .slice(0, length)
      .toLowerCase()}`;
  }

  return {
    setMeasurementDraft,
    setAnnotationDraft,
    addDraftIssue,
    updateIssueNote,
    deleteIssue,
    clearIssues,
    getIssues,
    createMarkdownPreview,
    createAgentPrompt,
    exportSession,
  };
}
