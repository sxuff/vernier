export interface OverlayRuntimeOptions {
  hotkey?: string;
  styleProperties?: string[];
  redact?: string[];
}

export interface SessionOutputOptions {
  outDir?: string;
}

export function normalizeOverlayRuntimeOptions(options: OverlayRuntimeOptions = {}): OverlayRuntimeOptions {
  const normalized: OverlayRuntimeOptions = {};

  if (typeof options.hotkey === "string" && options.hotkey.trim()) {
    normalized.hotkey = options.hotkey.trim();
  }

  const styleProperties = sanitizeStringArray(options.styleProperties);
  if (styleProperties.length > 0) {
    normalized.styleProperties = styleProperties;
  }

  const redact = sanitizeStringArray(options.redact);
  if (redact.length > 0) {
    normalized.redact = redact;
  }

  return normalized;
}

function sanitizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean))];
}
