import { vernierOverlayBundle } from "./generated/overlay-bundle";
import {
  normalizeOverlayRuntimeOptions,
  type OverlayRuntimeOptions,
} from "./overlay-options";

export interface OverlayScriptOptions {
  html2canvasImportPath: string;
  modernScreenshotImportPath: string;
  runtimeOptions?: OverlayRuntimeOptions;
}

export const vernierOverlayPath = "/__vernier/overlay.js";
export const vernierHtml2CanvasPath = "/__vernier/vendor/html2canvas.js";
export const vernierModernScreenshotPath =
  "/__vernier/vendor/modern-screenshot.js";

export function createVernierOverlayScript(
  options: OverlayScriptOptions,
): string {
  const runtimeOptions = normalizeOverlayRuntimeOptions(options.runtimeOptions);

  return [
    `import __vernierHtml2canvas from ${JSON.stringify(options.html2canvasImportPath)};`,
    `import { domToCanvas as __vernierDomToCanvas } from ${JSON.stringify(options.modernScreenshotImportPath)};`,
    "const html2canvas = __vernierHtml2canvas;",
    "const modernScreenshot = { domToCanvas: __vernierDomToCanvas };",
    `window.__VERNIER_OPTIONS__ = ${JSON.stringify(runtimeOptions)};`,
    vernierOverlayBundle,
  ].join("\n");
}
