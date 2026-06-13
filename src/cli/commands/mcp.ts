import { readLatestSessionMarkdown } from "../../core/handoff";
import {
  filterIssuesByStatus,
  findLatestIssue,
  type IssueStatus,
  listLatestIssues,
  markLatestIssue,
  renderIssueTask,
  renderIssueVerification,
} from "../../core/issues";

const defaultTarget = "http://localhost:5173";

export async function startMcpServer(root: string): Promise<void> {
  let buffer = "";

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;

    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);

      if (line) {
        void handleMcpMessage(root, line);
      }
    }
  });

  await new Promise<void>((resolve) => {
    process.stdin.on("end", resolve);
  });
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

async function handleMcpMessage(root: string, line: string): Promise<void> {
  let request: JsonRpcRequest;

  try {
    request = JSON.parse(line) as JsonRpcRequest;
  } catch {
    writeMcpResponse(null, undefined, { code: -32700, message: "Parse error" });
    return;
  }

  if (!request.id && request.method?.startsWith("notifications/")) {
    return;
  }

  try {
    writeMcpResponse(
      request.id ?? null,
      await dispatchMcpRequest(root, request),
    );
  } catch (error) {
    writeMcpResponse(request.id ?? null, undefined, {
      code: -32000,
      message: error instanceof Error ? error.message : "MCP request failed",
    });
  }
}

async function dispatchMcpRequest(
  root: string,
  request: JsonRpcRequest,
): Promise<unknown> {
  switch (request.method) {
    case "initialize":
      return {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "vernier", version: "0.0.0" },
        capabilities: {
          resources: {},
          tools: {},
        },
      };
    case "resources/list":
      return { resources: await listMcpResources(root) };
    case "resources/read":
      return readMcpResource(root, expectMcpStringParam(request.params, "uri"));
    case "tools/list":
      return { tools: listMcpTools() };
    case "tools/call":
      return callMcpTool(root, request.params);
    case "ping":
      return {};
    default:
      throw new Error(`Unsupported MCP method: ${request.method ?? "unknown"}`);
  }
}

async function listMcpResources(
  root: string,
): Promise<Array<{ uri: string; name: string; mimeType: string }>> {
  const resources = [
    {
      uri: "vernier://latest/session",
      name: "Latest Vernier session markdown",
      mimeType: "text/markdown",
    },
    {
      uri: "vernier://latest/issues",
      name: "Latest Vernier issues",
      mimeType: "application/json",
    },
  ];

  try {
    const issues = await listLatestIssues(root);
    resources.push(
      ...issues.map((issue) => ({
        uri: `vernier://issue/${issue.stableId}`,
        name: `Vernier issue ${issue.stableId}`,
        mimeType: "text/markdown",
      })),
    );
  } catch {
    // No sessions yet; static resources still describe the server shape.
  }

  return resources;
}

async function readMcpResource(
  root: string,
  uri: string,
): Promise<{
  contents: Array<{ uri: string; mimeType: string; text: string }>;
}> {
  if (uri === "vernier://latest/session") {
    return {
      contents: [
        {
          uri,
          mimeType: "text/markdown",
          text: await readLatestSessionMarkdown(root),
        },
      ],
    };
  }

  if (uri === "vernier://latest/issues") {
    const issues = await listLatestIssues(root);
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(issues.map(mcpIssueSummary), null, 2),
        },
      ],
    };
  }

  const issueMatch = uri.match(/^vernier:\/\/issue\/(.+)$/);

  if (issueMatch) {
    const issueReference = issueMatch[1];
    const issue = await findLatestIssue(root, issueReference);

    return {
      contents: [
        { uri, mimeType: "text/markdown", text: renderIssueTask(issue) },
      ],
    };
  }

  throw new Error(`Unknown Vernier resource: ${uri}`);
}

function listMcpTools(): Array<{
  name: string;
  description: string;
  inputSchema: unknown;
}> {
  return [
    {
      name: "list_vernier_issues",
      description: "List issues in the latest Vernier session.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["all", "todo", "fixed"] },
        },
      },
    },
    {
      name: "get_vernier_issue",
      description: "Get an agent-ready task for a Vernier issue.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
    {
      name: "mark_vernier_issue_fixed",
      description: "Mark a Vernier issue fixed.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
    {
      name: "mark_vernier_issue_todo",
      description: "Mark a Vernier issue todo.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
    {
      name: "verify_vernier_issue",
      description: "Return Vernier verification instructions for an issue.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          target: { type: "string" },
        },
        required: ["id"],
      },
    },
  ];
}

async function callMcpTool(
  root: string,
  params: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const call = expectRecordParam(params, "params");
  const name = expectStringValue(call.name, "params.name");
  const args =
    call.arguments === undefined
      ? {}
      : expectRecordParam(call.arguments, "params.arguments");

  if (name === "list_vernier_issues") {
    const status = expectOptionalStatus(args.status);
    const issues = filterIssuesByStatus(await listLatestIssues(root), status);

    return mcpText(JSON.stringify(issues.map(mcpIssueSummary), null, 2));
  }

  if (name === "get_vernier_issue") {
    return mcpText(
      renderIssueTask(
        await findLatestIssue(root, expectStringValue(args.id, "id")),
      ),
    );
  }

  if (name === "mark_vernier_issue_fixed") {
    const issue = await markLatestIssue(
      root,
      expectStringValue(args.id, "id"),
      "fixed",
    );
    return mcpText(`Marked ${issue.stableId} fixed.`);
  }

  if (name === "mark_vernier_issue_todo") {
    const issue = await markLatestIssue(
      root,
      expectStringValue(args.id, "id"),
      "todo",
    );
    return mcpText(`Marked ${issue.stableId} todo.`);
  }

  if (name === "verify_vernier_issue") {
    const issue = await findLatestIssue(root, expectStringValue(args.id, "id"));
    const target =
      typeof args.target === "string" ? args.target : defaultTarget;
    return mcpText(
      renderIssueVerification(
        issue,
        createIssueTargetUrl(target, issue.session.route),
      ),
    );
  }

  throw new Error(`Unknown Vernier MCP tool: ${name}`);
}

function mcpIssueSummary(
  issue: Awaited<ReturnType<typeof listLatestIssues>>[number],
): Record<string, unknown> {
  return {
    id: issue.stableId,
    number: issue.issue.id,
    status: issue.status,
    kind: issue.issue.kind,
    route: issue.session.route,
    viewport: issue.session.viewport,
    note: issue.issue.note,
    selector: issue.issue.selector,
    source: issue.issue.source,
    screenshotPath: issue.screenshotPath,
  };
}

function mcpText(text: string): {
  content: Array<{ type: "text"; text: string }>;
} {
  return { content: [{ type: "text", text }] };
}

function writeMcpResponse(
  id: JsonRpcRequest["id"],
  result?: unknown,
  error?: { code: number; message: string },
): void {
  process.stdout.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id,
      ...(error ? { error } : { result }),
    })}\n`,
  );
}

function expectMcpStringParam(params: unknown, key: string): string {
  const record = expectRecordParam(params, "params");
  return expectStringValue(record[key], `params.${key}`);
}

function expectRecordParam(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }

  return value as Record<string, unknown>;
}

function expectStringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a string`);
  }

  return value;
}

function expectOptionalStatus(value: unknown): IssueStatus | "all" {
  if (value === undefined) {
    return "all";
  }

  if (value === "all" || value === "todo" || value === "fixed") {
    return value;
  }

  throw new Error("status must be all, todo, or fixed");
}

function createIssueTargetUrl(target: string, route: string): string {
  return new URL(route || "/", target).toString();
}
