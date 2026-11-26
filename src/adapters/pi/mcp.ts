import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { McpHubCore } from '../../mcp/hub.js';
import { piTransportFactory } from './mcp-transport.js';
export { customMcp } from '../../mcp-config.js';

export class McpHub extends McpHubCore {
  constructor(workspace: string) { super(workspace, piTransportFactory, 'ShadowBotPi'); }

  tools(onUncertain?: (name: string) => void) {
    const tools = new Map<string, { builtin: boolean; server: string; definition: ToolDefinition }>();
    for (const tool of this.hostTools(onUncertain).values()) {
      const { name, label, description, parameters, builtin, server } = tool;
      tools.set(name, { builtin, server, definition: {
        name, label, description, parameters: parameters as ToolDefinition['parameters'],
        execute: (_id, args, signal) => tool.execute(args, signal),
      } });
    }
    return tools;
  }
}
