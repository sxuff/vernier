import { startVernierOverlay } from "../overlay/index";
import { createAnnotationLayer } from "../overlay/annotation";
import { measureDelta, measureElement } from "../overlay/measure";
import { createPicker } from "../overlay/picker";
import { getStableSelector } from "../overlay/selector";
import { createSessionController } from "../overlay/session";
import { getSourceLocation } from "../overlay/source";
import { createOverlayRoot, renderIssueList, renderMeasurementPanel } from "../overlay/ui";

export interface OverlayScriptOptions {
  html2canvasImportPath: string;
}

export const vernierOverlayPath = "/__vernier/overlay.js";
export const vernierHtml2CanvasPath = "/__vernier/vendor/html2canvas.js";

export function createVernierOverlayScript(options: OverlayScriptOptions): string {
  return [
    `import html2canvas from ${JSON.stringify(options.html2canvasImportPath)};`,
    getStableSelector.toString(),
    getSourceLocation.toString(),
    measureElement.toString(),
    measureDelta.toString(),
    createSessionController.toString(),
    createOverlayRoot.toString(),
    renderMeasurementPanel.toString(),
    renderIssueList.toString(),
    createAnnotationLayer.toString(),
    createPicker.toString(),
    `(${startVernierOverlay.toString()})();`
  ].join("\n");
}
