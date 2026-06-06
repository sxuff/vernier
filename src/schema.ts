export interface VernierIssue {
  id: number;
  kind: "single" | "delta" | "annotation";
  measured: string;
  selector: string;
  source: string;
  note: string;
  screenshotName: string;
  screenshotDataUrl: string;
}

export interface VernierSession {
  route: string;
  viewport: {
    width: number;
    height: number;
    devicePixelRatio: number;
  };
  createdAt: string;
  issueCount: number;
  issues: VernierIssue[];
  fullPageScreenshotName: string;
  fullPageScreenshotDataUrl: string;
}
