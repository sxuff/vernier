import path from "node:path";

export interface SourceAnnotationOptions {
  root: string;
}

export function annotateJsxSource(
  code: string,
  id: string,
  options: SourceAnnotationOptions,
): string | null {
  const cleanId = stripViteQuery(id);

  if (!isJsxModule(cleanId) || isThirdPartyModule(cleanId)) {
    return null;
  }

  const sourcePath = toSourcePath(cleanId, options.root);
  const lineStarts = collectLineStarts(code);
  const tagPattern = /<([a-z][\w:.-]*)(?=[\s>/])/g;
  let output = "";
  let lastIndex = 0;
  let changed = false;
  let match = tagPattern.exec(code);
  while (match !== null) {
    const tagStart = match.index;

    if (isClosingOrSpecialTag(code, tagStart)) {
      match = tagPattern.exec(code);
      continue;
    }

    const tagNameEnd = tagStart + match[0].length;
    const tagEnd = findOpeningTagEnd(code, tagNameEnd);

    if (tagEnd < 0) {
      match = tagPattern.exec(code);
      continue;
    }

    const openingTag = code.slice(tagStart, tagEnd);

    if (/\sdata-vernier-source\s*=/.test(openingTag)) {
      match = tagPattern.exec(code);
      continue;
    }

    const lineNumber = lineNumberAt(lineStarts, tagStart);
    const attribute = ` data-vernier-source="${escapeAttribute(`${sourcePath}:${lineNumber}`)}"`;
    output += code.slice(lastIndex, tagNameEnd) + attribute;
    lastIndex = tagNameEnd;
    changed = true;
    match = tagPattern.exec(code);
  }

  if (!changed) {
    return null;
  }

  return output + code.slice(lastIndex);
}

function stripViteQuery(id: string): string {
  return id.split("?")[0] ?? id;
}

function isJsxModule(id: string): boolean {
  return /\.(jsx|tsx)$/.test(id);
}

function isThirdPartyModule(id: string): boolean {
  return id.includes("/node_modules/") || id.includes("\\node_modules\\");
}

function toSourcePath(id: string, root: string): string {
  const normalizedId = normalizePath(id);
  const normalizedRoot = normalizePath(root).replace(/\/$/, "");

  if (normalizedId.startsWith(`${normalizedRoot}/`)) {
    return normalizedId.slice(normalizedRoot.length + 1);
  }

  const srcIndex = normalizedId.lastIndexOf("/src/");
  return srcIndex >= 0
    ? normalizedId.slice(srcIndex + 1)
    : normalizedId.replace(/^\/+/, "");
}

function normalizePath(value: string): string {
  return path.resolve(value).replaceAll("\\", "/");
}

function collectLineStarts(code: string): number[] {
  const starts = [0];

  for (let index = 0; index < code.length; index += 1) {
    if (code[index] === "\n") {
      starts.push(index + 1);
    }
  }

  return starts;
}

function lineNumberAt(lineStarts: number[], index: number): number {
  let low = 0;
  let high = lineStarts.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);

    if (lineStarts[middle] <= index) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return high + 1;
}

function isClosingOrSpecialTag(code: string, tagStart: number): boolean {
  const next = code[tagStart + 1];
  return next === "/" || next === "!" || next === "?";
}

function findOpeningTagEnd(code: string, start: number): number {
  let quote: string | null = null;
  let braceDepth = 0;

  for (let index = start; index < code.length; index += 1) {
    const char = code[index];

    if (quote) {
      if (char === "\\" && quote !== "`") {
        index += 1;
      } else if (char === quote) {
        quote = null;
      }

      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }

    if (char === "{") {
      braceDepth += 1;
      continue;
    }

    if (char === "}" && braceDepth > 0) {
      braceDepth -= 1;
      continue;
    }

    if (char === ">" && braceDepth === 0) {
      return index;
    }
  }

  return -1;
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}
