import { auditElementMeasurement, contrastRatio } from "../dist/index.js";

const measurement = {
  kind: "single",
  bbox: {
    x: 0,
    y: 0,
    width: 24,
    height: 20,
    top: 0,
    right: 24,
    bottom: 20,
    left: 0,
  },
  computedStyle: {
    color: "#777777",
    "background-color": "#888888",
    outline: "none",
    "outline-style": "none",
    "outline-width": "0px",
    "box-shadow": "none",
  },
  text: "",
  authoredHints: [],
  classHints: ["px-2"],
  designTokenHints: [],
  layoutContext: {
    overflow: {
      x: "hidden",
      y: "hidden",
      clippedByParent: true,
      horizontalPageScroll: false,
    },
  },
  textMetrics: {
    fontFamily: "system-ui",
    fontSize: "14px",
    fontWeight: "400",
    lineHeight: "20px",
    letterSpacing: "0px",
    textTransform: "none",
    textOverflow: "clip",
    whiteSpace: "nowrap",
    renderedLineCount: 1,
  },
  stackingContext: {
    position: "relative",
    zIndex: "10",
    opacity: "1",
    transform: "none",
    isolation: "auto",
    stackingAncestors: [],
  },
};

const suggestions = auditElementMeasurement({
  tag: "button",
  role: "button",
  measurement,
});
const types = suggestions.map((suggestion) => suggestion.type);

assert(
  types.includes("tap-target"),
  "expected small interactive target suggestion",
);
assert(
  types.includes("missing-accessible-name"),
  "expected missing accessible name suggestion",
);
assert(
  types.includes("focus-ring"),
  "expected suppressed focus ring suggestion",
);
assert(
  types.includes("text-overflow"),
  "expected clipping/text overflow suggestion",
);
assert(types.includes("token-hint"), "expected class/token hint suggestion");
assert(
  types.includes("stacking-context"),
  "expected stacking context suggestion",
);

const contrast = contrastRatio("#000000", "#ffffff");
assert(
  contrast !== null && contrast > 20 && contrast < 22,
  "expected black/white contrast ratio",
);

console.log("overlay suggestions verified");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
