import { createVernierOverlayScript } from "../dist/index.js";

const script = createVernierOverlayScript({
  html2canvasImportPath: "html2canvas",
  runtimeOptions: {
    hotkey: "Alt+Shift+V",
    styleProperties: ["color", "letter-spacing", "color"],
    redact: [".private-email", "[data-secret]"]
  }
});

assert(script.includes('import __vernierHtml2canvas from "html2canvas";'), "expected html2canvas import");
assert(script.includes('"hotkey":"Alt+Shift+V"'), "expected hotkey runtime option");
assert(script.includes('"styleProperties":["color","letter-spacing"]'), "expected deduplicated style properties");
assert(script.includes('"redact":[".private-email","[data-secret]"]'), "expected redaction selectors");

const defaultScript = createVernierOverlayScript({ html2canvasImportPath: "/vendor/html2canvas.js" });
assert(defaultScript.includes("window.__VERNIER_OPTIONS__ = {};"), "expected empty default runtime options");

console.log("overlay options verified");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
