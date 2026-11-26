/** Explorer handoff tool. Its output must retain the complete handoff. */
export const TASK_TOOL = 'task';
/** Default filesystem reader, whose limited output retains both ends. */
export const READ_TOOL = 'read';
/** Host tool for loading skill instructions. */
export const SKILL_TOOL = 'skill';
/** Host tool for asking the user a question. */
export const QUESTION_TOOL = 'question';
/** Host snapshot name for the current todo list. */
export const TODOWRITE_TOOL = 'todowrite';
/** Execution results carry stdout and accessibility-tree ranges. */
export const EXECUTE_TOOLS = ['xbot-copilot_execute', 'xbot-copilot_execute_cell'] as const;
/** Recognize the host execution tools regardless of harness. */
export function isExecuteTool(name: string) {
  return EXECUTE_TOOLS.some(tool => tool === name);
}
/** Later successful results for identical snapshot queries can supersede earlier ones. */
export const SNAPSHOT_TOOLS: ReadonlySet<string> = new Set(['studio-mcp_flow_blocks_list', 'studio-mcp_flow_blocks_forms',
  'studio-mcp_app_logs', 'studio-mcp_flow_get_variable_snapshots', 'studio-mcp_diagnostics_snapshot', TODOWRITE_TOOL]);
/** System section and native transcript key for runtime instructions. */
export const RUNTIME_CONTEXT_KEY = 'shadowbot-runtime-context';
/** Public host name for a tool advertised by an MCP server. */
export function mcpToolName(server: string, tool: string) {
  return `${server}_${tool.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}
