import { vernierOverlayBundle } from "./generated/overlay-bundle";
import { normalizeOverlayRuntimeOptions, type OverlayRuntimeOptions } from "./overlay-options";

export interface OverlayScriptOptions {
  html2canvasImportPath: string;
  runtimeOptions?: OverlayRuntimeOptions;
}

export const vernierOverlayPath = "/__vernier/overlay.js";
export const vernierHtml2CanvasPath = "/__vernier/vendor/html2canvas.js";

export function createVernierOverlayScript(options: OverlayScriptOptions): string {
  const runtimeOptions = normalizeOverlayRuntimeOptions(options.runtimeOptions);

  return [
    `import __vernierHtml2canvas from ${JSON.stringify(options.html2canvasImportPath)};`,
    "const html2canvas = __vernierHtml2canvas;",
    `window.__VERNIER_OPTIONS__ = ${JSON.stringify(runtimeOptions)};`,
    vernierOverlayBundle
  ].join("\n");
}
