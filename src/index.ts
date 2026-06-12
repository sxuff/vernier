export { vernier } from "./plugin";
export type { VernierPluginOptions } from "./plugin";
export { vernier as default } from "./plugin";
export { injectVernierOverlay } from "./core/html";
export { VernierError } from "./core/errors";
export { createVernierOverlayScript } from "./core/overlay-script";
export { annotateJsxSource } from "./core/source-annotation";
export type { SourceAnnotationOptions } from "./core/source-annotation";
export type { OverlayRuntimeOptions, SessionOutputOptions } from "./core/overlay-options";
export { handleVernierSessionRequest } from "./core/session-handler";
export { resolveFeedbackDirectory, writeSession } from "./core/session-writer";
export { createAgentPrompt, readLatestSessionMarkdown } from "./core/handoff";
export {
  findLatestIssue,
  listLatestIssues,
  markLatestIssue,
  readLatestSession,
  renderGitHubIssueBody,
  renderGitHubIssueTitle,
  renderIssuePacket,
  renderIssueTask,
  renderIssueVerification,
  renderIssuesTask,
  updateLatestIssueNote
} from "./core/issues";
export type { AgentTemplate, IndexedVernierIssue, IssueStatus } from "./core/issues";
export { resolveSource, sourceResolvers } from "./overlay/source";
export type { SourceLocation, SourceResolution, SourceResolver } from "./overlay/source";
export { auditElementMeasurement, contrastRatio } from "./overlay/suggestions";
export { parsePixelValue, toHexColor, tokenDistance } from "./overlay/measure";
export type { VernierIssue, VernierSession } from "./schema";
export { parseArgs } from "./cli/lib/args";
export type { ParsedArgs } from "./cli/lib/args";
export { debugLog, isDebugEnabled, setDebugEnabled } from "./cli/lib/debug";
