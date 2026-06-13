export type { ParsedArgs } from "./cli/lib/args";
export { parseArgs } from "./cli/lib/args";
export { debugLog, isDebugEnabled, setDebugEnabled } from "./cli/lib/debug";
export { VernierError } from "./core/errors";
export { createAgentPrompt, readLatestSessionMarkdown } from "./core/handoff";
export { injectVernierOverlay } from "./core/html";
export type {
  AgentTemplate,
  IndexedVernierIssue,
  IssueStatus,
} from "./core/issues";
export {
  findLatestIssue,
  listLatestIssues,
  markLatestIssue,
  readLatestSession,
  renderGitHubIssueBody,
  renderGitHubIssueTitle,
  renderIssuePacket,
  renderIssuesTask,
  renderIssueTask,
  renderIssueVerification,
  updateLatestIssueNote,
} from "./core/issues";
export type {
  OverlayRuntimeOptions,
  SessionOutputOptions,
} from "./core/overlay-options";
export { createVernierOverlayScript } from "./core/overlay-script";
export { handleVernierSessionRequest } from "./core/session-handler";
export { resolveFeedbackDirectory, writeSession } from "./core/session-writer";
export type { SourceAnnotationOptions } from "./core/source-annotation";
export { annotateJsxSource } from "./core/source-annotation";
export { parsePixelValue, toHexColor, tokenDistance } from "./overlay/measure";
export type {
  SourceLocation,
  SourceResolution,
  SourceResolver,
} from "./overlay/source";
export { resolveSource, sourceResolvers } from "./overlay/source";
export { auditElementMeasurement, contrastRatio } from "./overlay/suggestions";
export type { VernierPluginOptions } from "./plugin";
export { vernier, vernier as default } from "./plugin";
export type { VernierIssue, VernierSession } from "./schema";
