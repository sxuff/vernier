import { startVernierOverlay } from "../overlay/index";
import { createAnnotationLayer } from "../overlay/annotation";
import {
  accessibleName,
  authoredStyleHints,
  boundingBox,
  classHints,
  collectRuleTokens,
  cssVariableTokens,
  designTokenHints,
  formatNumber,
  formatSigned,
  inlineStyle,
  layoutContext,
  measureDelta,
  measureElement,
  minDistance,
  nearestSiblingDistance,
  nearestToken,
  overflowContext,
  parseColor,
  parsePixelValue,
  pickComputedStyles,
  roundNumber,
  stylePropertyNames,
  textSummary as measurementTextSummary,
  tokenDistance,
  toHex,
  toHexColor
} from "../overlay/measure";
import { createPicker } from "../overlay/picker";
import { getStableSelector } from "../overlay/selector";
import { createSessionController } from "../overlay/session";
import {
  fiberDisplayName,
  findAnnotatedSource,
  findDebugSource,
  findOwnerChain,
  getReactFiber,
  getSourceLocation,
  isRecord,
  isSourceLocation,
  resolveSource,
  trimSourcePath
} from "../overlay/source";
import {
  ancestry,
  createElementTarget,
  createViewportTarget,
  implicitRole,
  nearestAttribute,
  selectorConfidence,
  selectorReason,
  textSummary
} from "../overlay/target";
import { createOverlayRoot, renderIssueList, renderMeasurementPanel, setButtonEnabled } from "../overlay/ui";

export interface OverlayScriptOptions {
  html2canvasImportPath: string;
}

export const vernierOverlayPath = "/__vernier/overlay.js";
export const vernierHtml2CanvasPath = "/__vernier/vendor/html2canvas.js";

export function createVernierOverlayScript(options: OverlayScriptOptions): string {
  return [
    `import html2canvas from ${JSON.stringify(options.html2canvasImportPath)};`,
    getStableSelector.toString(),
    isRecord.toString(),
    isSourceLocation.toString(),
    trimSourcePath.toString(),
    findAnnotatedSource.toString(),
    getReactFiber.toString(),
    findDebugSource.toString(),
    fiberDisplayName.toString(),
    findOwnerChain.toString(),
    resolveSource.toString(),
    getSourceLocation.toString(),
    stylePropertyNames.toString(),
    formatNumber.toString(),
    formatSigned.toString(),
    roundNumber.toString(),
    toHex.toString(),
    toHexColor.toString(),
    boundingBox.toString(),
    pickComputedStyles.toString(),
    inlineStyle.toString(),
    authoredStyleHints.toString(),
    classHints.toString(),
    designTokenHints.toString(),
    cssVariableTokens.toString(),
    collectRuleTokens.toString(),
    nearestToken.toString(),
    tokenDistance.toString(),
    parsePixelValue.toString(),
    parseColor.toString(),
    minDistance.toString(),
    nearestSiblingDistance.toString(),
    overflowContext.toString(),
    layoutContext.toString(),
    measurementTextSummary.toString(),
    accessibleName.toString(),
    measureElement.toString(),
    measureDelta.toString(),
    selectorConfidence.toString(),
    selectorReason.toString(),
    textSummary.toString(),
    nearestAttribute.toString(),
    ancestry.toString(),
    implicitRole.toString(),
    createElementTarget.toString(),
    createViewportTarget.toString(),
    createSessionController.toString(),
    createOverlayRoot.toString(),
    renderMeasurementPanel.toString(),
    renderIssueList.toString(),
    setButtonEnabled.toString(),
    createAnnotationLayer.toString(),
    createPicker.toString(),
    `(${startVernierOverlay.toString()})();`
  ].join("\n");
}
