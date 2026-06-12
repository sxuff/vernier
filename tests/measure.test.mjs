import { parsePixelValue, toHexColor, tokenDistance } from "../dist/index.js";

assert(toHexColor("rgba(0, 0, 0, 0)") === "transparent", "expected transparent rgba to stay transparent");
assert(toHexColor("rgba(31, 111, 235, 0.5)") === "#1f6feb80", "expected alpha hex for comma rgba");
assert(toHexColor("rgb(31 111 235 / 50%)") === "#1f6feb80", "expected modern rgb slash alpha");
assert(toHexColor("rgb(31 111 235)") === "#1f6feb", "expected modern rgb spaces");
assert(toHexColor("oklch(60% 0.2 250)") === "oklch(60% 0.2 250)", "expected unsupported colors to pass through");

assert(parsePixelValue("12px") === 12, "expected px parser");
assert(tokenDistance("12px", "14px") === 2, "expected px token distance");

console.log("measure helpers verified");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
