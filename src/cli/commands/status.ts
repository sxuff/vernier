import { listLatestIssues } from "../../core/issues";
import { parseArgs } from "../lib/args";

export async function summarizeLatestStatus(root: string, args: string[]): Promise<string> {
  const issues = await listLatestIssues(root);
  const todo = issues.filter((issue) => issue.status === "todo");
  const fixed = issues.filter((issue) => issue.status === "fixed");
  const session = issues[0]?.session ?? null;
  const payload = {
    session: session ? {
      id: session.sessionId,
      route: session.route,
      url: session.url,
      createdAt: session.createdAt,
      viewport: session.viewport
    } : null,
    total: issues.length,
    todo: todo.length,
    fixed: fixed.length,
    nextTodo: todo[0] ? {
      id: todo[0].stableId,
      number: todo[0].issue.id,
      kind: todo[0].issue.kind,
      note: todo[0].issue.note
    } : null
  };

  if (parseArgs(args).flag("--json")) {
    return JSON.stringify(payload, null, 2);
  }

  if (!session) {
    return "No issues in latest Vernier session.";
  }

  return [
    `Latest session: ${session.createdAt}  ${session.route}`,
    `Issues: ${payload.total}`,
    `Todo: ${payload.todo}`,
    `Fixed: ${payload.fixed}`,
    payload.nextTodo ? `Next todo: ${payload.nextTodo.id} - ${payload.nextTodo.note || payload.nextTodo.kind}` : "Next todo: none"
  ].join("\n");
}
