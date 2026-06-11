import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listLatestIssues } from "../dist/index.js";

const root = await mkdtemp(path.join(os.tmpdir(), "vernier-core-errors-"));

try {
  await listLatestIssues(root);
  throw new Error("expected missing session to fail");
} catch (error) {
  assert(error?.code === "VERNIER_NO_SESSION", `expected VERNIER_NO_SESSION, got ${error?.code}`);
  assert(error?.hint?.includes("export a session"), "missing session error should include hint");
}

console.log("core errors verified");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
