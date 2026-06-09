import type { IncomingMessage, ServerResponse } from "node:http";
import type { VernierSession } from "../schema";
import { writeSession } from "./session-writer";

export const vernierSessionPath = "/__vernier/session";
const maxBodyBytes = 30 * 1024 * 1024;
const maxIssues = 100;
const maxScreenshotBytes = 10 * 1024 * 1024;

export async function handleVernierSessionRequest(
  root: string,
  request: IncomingMessage,
  response: ServerResponse
): Promise<boolean> {
  const requestPath = request.url?.split("?")[0];

  if (requestPath !== vernierSessionPath) {
    return false;
  }

  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Method not allowed" });
    return true;
  }

  try {
    const session = validateSession(parseSessionJson(await readLimitedBody(request, maxBodyBytes)));
    const sessionDirectory = await writeSession(root, session);

    sendJson(response, 200, { ok: true, sessionDirectory });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = error instanceof SessionRequestError ? error.statusCode : 500;
    sendJson(response, status, { error: message });
  }

  return true;
}

class SessionRequestError extends Error {
  constructor(
    message: string,
    public statusCode: number
  ) {
    super(message);
  }
}

function readLimitedBody(request: IncomingMessage, limitBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let rejected = false;

    request.on("data", (chunk: Buffer) => {
      if (rejected) {
        return;
      }

      bytes += chunk.byteLength;

      if (bytes > limitBytes) {
        rejected = true;
        reject(new SessionRequestError(`Session payload exceeds ${limitBytes} bytes`, 413));
        request.destroy();
        return;
      }

      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!rejected) {
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    });
    request.on("error", reject);
  });
}

function parseSessionJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw badRequest("Session payload must be valid JSON");
  }
}

function validateSession(value: unknown): VernierSession {
  const session = expectRecord(value, "session");
  const schemaVersion = session.schemaVersion;
  const toolVersion = expectString(session.toolVersion, "toolVersion");
  const sessionId = expectSafeIdentifier(session.sessionId, "sessionId", "s");
  const route = expectString(session.route, "route");
  const url = expectString(session.url, "url");
  const viewport = expectRecord(session.viewport, "viewport");
  const createdAt = expectString(session.createdAt, "createdAt");
  const issues = expectArray(session.issues, "issues");
  const issueCount = expectPositiveInteger(session.issueCount, "issueCount");

  if (schemaVersion !== 1) {
    throw badRequest("schemaVersion must be 1");
  }

  if (Number.isNaN(Date.parse(createdAt))) {
    throw badRequest("createdAt must be an ISO timestamp");
  }

  try {
    new URL(url);
  } catch {
    throw badRequest("url must be a valid URL");
  }

  if (issues.length === 0) {
    throw badRequest("issues must contain at least one issue");
  }

  if (issues.length > maxIssues) {
    throw badRequest(`issues cannot contain more than ${maxIssues} issues`);
  }

  if (issueCount !== issues.length) {
    throw badRequest("issueCount must match issues.length");
  }

  return {
    schemaVersion: 1,
    toolVersion,
    sessionId,
    route,
    url,
    viewport: {
      width: expectPositiveNumber(viewport.width, "viewport.width"),
      height: expectPositiveNumber(viewport.height, "viewport.height"),
      devicePixelRatio: expectPositiveNumber(viewport.devicePixelRatio, "viewport.devicePixelRatio")
    },
    createdAt,
    issueCount,
    issues: issues.map((issue, index) => validateIssue(issue, index)),
    fullPageScreenshotName: expectSafeFilename(session.fullPageScreenshotName, "fullPageScreenshotName"),
    fullPageScreenshotDataUrl: expectPngDataUrl(session.fullPageScreenshotDataUrl, "fullPageScreenshotDataUrl")
  };
}

function validateIssue(value: unknown, index: number): VernierSession["issues"][number] {
  const issue = expectRecord(value, `issues[${index}]`);
  const kind = expectString(issue.kind, `issues[${index}].kind`);

  if (kind !== "single" && kind !== "delta" && kind !== "annotation") {
    throw badRequest(`issues[${index}].kind must be single, delta, or annotation`);
  }

  return {
    id: expectPositiveInteger(issue.id, `issues[${index}].id`),
    stableId: expectSafeIdentifier(issue.stableId, `issues[${index}].stableId`, "i"),
    kind,
    measured: expectString(issue.measured, `issues[${index}].measured`),
    selector: expectString(issue.selector, `issues[${index}].selector`),
    source: expectString(issue.source, `issues[${index}].source`),
    target: validateTarget(issue.target, `issues[${index}].target`),
    note: expectString(issue.note, `issues[${index}].note`),
    createdAt: expectIsoTimestamp(issue.createdAt, `issues[${index}].createdAt`),
    screenshotName: expectSafeFilename(issue.screenshotName, `issues[${index}].screenshotName`),
    screenshotDataUrl: expectPngDataUrl(issue.screenshotDataUrl, `issues[${index}].screenshotDataUrl`)
  };
}

function validateTarget(value: unknown, field: string): VernierSession["issues"][number]["target"] {
  const target = expectRecord(value, field);
  const ancestry = expectArray(target.ancestry, `${field}.ancestry`);

  if (ancestry.length > 10) {
    throw badRequest(`${field}.ancestry cannot contain more than 10 entries`);
  }

  return {
    selector: expectString(target.selector, `${field}.selector`),
    selectorConfidence: expectConfidence(target.selectorConfidence, `${field}.selectorConfidence`),
    selectorReason: expectString(target.selectorReason, `${field}.selectorReason`),
    tag: expectString(target.tag, `${field}.tag`),
    id: expectOptionalString(target.id, `${field}.id`),
    classes: expectStringArray(target.classes, `${field}.classes`),
    text: expectOptionalString(target.text, `${field}.text`),
    role: expectOptionalString(target.role, `${field}.role`),
    accessibleName: expectOptionalString(target.accessibleName, `${field}.accessibleName`),
    testId: expectOptionalString(target.testId, `${field}.testId`),
    nearestTestId: expectOptionalString(target.nearestTestId, `${field}.nearestTestId`),
    source: expectString(target.source, `${field}.source`),
    sourceConfidence: expectConfidence(target.sourceConfidence, `${field}.sourceConfidence`),
    sourceResolver: expectString(target.sourceResolver, `${field}.sourceResolver`),
    componentName: expectOptionalString(target.componentName, `${field}.componentName`),
    ownerChain: expectStringArray(target.ownerChain, `${field}.ownerChain`),
    ancestry: ancestry.map((item, index) => validateAncestor(item, `${field}.ancestry[${index}]`))
  };
}

function validateAncestor(value: unknown, field: string): VernierSession["issues"][number]["target"]["ancestry"][number] {
  const ancestor = expectRecord(value, field);

  return {
    tag: expectString(ancestor.tag, `${field}.tag`),
    id: expectOptionalString(ancestor.id, `${field}.id`),
    classes: expectStringArray(ancestor.classes, `${field}.classes`),
    role: expectOptionalString(ancestor.role, `${field}.role`),
    testId: expectOptionalString(ancestor.testId, `${field}.testId`),
    text: expectOptionalString(ancestor.text, `${field}.text`)
  };
}

function expectIsoTimestamp(value: unknown, field: string): string {
  const timestamp = expectString(value, field);

  if (Number.isNaN(Date.parse(timestamp))) {
    throw badRequest(`${field} must be an ISO timestamp`);
  }

  return timestamp;
}

function expectSafeIdentifier(value: unknown, field: string, prefix: string): string {
  const identifier = expectString(value, field);

  if (!new RegExp(`^${prefix}-[a-z0-9]{6,32}$`).test(identifier)) {
    throw badRequest(`${field} must be a safe ${prefix}-prefixed identifier`);
  }

  return identifier;
}

function expectRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest(`${field} must be an object`);
  }

  return value as Record<string, unknown>;
}

function expectArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw badRequest(`${field} must be an array`);
  }

  return value;
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw badRequest(`${field} must be a string`);
  }

  return value;
}

function expectOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return expectString(value, field);
}

function expectStringArray(value: unknown, field: string): string[] {
  const items = expectArray(value, field);

  if (items.some((item) => typeof item !== "string")) {
    throw badRequest(`${field} must contain only strings`);
  }

  return items as string[];
}

function expectConfidence(value: unknown, field: string): "high" | "medium" | "low" {
  if (value !== "high" && value !== "medium" && value !== "low") {
    throw badRequest(`${field} must be high, medium, or low`);
  }

  return value;
}

function expectPositiveNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw badRequest(`${field} must be a positive number`);
  }

  return value;
}

function expectPositiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw badRequest(`${field} must be a positive integer`);
  }

  return value as number;
}

function expectSafeFilename(value: unknown, field: string): string {
  const filename = expectString(value, field);

  if (!/^[a-zA-Z0-9._-]+$/.test(filename) || filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
    throw badRequest(`${field} must be a safe filename`);
  }

  return filename;
}

function expectPngDataUrl(value: unknown, field: string): string {
  const dataUrl = expectString(value, field);
  const match = dataUrl.match(/^data:image\/png;base64,([a-zA-Z0-9+/=]+)$/);

  if (!match) {
    throw badRequest(`${field} must be a PNG data URL`);
  }

  const byteLength = Buffer.byteLength(match[1]!, "base64");

  if (byteLength > maxScreenshotBytes) {
    throw badRequest(`${field} exceeds ${maxScreenshotBytes} bytes`);
  }

  return dataUrl;
}

function badRequest(message: string): SessionRequestError {
  return new SessionRequestError(message, 400);
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(payload));
}
