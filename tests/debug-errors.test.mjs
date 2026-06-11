import { debugLog, setDebugEnabled } from "../dist/index.js";
import { spawn } from "node:child_process";

const originalError = console.error;
const lines = [];
console.error = (value) => {
  lines.push(String(value));
};

try {
  setDebugEnabled(false);
  debugLog("test", "hidden");
  assert(lines.length === 0, "debug should be quiet by default");

  setDebugEnabled(true);
  debugLog("test", "visible");
  assert(lines.includes("[vernier:test] visible"), "debug should log when enabled");
} finally {
  setDebugEnabled(false);
  console.error = originalError;
}

const result = await runCli(["clean", "--keep", "-1"]);
assert(result.code === 1, "invalid clean command should fail");
assert(result.stderr.includes("VERNIER_INVALID_OPTION"), "CLI should print structured error code");
assert(result.stderr.includes("Hint: Use a non-negative integer"), "CLI should print structured hint");

console.log("debug and structured errors verified");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["dist/cli.js", ...args], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}
