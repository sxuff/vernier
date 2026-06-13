import { createVernierOverlayScript } from "../dist/index.js";

const script = createVernierOverlayScript({
  html2canvasImportPath: "html2canvas",
  modernScreenshotImportPath: "modern-screenshot",
  runtimeOptions: {
    hotkey: "Alt+Shift+V",
    styleProperties: ["color", "letter-spacing", "color"],
    redact: [".private-email", "[data-secret]"],
    sessionEndpoint: "http://127.0.0.1:3333/__vernier/session",
    captureFullPage: false,
    screenshotMaxWidth: 1024,
    captureStrategy: "modern-screenshot",
  },
});

assert(
  script.includes('import __vernierHtml2canvas from "html2canvas";'),
  "expected html2canvas import",
);
assert(
  script.includes('from "modern-screenshot";'),
  "expected modern-screenshot import",
);
assert(
  script.includes('"hotkey":"Alt+Shift+V"'),
  "expected hotkey runtime option",
);
assert(
  script.includes('"styleProperties":["color","letter-spacing"]'),
  "expected deduplicated style properties",
);
assert(
  script.includes('"redact":[".private-email","[data-secret]"]'),
  "expected redaction selectors",
);
assert(
  script.includes(
    '"sessionEndpoint":"http://127.0.0.1:3333/__vernier/session"',
  ),
  "expected session endpoint runtime option",
);
assert(
  script.includes('"captureFullPage":false'),
  "expected full-page capture runtime option",
);
assert(
  script.includes('"screenshotMaxWidth":1024'),
  "expected screenshot max width runtime option",
);
assert(
  script.includes('"captureStrategy":"modern-screenshot"'),
  "expected capture strategy runtime option",
);

const defaultScript = createVernierOverlayScript({
  html2canvasImportPath: "/vendor/html2canvas.js",
  modernScreenshotImportPath: "/vendor/modern-screenshot.js",
});
assert(
  defaultScript.includes("window.__VERNIER_OPTIONS__ = {};"),
  "expected empty default runtime options",
);

console.log("overlay options verified");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
