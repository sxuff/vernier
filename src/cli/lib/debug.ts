let debugEnabled = false;

export function setDebugEnabled(enabled: boolean): void {
  debugEnabled = enabled;
}

export function isDebugEnabled(): boolean {
  return (
    debugEnabled ||
    process.env.VERNIER_DEBUG === "1" ||
    process.env.DEBUG?.split(",").some((value) => value.trim() === "vernier:*") === true
  );
}

export function debugLog(namespace: string, message: string): void {
  if (isDebugEnabled()) {
    console.error(`[vernier:${namespace}] ${message}`);
  }
}
