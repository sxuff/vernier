interface SourceLocation {
  fileName: string;
  lineNumber: number;
}

interface SourceResolution {
  source: string;
  confidence: "high" | "medium" | "low";
  resolver: string;
  componentName?: string;
  ownerChain: string[];
}

export function getSourceLocation(element: Element): string {
  return resolveSource(element).source;
}

export function resolveSource(element: Element): SourceResolution {
  const annotatedSource = findAnnotatedSource(element);

  if (annotatedSource) {
    return {
      source: annotatedSource,
      confidence: "high",
      resolver: "data-vernier-source",
      ownerChain: []
    };
  }

  const fiber = getReactFiber(element);
  const debugSource = findDebugSource(fiber);
  const ownerChain = findOwnerChain(fiber);
  const componentName = ownerChain.at(-1);

  if (debugSource) {
    return {
      source: `${trimSourcePath(debugSource.fileName)}:${debugSource.lineNumber}`,
      confidence: "medium",
      resolver: "react-debug-source",
      componentName,
      ownerChain
    };
  }

  if (componentName) {
    return {
      source: "unresolved",
      confidence: "low",
      resolver: "react-component-name",
      componentName,
      ownerChain
    };
  }

  return {
    source: "unresolved",
    confidence: "low",
    resolver: "fallback-dom",
    ownerChain: []
  };
}

export function getReactFiber(sourceElement: Element): unknown {
  const record = sourceElement as unknown as Record<string, unknown>;
  const key = Object.keys(record).find(
    (candidate) => candidate.startsWith("__reactFiber$") || candidate.startsWith("__reactInternalInstance$")
  );

  return key ? record[key] : null;
}

export function findDebugSource(sourceFiber: unknown): SourceLocation | null {
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

export function findOwnerChain(sourceFiber: unknown): string[] {
  const chain: string[] = [];
  let current = sourceFiber;

  while (isRecord(current) && chain.length < 8) {
    const name = fiberDisplayName(current);

    if (name && chain[chain.length - 1] !== name) {
      chain.unshift(name);
    }

    current = current.return;
  }

  return chain;
}

export function fiberDisplayName(fiber: Record<string, unknown>): string | null {
  const type = fiber.type;
  const elementType = fiber.elementType;

  if (isRecord(type) && typeof type.displayName === "string") {
    return type.displayName;
  }

  if (isRecord(elementType) && typeof elementType.displayName === "string") {
    return elementType.displayName;
  }

  if (typeof type === "function" && type.name) {
    return type.name;
  }

  if (typeof elementType === "function" && elementType.name) {
    return elementType.name;
  }

  return null;
}

export function findAnnotatedSource(sourceElement: Element): string | null {
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isSourceLocation(value: unknown): value is SourceLocation {
  return isRecord(value) && typeof value.fileName === "string" && typeof value.lineNumber === "number";
}

export function trimSourcePath(fileName: string): string {
  const normalized = fileName.replaceAll("\\", "/");
  const srcIndex = normalized.lastIndexOf("/src/");

  return srcIndex >= 0 ? normalized.slice(srcIndex + 1) : normalized;
}
