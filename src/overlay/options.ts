import type { OverlayRuntimeOptions } from "../core/overlay-options";
import { normalizeOverlayRuntimeOptions } from "../core/overlay-options";

declare global {
  interface Window {
    __VERNIER_OPTIONS__?: OverlayRuntimeOptions;
  }
}

const defaultStyleProperties = [
  "font-size",
  "color",
  "background-color",
  "padding",
  "margin",
  "width",
  "height",
  "border-radius"
];

const defaultRedactionSelectors = [
  'input[type="password"]',
  "[data-vernier-redact]"
];

export function getOverlayOptions(): OverlayRuntimeOptions {
  return normalizeOverlayRuntimeOptions(window.__VERNIER_OPTIONS__);
}

export function getStylePropertyNames(): string[] {
  return getOverlayOptions().styleProperties ?? defaultStyleProperties;
}

export function getRedactionSelectors(): string[] {
  return [...defaultRedactionSelectors, ...(getOverlayOptions().redact ?? [])];
}

export function getSessionEndpoint(): string {
  return getOverlayOptions().sessionEndpoint ?? "/__vernier/session";
}

export function shouldCaptureFullPage(): boolean {
  return getOverlayOptions().captureFullPage ?? true;
}

export function matchesOverlayHotkey(event: KeyboardEvent): boolean {
  const configured = getOverlayOptions().hotkey;

  if (!configured) {
    return defaultHotkey(event);
  }

  const parsed = parseHotkey(configured);

  if (!parsed) {
    return defaultHotkey(event);
  }

  const keyMatches = event.key.toLowerCase() === parsed.key;

  return (
    keyMatches &&
    event.ctrlKey === parsed.ctrl &&
    event.metaKey === parsed.meta &&
    event.altKey === parsed.alt &&
    event.shiftKey === parsed.shift
  );
}

interface ParsedHotkey {
  key: string;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}

function parseHotkey(value: string): ParsedHotkey | null {
  const parts = value
    .split("+")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  const key = parts.at(-1);

  if (!key) {
    return null;
  }

  const modifiers = new Set(parts.slice(0, -1));

  return {
    key,
    ctrl: modifiers.has("ctrl") || modifiers.has("control"),
    meta: modifiers.has("meta") || modifiers.has("cmd") || modifiers.has("command"),
    alt: modifiers.has("alt") || modifiers.has("option"),
    shift: modifiers.has("shift")
  };
}

function defaultHotkey(event: KeyboardEvent): boolean {
  return (event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "f";
}
