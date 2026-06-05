import { getStableSelector } from "./selector";
import { getSourceLocation } from "./source";

declare const html2canvas: (
  element: HTMLElement,
  options?: { backgroundColor?: string | null }
) => Promise<HTMLCanvasElement>;

interface SessionIssue {
  id: number;
  kind: "single" | "delta";
  measured: string;
  selector: string;
  source: string;
  note: string;
  screenshotName: string;
  screenshotDataUrl: string;
}

interface SessionController {
  recordIssue(kind: "single" | "delta", element: Element, measured: string): void;
  exportSession(): Promise<void>;
}

export function createSessionController(noteInput: HTMLTextAreaElement): SessionController {
  const issues: SessionIssue[] = [];
  const pendingScreenshots: Promise<void>[] = [];

  function recordIssue(kind: "single" | "delta", element: Element, measured: string): void {
    const id = issues.length + 1;
    const issue: SessionIssue = {
      id,
      kind,
      measured,
      selector: getStableSelector(element),
      source: getSourceLocation(element),
      note: noteInput.value.trim(),
      screenshotName: `issue-${id}.png`,
      screenshotDataUrl: ""
    };

    issues.push(issue);
    pendingScreenshots.push(captureElementScreenshot(element, issue));
  }

  async function exportSession(): Promise<void> {
    await Promise.all(pendingScreenshots);

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

  async function captureElementScreenshot(element: Element, issue: SessionIssue): Promise<void> {
    const canvas = await html2canvas(element as HTMLElement, { backgroundColor: null });
    issue.screenshotDataUrl = canvas.toDataURL("image/png");
  }

  async function captureFullPageScreenshot(): Promise<string> {
    const canvas = await html2canvas(document.documentElement, { backgroundColor: null });

    return canvas.toDataURL("image/png");
  }

  return { recordIssue, exportSession };
}
