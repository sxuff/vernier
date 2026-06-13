import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const testsDirectory = new URL(".", import.meta.url);
const entries = await readdir(testsDirectory);
const testFiles = entries
  .filter((entry) => entry.endsWith(".test.mjs"))
  .sort()
  .map((entry) => join("tests", entry));

const child = spawn(process.execPath, ["--test", ...testFiles], {
  stdio: "inherit",
  shell: false,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});
