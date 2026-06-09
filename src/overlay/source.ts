interface SourceLocation {
  fileName: string;
  lineNumber: number;
}

export function getSourceLocation(element: Element): string {
  const annotatedSource = findAnnotatedSource(element);

  if (annotatedSource) {
    return annotatedSource;
  }

  const fiber = getReactFiber(element);
  const source = findDebugSource(fiber);

  if (!source) {
    return "unresolved";
  }

  return `${trimSourcePath(source.fileName)}:${source.lineNumber}`;

  function getReactFiber(sourceElement: Element): unknown {
    const record = sourceElement as unknown as Record<string, unknown>;
    const key = Object.keys(record).find(
      (candidate) => candidate.startsWith("__reactFiber$") || candidate.startsWith("__reactInternalInstance$")
    );

    return key ? record[key] : null;
  }

  function findDebugSource(sourceFiber: unknown): SourceLocation | null {
    let current = sourceFiber;

    while (isRecord(current)) {
      const debugSource = current._debugSource;

      if (isSourceLocation(debugSource)) {
        return debugSource;
      }

      current = current.return;
    }

    return null;
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  function isSourceLocation(value: unknown): value is SourceLocation {
    return isRecord(value) && typeof value.fileName === "string" && typeof value.lineNumber === "number";
  }

  function trimSourcePath(fileName: string): string {
    const normalized = fileName.replaceAll("\\", "/");
    const srcIndex = normalized.lastIndexOf("/src/");

    return srcIndex >= 0 ? normalized.slice(srcIndex + 1) : normalized;
  }

  function findAnnotatedSource(sourceElement: Element): string | null {
    let current: Element | null = sourceElement;

    while (current) {
      const sourceAttribute = current.getAttribute("data-vernier-source");

      if (sourceAttribute) {
        return sourceAttribute;
      }

      current = current.parentElement;
    }

    return null;
  }
}
