import type { IncomingMessage, ServerResponse } from "node:http";
import type { VernierSession } from "../schema";
import { writeSession } from "./session-writer";

export const vernierSessionPath = "/__vernier/session";

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
    const session = JSON.parse(await readBody(request)) as VernierSession;
    const sessionDirectory = await writeSession(root, session);

    sendJson(response, 200, { ok: true, sessionDirectory });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    sendJson(response, 500, { error: message });
  }

  return true;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(payload));
}

