export interface VernierIssue {
  id: number;
  stableId: string;
  kind: "single" | "delta" | "annotation";
  measured: string;
  selector: string;
  source: string;
  note: string;
  createdAt: string;
  screenshotName: string;
  screenshotDataUrl: string;
}

export interface VernierSession {
  schemaVersion: 1;
  toolVersion: string;
  sessionId: string;
  route: string;
  url: string;
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
