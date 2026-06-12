import { cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "../lib/args";
import { VernierError } from "../lib/errors";
import { resolveFeedbackDirectory } from "../../core/session-writer";
import type { VernierSession } from "../../schema";

const importValueOptions = ["--out-dir"];

export async function importSessionArtifact(root: string, args: string[]): Promise<string> {
  const parsed = parseArgs(args, { valueOptions: importValueOptions });
  const [source] = parsed.positionals();

  if (!source) {
    throw new VernierError("VERNIER_INVALID_OPTION", "Usage: vernier import <session-directory-or-zip>", "Pass a Vernier session directory or a zip created by `vernier export --format zip`.");
  }

  const sourcePath = path.resolve(root, source);
  const feedbackDirectory = resolveFeedbackDirectory(root, parsed.option("--out-dir") ?? ".ui-feedback");
  const importedDirectory = path.join(feedbackDirectory, "sessions", `imported-${new Date().toISOString().replace(/[:.]/g, "-")}`);

  if (sourcePath.toLowerCase().endsWith(".zip")) {
    await mkdir(importedDirectory, { recursive: true });
    await extractZip(sourcePath, importedDirectory);
  } else {
    await mkdir(path.dirname(importedDirectory), { recursive: true });
    await cp(sourcePath, importedDirectory, { recursive: true });
  }

  const session = await validateImportedSession(importedDirectory);
  await updateLatestLink(feedbackDirectory, importedDirectory);

  return [
    `Imported Vernier session ${session.sessionId}.`,
    `Session: ${importedDirectory}`,
    `Latest: ${path.join(feedbackDirectory, "latest")}`
  ].join("\n");
}

async function validateImportedSession(sessionDirectory: string): Promise<VernierSession> {
  let session: VernierSession;

  try {
    session = JSON.parse(await readFile(path.join(sessionDirectory, "session.json"), "utf8")) as VernierSession;
  } catch {
    throw new VernierError("VERNIER_INVALID_IMPORT", "Imported artifact does not contain a readable session.json.", "Import a directory or zip created by Vernier.");
  }

  if (!session.sessionId || !Array.isArray(session.issues)) {
    throw new VernierError("VERNIER_INVALID_IMPORT", "Imported session.json is not a Vernier session.", "Check that the artifact contains Vernier session metadata.");
  }

  return session;
}

async function extractZip(zipPath: string, destination: string): Promise<void> {
  const buffer = await readFile(zipPath);
  let offset = 0;
  let extractedEntries = 0;

  while (offset + 4 <= buffer.byteLength) {
    const signature = buffer.readUInt32LE(offset);

    if (signature !== 0x04034b50) {
      break;
    }

    const compression = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const uncompressedSize = buffer.readUInt32LE(offset + 22);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString("utf8");
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;

    if (compression !== 0) {
      throw new VernierError("VERNIER_INVALID_IMPORT", "Compressed zip entries are not supported.", "Use archives produced by `vernier export --format zip`.");
    }

    if (compressedSize !== uncompressedSize || dataEnd > buffer.byteLength) {
      throw new VernierError("VERNIER_INVALID_IMPORT", "Zip entry sizes are invalid.", "The import artifact may be corrupted.");
    }

    const destinationPath = safeDestinationPath(destination, name);

    if (!name.endsWith("/")) {
      await mkdir(path.dirname(destinationPath), { recursive: true });
      await writeFile(destinationPath, buffer.subarray(dataStart, dataEnd));
      extractedEntries += 1;
    }

    offset = dataEnd;
  }

  if (extractedEntries === 0) {
    throw new VernierError("VERNIER_INVALID_IMPORT", "Zip artifact did not contain any session files.", "Use an archive produced by `vernier export --format zip`.");
  }
}

function safeDestinationPath(root: string, entryName: string): string {
  const normalized = entryName.replaceAll("\\", "/");

  if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new VernierError("VERNIER_INVALID_IMPORT", `Unsafe zip entry path: ${entryName}`, "Zip entries must stay inside the Vernier session directory.");
  }

  const destination = path.resolve(root, normalized);
  const relative = path.relative(root, destination);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new VernierError("VERNIER_INVALID_IMPORT", `Unsafe zip entry path: ${entryName}`, "Zip entries must stay inside the Vernier session directory.");
  }

  return destination;
}

async function updateLatestLink(feedbackDirectory: string, targetDirectory: string): Promise<void> {
  const latestPath = path.join(feedbackDirectory, "latest");
  let latestKind = "junction";

  await rm(latestPath, { recursive: true, force: true });

  try {
    await symlink(targetDirectory, latestPath, "junction");
  } catch {
    latestKind = "copy";
    await cp(targetDirectory, latestPath, { recursive: true });
  }

  await writeFile(
    path.join(feedbackDirectory, "latest.json"),
    `${JSON.stringify(
      {
        kind: latestKind,
        target: path.relative(feedbackDirectory, targetDirectory),
        updatedAt: new Date().toISOString()
      },
      null,
      2
    )}\n`
  );
}
