import { getStableSelector } from "./selector";
import { getSourceLocation } from "./source";

declare const html2canvas: (
  element: HTMLElement,
  options?: { backgroundColor?: string | null }
) => Promise<HTMLCanvasElement>;

type IssueKind = "single" | "delta" | "annotation";

interface SessionIssue {
  id: number;
  stableId: string;
  kind: IssueKind;
  measured: string;
  selector: string;
  source: string;
  note: string;
  createdAt: string;
  screenshotName: string;
  screenshotDataUrl: string;
}

interface DraftIssue {
  kind: IssueKind;
  measured: string;
  selector: string;
  source: string;
  screenshotTarget: Element;
}

interface SessionController {
  setMeasurementDraft(kind: "single" | "delta", element: Element, measured: string): void;
  setAnnotationDraft(measured: string): void;
  addDraftIssue(): Promise<SessionIssue | null>;
  updateIssueNote(id: number, note: string): SessionIssue | null;
  deleteIssue(id: number): void;
  clearIssues(): void;
  getIssues(): SessionIssue[];
  createMarkdownPreview(): string;
  createAgentPrompt(): string;
  exportSession(): Promise<void>;
}

export function createSessionController(noteInput: HTMLTextAreaElement): SessionController {
  const issues: SessionIssue[] = [];
  let draft: DraftIssue | null = null;

  function setMeasurementDraft(kind: "single" | "delta", element: Element, measured: string): void {
    draft = {
      kind,
      measured,
      selector: getStableSelector(element),
      source: getSourceLocation(element),
      screenshotTarget: element
    };
  }

  function setAnnotationDraft(measured: string): void {
    draft = {
      kind: "annotation",
      measured,
      selector: "viewport",
      source: "unresolved",
      screenshotTarget: document.documentElement
    };
  }

  async function addDraftIssue(): Promise<SessionIssue | null> {
    if (!draft) {
      return null;
    }

    const id = issues.length + 1;
    const stableId = createStableId();
    const issue: SessionIssue = {
      id,
      stableId,
      kind: draft.kind,
      measured: draft.measured,
      selector: draft.selector,
      source: draft.source,
      note: noteInput.value.trim(),
      createdAt: new Date().toISOString(),
      screenshotName: `issue-${stableId}.png`,
      screenshotDataUrl: await captureScreenshot(draft.screenshotTarget)
    };

    issues.push(issue);
    draft = null;
    noteInput.value = "";

    return issue;
  }

  function getIssues(): SessionIssue[] {
    return [...issues];
  }

  function updateIssueNote(id: number, note: string): SessionIssue | null {
    const issue = issues.find((candidate) => candidate.id === id);

    if (!issue) {
      return null;
    }

    issue.note = note.trim();

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

    const fullPageScreenshotDataUrl = await captureFullPageScreenshot();
    const response = await fetch("/__vernier/session", {
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
          devicePixelRatio: window.devicePixelRatio
        },
        createdAt: new Date().toISOString(),
        issueCount: issues.length,
        issues,
        fullPageScreenshotName: "full-page.png",
        fullPageScreenshotDataUrl
      })
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
        ""
      ])
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
      ""
    ].join("\n");
  }

  async function captureScreenshot(element: Element): Promise<string> {
    let canvas: HTMLCanvasElement;

    try {
      canvas = await html2canvas(element as HTMLElement, { backgroundColor: null });
    } catch (error) {
      throw new Error(`Screenshot capture failed: ${formatCaptureError(error)}`);
    }

    return canvas.toDataURL("image/png");
  }

  async function captureFullPageScreenshot(): Promise<string> {
    let canvas: HTMLCanvasElement;

    try {
      canvas = await html2canvas(document.documentElement, { backgroundColor: null });
    } catch (error) {
      throw new Error(`Full-page screenshot capture failed: ${formatCaptureError(error)}`);
    }

    return canvas.toDataURL("image/png");
  }

  function formatCaptureError(error: unknown): string {
    return error instanceof Error ? error.message : "unknown capture error";
  }

  function renumberIssues(): void {
    issues.forEach((issue, index) => {
      const nextId = index + 1;
      issue.id = nextId;
    });
  }

  function createStableId(prefix = "i"): string {
    const random = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    const length = prefix === "i" ? 6 : 12;

    return `${prefix}-${random.replace(/[^a-zA-Z0-9]/g, "").slice(0, length).toLowerCase()}`;
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
    exportSession
  };
}
