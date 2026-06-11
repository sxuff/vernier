import { vernierOverlayBundle } from "./generated/overlay-bundle";

export interface OverlayScriptOptions {
  html2canvasImportPath: string;
}

export const vernierOverlayPath = "/__vernier/overlay.js";
export const vernierHtml2CanvasPath = "/__vernier/vendor/html2canvas.js";

export function createVernierOverlayScript(options: OverlayScriptOptions): string {
  return [
    `import __vernierHtml2canvas from ${JSON.stringify(options.html2canvasImportPath)};`,
    "const html2canvas = __vernierHtml2canvas;",
    vernierOverlayBundle
  ].join("\n");
}
