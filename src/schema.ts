export interface ElementTarget {
  selector: string;
  fallbackSelector?: string;
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
  nearestLandmark?: string;
  source: string;
  sourceConfidence: "high" | "medium" | "low";
  sourceResolver: string;
  componentName?: string;
  ownerChain: string[];
  ancestry: Array<{
    tag: string;
    id?: string;
    classes: string[];
    role?: string;
    testId?: string;
    text?: string;
  }>;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface AuthoredStyleHint {
  selector: string;
  property: string;
  value: string;
  source: string;
}

export interface DesignTokenHint {
  property: string;
  computed: string;
  token: string;
  value: string;
  distance: number;
}

export interface LayoutContext {
  parentSelector?: string;
  parentDisplay?: string;
  parentGap?: string;
  parentRowGap?: string;
  parentColumnGap?: string;
  parentPadding?: string;
  gridTemplateColumns?: string;
  flexDirection?: string;
  nearestSiblingDistance?: {
    left?: number;
    right?: number;
    top?: number;
    bottom?: number;
  };
  overflow?: {
    x: string;
    y: string;
    clippedByParent: boolean;
    horizontalPageScroll: boolean;
  };
}

export interface TextMetrics {
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
  lineHeight: string;
  letterSpacing: string;
  textTransform: string;
  textOverflow: string;
  whiteSpace: string;
  renderedLineCount?: number;
}

export interface StackingContext {
  position: string;
  zIndex: string;
  opacity: string;
  transform: string;
  isolation: string;
  stackingAncestors: Array<{
    selector: string;
    position: string;
    zIndex: string;
    opacity: string;
    transform: string;
    isolation: string;
  }>;
}

export interface SingleMeasurement {
  kind: "single";
  bbox: BoundingBox;
  computedStyle: Record<string, string>;
  text?: string;
  role?: string;
  accessibleName?: string;
  inlineStyle?: Record<string, string>;
  authoredHints: AuthoredStyleHint[];
  classHints: string[];
  designTokenHints: DesignTokenHint[];
  layoutContext?: LayoutContext;
  textMetrics?: TextMetrics;
  stackingContext?: StackingContext;
}

export interface DeltaMeasurement {
  kind: "delta";
  reference: ElementTarget;
  target: ElementTarget;
  referenceBbox: BoundingBox;
  targetBbox: BoundingBox;
  delta: {
    left: number;
    top: number;
    width: number;
    height: number;
    color?: [string, string];
    backgroundColor?: [string, string];
    fontSize?: [string, string];
  };
  alignment?: {
    leftAligned: boolean;
    topAligned: boolean;
    centerAligned: boolean;
    centerDelta: number;
    horizontalGap: number;
    verticalGap: number;
  };
  layoutContext?: LayoutContext;
  classHints: string[];
  designTokenHints: DesignTokenHint[];
  textMetrics?: TextMetrics;
  stackingContext?: StackingContext;
}

export interface AnnotationMeasurement {
  kind: "annotation";
  mode: "pen" | "box" | "redact";
  label?: string;
  viewport: {
    width: number;
    height: number;
    devicePixelRatio: number;
  };
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  relativeBounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  points: Array<{ x: number; y: number }>;
  relativePoints: Array<{ x: number; y: number }>;
}

export type VernierMeasurement =
  | SingleMeasurement
  | DeltaMeasurement
  | AnnotationMeasurement;

export type CaptureStrategy =
  | "html2canvas"
  | "modern-screenshot"
  | "playwright"
  | "browser-native";

export interface VernierAssertion {
  property: string;
  expected: string;
  actual: string;
  tolerance?: number;
  passed: boolean;
  createdAt: string;
}

export interface VernierSuggestion {
  type:
    | "low-contrast"
    | "tap-target"
    | "missing-accessible-name"
    | "focus-ring"
    | "text-overflow"
    | "clipping"
    | "stacking-context"
    | "token-hint";
  severity: "low" | "medium" | "high";
  message: string;
  expected: string;
  actual: string;
}

export interface ScreenshotArtifact {
  name: string;
  kind: "element" | "full-page";
  width: number;
  height: number;
  devicePixelRatio: number;
  captureStrategy: CaptureStrategy;
  mimeType: "image/png";
  byteLength: number;
  hash: string;
}

export interface VernierIssue {
  id: number;
  stableId: string;
  kind: "single" | "delta" | "annotation";
  measured: string;
  selector: string;
  source: string;
  target: ElementTarget;
  measurement?: VernierMeasurement;
  assertions?: VernierAssertion[];
  suggestions?: VernierSuggestion[];
  redaction?: {
    autoRedactedElements: number;
    manualRedaction: boolean;
  };
  note: string;
  createdAt: string;
  screenshotName: string;
  screenshotDataUrl?: string;
  screenshot: ScreenshotArtifact;
}

export interface VernierSession {
  schemaVersion: 1;
  toolVersion: string;
  sessionId: string;
  title?: string;
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
  fullPageScreenshotDataUrl?: string;
  fullPageScreenshot: ScreenshotArtifact;
}
