export interface ElementTarget {
  selector: string;
  selectorConfidence: "high" | "medium" | "low";
  selectorReason: string;
  tag: string;
  id?: string;
  classes: string[];
  text?: string;
  role?: string;
  accessibleName?: string;
  testId?: string;
  nearestTestId?: string;
  source: string;
  sourceConfidence: "high" | "medium" | "low";
  ancestry: Array<{
    tag: string;
    id?: string;
    classes: string[];
    role?: string;
    testId?: string;
    text?: string;
  }>;
}

export interface VernierIssue {
  id: number;
  stableId: string;
  kind: "single" | "delta" | "annotation";
  measured: string;
  selector: string;
  source: string;
  target: ElementTarget;
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
