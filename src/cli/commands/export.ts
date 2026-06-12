import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { listLatestIssues } from "../../core/issues";
import { parseArgs } from "../lib/args";
import { VernierError } from "../lib/errors";
import type { VernierSession } from "../../schema";

const exportValueOptions = ["--format", "--out"];
const exportManifestName = "export-manifest.json";

interface ZipEntry {
  relativePath: string;
  mtime: Date;
  bytes: Buffer;
}

export async function exportLatestSession(root: string, args: string[]): Promise<string> {
  const parsed = parseArgs(args, { valueOptions: exportValueOptions });
  const format = readExportFormat(args);
  const issues = await listLatestIssues(root);
  const sessionDirectory = issues[0]?.sessionDirectory;

  if (!sessionDirectory) {
    throw new VernierError("VERNIER_NO_SESSION", `No Vernier session found under ${root}`, "Open your app with Vernier, add an issue, then export a session.");
  }

  if (format === "md" || format === "json") {
    const source = path.join(sessionDirectory, format === "md" ? "session.md" : "session.json");
    const out = parsed.option("--out");

    if (!out) {
      return readFile(source, "utf8");
    }

    const destination = path.resolve(root, out);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination);
    return `Exported latest Vernier ${format} to ${destination}`;
  }

  const issue = issues[0]!;
  const destination = path.resolve(root, parsed.option("--out") ?? path.join(".ui-feedback", "exports", `${issue.session.sessionId}.zip`));
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, await createZipFromDirectory(sessionDirectory, issue.session));

  return `Exported latest Vernier zip to ${destination}`;
}

function readExportFormat(args: string[]): "md" | "json" | "zip" {
  const value = parseArgs(args, { valueOptions: exportValueOptions }).option("--format") ?? "zip";

  if (value === "md" || value === "json" || value === "zip") {
    return value;
  }

  throw new VernierError("VERNIER_INVALID_OPTION", `Invalid --format value: ${value}`, "Use --format md, --format json, or --format zip.");
}

async function createZipFromDirectory(directory: string, session: VernierSession): Promise<Buffer> {
  const files = await collectFiles(directory);
  const entries = [
    ...await Promise.all(
      files.map(async (file): Promise<ZipEntry> => ({
        relativePath: file.relativePath,
        mtime: file.mtime,
        bytes: await readFile(file.absolutePath)
      }))
    ),
    createExportManifestEntry(session, files.map((file) => file.relativePath))
  ].sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  return createZipArchive(entries);
}

function createExportManifestEntry(session: VernierSession, files: string[]): ZipEntry {
  const exportedAt = new Date().toISOString();
  const archiveFiles = [...files.map((file) => file.replaceAll("\\", "/")), exportManifestName].sort();
  const manifest = {
    kind: "vernier-session-export",
    schemaVersion: 1,
    exportedAt,
    sourceSessionId: session.sessionId,
    sourceRoute: session.route,
    sourceUrl: session.url,
    viewport: session.viewport,
    issueCount: session.issues.length,
    localOnly: true,
    networkUploads: false,
    privacy: "Screenshots and UI feedback are exported as a local archive only.",
    files: archiveFiles,
    fileCount: archiveFiles.length
  };

  return {
    relativePath: exportManifestName,
    mtime: new Date(exportedAt),
    bytes: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8")
  };
}

function createZipArchive(files: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const bytes = file.bytes;
    const name = Buffer.from(file.relativePath.replaceAll("\\", "/"));
    const crc = crc32(bytes);
    const { time, date } = dosDateTime(file.mtime);
    const local = Buffer.alloc(30);

    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(bytes.byteLength, 18);
    local.writeUInt32LE(bytes.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    local.writeUInt16LE(0, 28);

    localParts.push(local, name, bytes);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(bytes.byteLength, 20);
    central.writeUInt32LE(bytes.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.byteLength + name.byteLength + bytes.byteLength;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.byteLength, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, end]);
}

async function collectFiles(directory: string, base = directory): Promise<Array<{ absolutePath: string; relativePath: string; mtime: Date }>> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: Array<{ absolutePath: string; relativePath: string; mtime: Date }> = [];

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...await collectFiles(absolutePath, base));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const fileStat = await stat(absolutePath);
    files.push({
      absolutePath,
      relativePath: path.relative(base, absolutePath),
      mtime: fileStat.mtime
    });
  }

  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

const crcTable = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;

  for (const byte of bytes) {
    crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}
