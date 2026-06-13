export interface SourceLocation {
  fileName: string;
  lineNumber: number;
}

export interface SourceResolution {
  source: string;
  confidence: "high" | "medium" | "low";
  resolver: string;
  componentName?: string;
  ownerChain: string[];
}

export interface SourceResolver {
  name: string;
  resolve(element: Element): SourceResolution | null;
}

export function getSourceLocation(element: Element): string {
  return resolveSource(element).source;
}

export function resolveSource(element: Element): SourceResolution {
  return (
    sourceResolvers.reduce<SourceResolution | null>(
      (resolved, resolver) => resolved ?? resolver.resolve(element),
      null,
    ) ?? {
      source: "unresolved",
      confidence: "low",
      resolver: "fallback-dom",
      ownerChain: [],
    }
  );
}

export const sourceResolvers: SourceResolver[] = [
  {
    name: "data-vernier-source",
    resolve(element) {
      const annotatedSource = findAnnotatedSource(element);

      if (!annotatedSource) {
        return null;
      }

      return {
        source: annotatedSource.source,
        confidence: "high",
        resolver: "data-vernier-source",
        componentName: annotatedSource.componentName,
        ownerChain: annotatedSource.ownerChain,
      };
    },
  },
  {
    name: "react-debug-source",
    resolve(element) {
      const fiber = getReactFiber(element);
      const debugSource = findDebugSource(fiber);

      if (!debugSource) {
        return null;
      }

      const ownerChain = findOwnerChain(fiber);

      return {
        source: `${trimSourcePath(debugSource.fileName)}:${debugSource.lineNumber}`,
        confidence: "medium",
        resolver: "react-debug-source",
        componentName: ownerChain.at(-1),
        ownerChain,
      };
    },
  },
  {
    name: "data-vernier-component",
    resolve(element) {
      const component = findAnnotatedComponent(element);

      if (!component) {
        return null;
      }

      return {
        source: "unresolved",
        confidence: "medium",
        resolver: "data-vernier-component",
        componentName: component.componentName,
        ownerChain: component.ownerChain,
      };
    },
  },
  {
    name: "react-component-name",
    resolve(element) {
      const ownerChain = findOwnerChain(getReactFiber(element));
      const componentName = ownerChain.at(-1);

      if (!componentName) {
        return null;
      }

      return {
        source: "unresolved",
        confidence: "low",
        resolver: "react-component-name",
        componentName,
        ownerChain,
      };
    },
  },
];

export function getReactFiber(sourceElement: Element): unknown {
  const record = sourceElement as unknown as Record<string, unknown>;
  const key = Object.keys(record).find(
    (candidate) =>
      candidate.startsWith("__reactFiber$") ||
      candidate.startsWith("__reactInternalInstance$"),
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

export function fiberDisplayName(
  fiber: Record<string, unknown>,
): string | null {
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

export function findAnnotatedSource(
  sourceElement: Element,
): { source: string; componentName?: string; ownerChain: string[] } | null {
  let current: Element | null = sourceElement;

  while (current) {
    const sourceAttribute = current.getAttribute("data-vernier-source");

    if (sourceAttribute) {
      const component = readAnnotatedComponent(current);
      return {
        source: sourceAttribute,
        componentName: component.componentName,
        ownerChain: component.ownerChain,
      };
    }

    current = current.parentElement;
  }

  return null;
}

export function findAnnotatedComponent(
  sourceElement: Element,
): { componentName?: string; ownerChain: string[] } | null {
  let current: Element | null = sourceElement;

  while (current) {
    const component = readAnnotatedComponent(current);

    if (component.componentName || component.ownerChain.length > 0) {
      return component;
    }

    current = current.parentElement;
  }

  return null;
}

function readAnnotatedComponent(element: Element): {
  componentName?: string;
  ownerChain: string[];
} {
  const componentName =
    element.getAttribute("data-vernier-component") ?? undefined;
  const ownerChain = parseOwnerChain(
    element.getAttribute("data-vernier-owner-chain"),
  );

  return {
    componentName: componentName ?? ownerChain.at(-1),
    ownerChain:
      ownerChain.length > 0 ? ownerChain : componentName ? [componentName] : [],
  };
}

function parseOwnerChain(value: string | null): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(/[>,]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 8);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isSourceLocation(value: unknown): value is SourceLocation {
  return (
    isRecord(value) &&
    typeof value.fileName === "string" &&
    typeof value.lineNumber === "number"
  );
}

export function trimSourcePath(fileName: string): string {
  const normalized = fileName.replaceAll("\\", "/");
  const srcIndex = normalized.lastIndexOf("/src/");

  return srcIndex >= 0 ? normalized.slice(srcIndex + 1) : normalized;
}
