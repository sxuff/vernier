import { getStableSelector } from "./selector";
import { getSourceLocation } from "./source";

declare const html2canvas: (
  element: HTMLElement,
  options?: { backgroundColor?: string | null }
) => Promise<HTMLCanvasElement>;

type IssueKind = "single" | "delta" | "annotation";

interface SessionIssue {
  id: number;
  kind: IssueKind;
  measured: string;
  selector: string;
  source: string;
  note: string;
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
  getIssues(): SessionIssue[];
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
    const issue: SessionIssue = {
      id,
      kind: draft.kind,
      measured: draft.measured,
      selector: draft.selector,
      source: draft.source,
      note: noteInput.value.trim(),
      screenshotName: `issue-${id}.png`,
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

  async function exportSession(): Promise<void> {
    if (issues.length === 0) {
      throw new Error("Add at least one issue before export");
    }

    const fullPageScreenshotDataUrl = await captureFullPageScreenshot();
    const response = await fetch("/__vernier/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        route: window.location.pathname,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio
        },
        createdAt: new Date().toISOString(),
        issues,
        fullPageScreenshotName: "full-page.png",
        fullPageScreenshotDataUrl
      })
    });

    if (!response.ok) {
      throw new Error(`Export failed with ${response.status}`);
    }
  }

  async function captureScreenshot(element: Element): Promise<string> {
    const canvas = await html2canvas(element as HTMLElement, { backgroundColor: null });

    return canvas.toDataURL("image/png");
  }

  async function captureFullPageScreenshot(): Promise<string> {
    const canvas = await html2canvas(document.documentElement, { backgroundColor: null });

    return canvas.toDataURL("image/png");
  }

  return { setMeasurementDraft, setAnnotationDraft, addDraftIssue, getIssues, exportSession };
}

