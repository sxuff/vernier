import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const cliPath = path.join(process.cwd(), "dist", "cli.js");

const ignoredRoot = await fixtureRoot(".ui-feedback/\n");
const ignored = await runCli(ignoredRoot);
assert(ignored.code === 0, "doctor should exit successfully when .ui-feedback is ignored");
assert(ignored.stdout.includes("OK: .ui-feedback is ignored"), "doctor should report ignored .ui-feedback");
assert(ignored.stdout.includes("no .ui-feedback directory yet"), "doctor should report missing feedback directory");
assert(ignored.stdout.includes("no network uploads"), "doctor should report local-only behavior");

const presentRoot = await fixtureRoot("/.ui-feedback/**\n");
await mkdir(path.join(presentRoot, ".ui-feedback"));
const present = await runCli(presentRoot);
assert(present.stdout.includes("feedback directory exists"), "doctor should report existing feedback directory");

const missingGitignoreRoot = await mkdtemp(path.join(os.tmpdir(), "vernier-doctor-missing-"));
const missingGitignore = await runCli(missingGitignoreRoot);
assert(missingGitignore.stdout.includes("Warning: .gitignore was not found."), "doctor should warn when .gitignore is missing");
assert(missingGitignore.stdout.includes("Hint: add .ui-feedback/"), "doctor should suggest the ignore entry");

const unignoredRoot = await fixtureRoot("node_modules/\n");
const unignored = await runCli(unignoredRoot);
assert(unignored.stdout.includes("Warning: .ui-feedback is not ignored"), "doctor should warn when .ui-feedback is not ignored");

const negatedRoot = await fixtureRoot(".ui-feedback/\n!.ui-feedback/\n");
const negated = await runCli(negatedRoot);
assert(negated.stdout.includes("Warning: .ui-feedback is not ignored"), "doctor should honor negated gitignore patterns");

console.log("doctor command verified");

async function fixtureRoot(gitignore) {
  const root = await mkdtemp(path.join(os.tmpdir(), "vernier-doctor-"));
  await writeFile(path.join(root, ".gitignore"), gitignore);
  return root;
}

function runCli(cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, "doctor"], {
      cwd,
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

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
