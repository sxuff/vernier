import { createReadStream } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { listLatestIssues } from "../../core/issues";

interface ReplayDependencies {
  root: string;
  listenWithPortFallback(server: ReturnType<typeof createServer>, requestedPort: number): Promise<number>;
  openUrl(url: string): Promise<void>;
}

export async function startReplayViewer(args: string[], dependencies: ReplayDependencies): Promise<void> {
  const reference = readPositionalArgs(args)[0];

  if (reference && reference !== "latest") {
    throw new Error("Usage: vernier replay latest [--port 3340|auto] [--no-open]");
  }

  const requestedPort = parsePortOption(args, 3340);
  const server = createServer((request, response) => {
    void handleReplayRequest(dependencies.root, request, response);
  });
  const port = await dependencies.listenWithPortFallback(server, requestedPort === "auto" ? 3340 : requestedPort);
  const url = `http://127.0.0.1:${port}`;

  console.log(`[vernier] replay viewer listening on ${url}`);

  if (!args.includes("--no-open")) {
    await dependencies.openUrl(url);
  }
}

async function handleReplayRequest(root: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const issues = await listLatestIssues(root);
  const sessionDirectory = issues[0]?.sessionDirectory;

  if (!sessionDirectory) {
    sendText(response, 404, "No Vernier session found.");
    return;
  }

  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");

  try {
    if (requestUrl.pathname === "/" || requestUrl.pathname === "/index.html") {
      response.statusCode = 200;
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(await renderReplayHtml(issues));
      return;
    }

    if (requestUrl.pathname === "/session.json") {
      await sendSessionFile(response, sessionDirectory, "session.json", "application/json");
      return;
    }

    if (requestUrl.pathname.startsWith("/screenshots/")) {
      await sendSessionFile(
        response,
        sessionDirectory,
        path.join("screenshots", decodeURIComponent(requestUrl.pathname.slice("/screenshots/".length))),
        "image/png"
      );
      return;
    }

    if (requestUrl.pathname.startsWith("/verification/")) {
      const relativePath = decodeURIComponent(requestUrl.pathname.slice("/verification/".length));
      await sendSessionFile(
        response,
        sessionDirectory,
        path.join("verification", relativePath),
        replayContentType(relativePath)
      );
      return;
    }

    sendText(response, 404, "Not found");
  } catch (error) {
    sendText(response, 404, error instanceof Error ? error.message : "Not found");
  }
}

async function sendSessionFile(
  response: ServerResponse,
  sessionDirectory: string,
  relativePath: string,
  contentType: string
): Promise<void> {
  const safeRoot = path.resolve(sessionDirectory);
  const filePath = path.resolve(sessionDirectory, relativePath);

  if (filePath !== safeRoot && !filePath.startsWith(`${safeRoot}${path.sep}`)) {
    throw new Error("Unsafe replay path");
  }

  response.statusCode = 200;
  response.setHeader("Content-Type", contentType);
  await pipeline(createReadStream(filePath), response);
}

async function renderReplayHtml(issues: Awaited<ReturnType<typeof listLatestIssues>>): Promise<string> {
  const session = issues[0]!.session;
  const verificationReports = await readVerificationReports(issues[0]!.sessionDirectory);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Vernier Replay</title>
    <style>
      :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #172033; background: #eef2f7; }
      body { margin: 0; }
      header { position: sticky; top: 0; z-index: 2; display: flex; justify-content: space-between; gap: 16px; align-items: center; padding: 16px 24px; background: #ffffff; border-bottom: 1px solid #d8dde8; }
      h1, h2, h3 { margin: 0; }
      h1 { font-size: 18px; }
      h2 { font-size: 15px; }
      h3 { font-size: 14px; }
      main { display: grid; grid-template-columns: minmax(280px, 380px) minmax(0, 1fr); gap: 18px; padding: 18px; }
      aside, section.issue, section.preview { background: #ffffff; border: 1px solid #d8dde8; border-radius: 8px; }
      aside { align-self: start; position: sticky; top: 76px; overflow: hidden; }
      .meta { display: grid; gap: 4px; padding: 14px; font-size: 13px; border-bottom: 1px solid #e5e9f1; }
      .issue-list { display: grid; }
      .issue-link { display: grid; gap: 4px; padding: 12px 14px; color: inherit; text-decoration: none; border-bottom: 1px solid #eef1f6; }
      .issue-link:hover { background: #f7f9fc; }
      .tag-row { display: flex; gap: 6px; flex-wrap: wrap; }
      .tag { display: inline-flex; align-items: center; min-height: 20px; padding: 0 7px; border: 1px solid #cfd6e3; border-radius: 999px; font-size: 12px; color: #3b465c; background: #f8fafc; }
      .tag.todo { color: #7a3e00; border-color: #ffc46b; background: #fff7e8; }
      .tag.fixed { color: #0d5c38; border-color: #95ddb8; background: #ecfff4; }
      .content { display: grid; gap: 18px; min-width: 0; }
      .preview { padding: 14px; }
      .full { max-width: 100%; border: 1px solid #d8dde8; border-radius: 6px; }
      .issue { display: grid; gap: 12px; padding: 14px; scroll-margin-top: 92px; }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
      .panel { display: grid; gap: 8px; min-width: 0; }
      .panel img { width: 100%; max-height: 420px; object-fit: contain; background: #f6f8fb; border: 1px solid #d8dde8; border-radius: 6px; }
      pre { margin: 0; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; padding: 10px; border-radius: 6px; background: #172033; color: #f8fafc; font-size: 12px; line-height: 1.45; }
      code { overflow-wrap: anywhere; }
      .muted { color: #5f6c82; font-size: 13px; }
      @media (max-width: 820px) { main { grid-template-columns: 1fr; } aside { position: static; } }
    </style>
  </head>
  <body>
    <header>
      <div>
        <h1>Vernier Replay</h1>
        <div class="muted">${escapeHtml(session.route)} · ${session.viewport.width}x${session.viewport.height} @${session.viewport.devicePixelRatio}x</div>
      </div>
      <div class="tag-row">
        <span class="tag">${issues.length} issues</span>
        <a class="tag" href="/session.json">session.json</a>
      </div>
    </header>
    <main>
      <aside>
        <div class="meta">
          <strong>${escapeHtml(session.createdAt)}</strong>
          <span>${escapeHtml(session.url)}</span>
          <span>${escapeHtml(session.sessionId)}</span>
        </div>
        <nav class="issue-list">
          ${issues.map((issue) => renderReplayIssueLink(issue)).join("")}
        </nav>
      </aside>
      <div class="content">
        <section class="preview">
          <h2>Full Page</h2>
          <p class="muted">Captured screenshot for this session.</p>
          <img class="full" src="/screenshots/${encodeURIComponent(session.fullPageScreenshotName)}" alt="Full page screenshot" />
        </section>
        ${issues.map((issue) => renderReplayIssue(issue, verificationReports.get(issue.stableId))).join("")}
      </div>
    </main>
  </body>
</html>`;
}

function renderReplayIssueLink(issue: Awaited<ReturnType<typeof listLatestIssues>>[number]): string {
  return `<a class="issue-link" href="#${escapeHtml(issue.stableId)}">
    <strong>${escapeHtml(issue.stableId)} · issue ${issue.issue.id}</strong>
    <span class="muted">${escapeHtml(issue.issue.note || issue.issue.kind)}</span>
    <span class="tag-row"><span class="tag ${issue.status}">${issue.status}</span><span class="tag">${issue.issue.kind}</span></span>
  </a>`;
}

function renderReplayIssue(
  issue: Awaited<ReturnType<typeof listLatestIssues>>[number],
  verificationReport: unknown
): string {
  return `<section class="issue" id="${escapeHtml(issue.stableId)}">
    <div class="tag-row">
      <span class="tag ${issue.status}">${issue.status}</span>
      <span class="tag">${escapeHtml(issue.issue.kind)}</span>
      <span class="tag">${escapeHtml(issue.stableId)}</span>
    </div>
    <h2>${escapeHtml(issue.issue.note || "Untitled UI issue")}</h2>
    <div class="muted">Selector: <code>${escapeHtml(issue.issue.selector)}</code></div>
    <div class="grid">
      <div class="panel">
        <h3>Screenshot</h3>
        <img src="/screenshots/${encodeURIComponent(issue.issue.screenshotName)}" alt="Issue screenshot" />
      </div>
      <div class="panel">
        <h3>Measured</h3>
        <pre>${escapeHtml(issue.issue.measured)}</pre>
      </div>
      <div class="panel">
        <h3>Structured Evidence</h3>
        <pre>${escapeHtml(JSON.stringify(issue.issue.measurement ?? issue.issue.target, null, 2))}</pre>
      </div>
      <div class="panel">
        <h3>Verification</h3>
        ${renderVerificationPanel(issue.stableId, verificationReport)}
      </div>
    </div>
  </section>`;
}

function renderVerificationPanel(issueId: string, report: unknown): string {
  if (!report) {
    return `<p class="muted">No verification report yet. Run <code>vernier verify ${escapeHtml(issueId)} --compare</code>.</p>`;
  }

  const record = report as { selectorFound?: boolean; suggestedStatus?: string; differences?: unknown[] };

  return `<div class="tag-row">
      <span class="tag">selector ${record.selectorFound ? "found" : "missing"}</span>
      <span class="tag">suggested ${escapeHtml(record.suggestedStatus ?? "unknown")}</span>
    </div>
    <p><a href="/verification/${encodeURIComponent(issueId)}/report.md">report.md</a> · <a href="/verification/${encodeURIComponent(issueId)}/after.png">after.png</a></p>
    <pre>${escapeHtml(JSON.stringify(report, null, 2))}</pre>`;
}

async function readVerificationReports(sessionDirectory: string): Promise<Map<string, unknown>> {
  const reports = new Map<string, unknown>();
  const verificationDirectory = path.join(sessionDirectory, "verification");

  let entries;
  try {
    entries = await readdir(verificationDirectory, { withFileTypes: true });
  } catch {
    return reports;
  }

  await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory()) {
      return;
    }

    try {
      const raw = await readFile(path.join(verificationDirectory, entry.name, "report.json"), "utf8");
      reports.set(entry.name, JSON.parse(raw));
    } catch {
      // Ignore partial verification artifacts.
    }
  }));

  return reports;
}

function replayContentType(relativePath: string): string {
  if (relativePath.endsWith(".png")) {
    return "image/png";
  }

  if (relativePath.endsWith(".json")) {
    return "application/json";
  }

  return "text/plain; charset=utf-8";
}

function parsePortOption(args: string[], fallbackPort: number): number | "auto" {
  const portValue = readOption(args, "--port");

  if (!portValue) {
    return fallbackPort;
  }

  if (portValue === "auto") {
    return "auto";
  }

  const port = Number(portValue);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid --port value: ${portValue}`);
  }

  return port;
}

function readOption(args: string[], name: string): string | null {
  const index = args.indexOf(name);

  if (index === -1) {
    return null;
  }

  return args[index + 1] ?? null;
}

function readPositionalArgs(args: string[]): string[] {
  return args.filter((arg) => !arg.startsWith("--"));
}

function sendText(response: ServerResponse, statusCode: number, message: string): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.end(message);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
