import { parseArgs } from "../dist/index.js";

const proxy = parseArgs(["--target", "http://localhost:3000", "--port", "3334"], {
  valueOptions: ["--target", "--port"]
});
assert(proxy.option("--target") === "http://localhost:3000", "proxy should parse --target value");
assert(proxy.option("--port") === "3334", "proxy should parse --port value");
assert(proxy.positionals().length === 0, "proxy option values should not be positional");

const positionalTarget = parseArgs(["http://localhost:3000"], {
  valueOptions: ["--target", "--port"]
});
assert(positionalTarget.positionals()[0] === "http://localhost:3000", "proxy should keep positional target");

const send = parseArgs(["all", "--to", "codex", "--all", "--template=strict"], {
  valueOptions: ["--to", "--template"]
});
assert(send.positionals()[0] === "all", "send should keep all as positional reference");
assert(send.option("--to") === "codex", "send should parse --to value");
assert(send.option("--template") === "strict", "send should parse --template=value");
assert(send.flag("--all"), "send should parse --all flag");

const detect = parseArgs(["--ports", "5173,3000,6006"], { valueOptions: ["--ports"] });
assert(detect.option("--ports") === "5173,3000,6006", "detect should parse ports value");
assert(detect.positionals().length === 0, "detect should not treat option values as positionals");

const verify = parseArgs(["i-123abc", "--compare", "--target", "http://localhost:5173", "--tolerance=3", "--viewports", "mobile,desktop"], {
  valueOptions: ["--target", "--tolerance", "--viewports"]
});
assert(verify.positionals()[0] === "i-123abc", "verify should keep issue id as positional");
assert(verify.flag("--compare"), "verify should parse compare flag");
assert(verify.option("--target") === "http://localhost:5173", "verify should parse target");
assert(verify.option("--tolerance") === "3", "verify should parse tolerance equals form");
assert(verify.option("--viewports") === "mobile,desktop", "verify should parse viewports");

const capture = parseArgs(["--target", "http://localhost:5173", "--routes", "/,/pricing", "--viewports", "390x844,1440x900"], {
  valueOptions: ["--target", "--routes", "--viewports"]
});
assert(capture.positionals().length === 0, "capture should not leak option values into positionals");
assert(capture.option("--routes") === "/,/pricing", "capture should parse routes");

console.log("args parser verified");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
