import type { Dirent } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "../lib/args";
import { VernierError } from "../lib/errors";

export async function cleanSessions(
  root: string,
  args: string[],
): Promise<string> {
  const options = parseCleanOptions(args);
  const sessionsDirectory = path.join(root, ".ui-feedback", "sessions");
  const safeSessionsDirectory = path.resolve(sessionsDirectory);
  const entries = await readSessionDirectories(sessionsDirectory);
  const olderThanCutoff =
    options.olderThanMs === null ? null : Date.now() - options.olderThanMs;
  const byKeep = entries.slice(options.keep);
  const byAge =
    olderThanCutoff === null
      ? []
      : entries.filter((entry) => entry.mtimeMs < olderThanCutoff);
  const targets = uniqueSessionDirectories([...byKeep, ...byAge]);

  if (targets.length === 0) {
    return "No Vernier sessions to clean.";
  }

  if (!options.dryRun) {
    for (const target of targets) {
      const resolved = path.resolve(target.path);

      if (!resolved.startsWith(`${safeSessionsDirectory}${path.sep}`)) {
        throw new VernierError(
          "VERNIER_UNSAFE_PATH",
          `Refusing to remove unsafe path: ${target.path}`,
          "Clean only removes session directories under .ui-feedback/sessions.",
        );
      }

      await rm(resolved, { recursive: true, force: true });
    }
  }

  return [
    options.dryRun
      ? "Dry run: would remove Vernier sessions:"
      : "Removed Vernier sessions:",
    ...targets.map((target) => `- ${path.relative(root, target.path)}`),
    "",
    `${targets.length} session${targets.length === 1 ? "" : "s"} ${options.dryRun ? "would be removed" : "removed"}.`,
  ].join("\n");
}

interface CleanOptions {
  keep: number;
  olderThanMs: number | null;
  dryRun: boolean;
}

interface SessionDirectoryEntry {
  path: string;
  mtimeMs: number;
}

function parseCleanOptions(args: string[]): CleanOptions {
  const parsed = parseArgs(args, { valueOptions: ["--keep", "--older-than"] });
  const keepValue = parsed.option("--keep") ?? "20";
  const keep = Number(keepValue);

  if (!Number.isInteger(keep) || keep < 0) {
    throw new VernierError(
      "VERNIER_INVALID_OPTION",
      `Invalid --keep value: ${keepValue}`,
      "Use a non-negative integer, for example --keep 20.",
    );
  }

  const olderThanValue = parsed.option("--older-than");

  return {
    keep,
    olderThanMs: olderThanValue ? parseDuration(olderThanValue) : null,
    dryRun: parsed.flag("--dry-run"),
  };
}

function parseDuration(value: string): number {
  const match = value.match(/^(\d+)([dhm])$/);

  if (!match) {
    throw new VernierError(
      "VERNIER_INVALID_OPTION",
      `Invalid --older-than value: ${value}`,
      "Use values like 14d, 12h, or 30m.",
    );
  }

  const amount = Number(match[1]);
  const unit = match[2] as "d" | "h" | "m";
  const multipliers: Record<string, number> = {
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  return amount * multipliers[unit];
}

async function readSessionDirectories(
  sessionsDirectory: string,
): Promise<SessionDirectoryEntry[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(sessionsDirectory, { withFileTypes: true });
  } catch {
    return [];
  }

  const directories = await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isDirectory()) {
        return null;
      }

      const directoryPath = path.join(sessionsDirectory, entry.name);
      const directoryStat = await stat(directoryPath);

      return {
        path: directoryPath,
        mtimeMs: directoryStat.mtimeMs,
      };
    }),
  );

  return directories
    .filter((entry): entry is SessionDirectoryEntry => entry !== null)
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
}

function uniqueSessionDirectories(
  entries: SessionDirectoryEntry[],
): SessionDirectoryEntry[] {
  const seen = new Set<string>();
  const result: SessionDirectoryEntry[] = [];

  for (const entry of entries) {
    const resolved = path.resolve(entry.path);

    if (seen.has(resolved)) {
      continue;
    }

    seen.add(resolved);
    result.push(entry);
  }

  return result;
}
