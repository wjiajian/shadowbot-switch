import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from './installation.js';
import { object } from './config.js';
import { UserError } from './errors.js';
import { appConfigFiles } from './config-paths.js';

export function customMcp(agentDir: string, workspace?: string) {
  const entries = new Map<string, unknown>();
  for (const path of [join(agentDir, 'mcp.json'), ...appConfigFiles(workspace, 'mcp.json')]) {
    if (!existsSync(path)) continue;
    const content = readJson<unknown>(path);
    if (!object(content) || !object(content.mcpServers)) throw new UserError(`${path} 必须包含 mcpServers 对象。`);
    for (const [name, config] of Object.entries(content.mcpServers)) {
      const previous = entries.get(name);
      entries.set(name, object(previous) && object(config) && !('command' in config) && !('url' in config) && !('type' in config)
        ? { ...previous, ...config } : config);
    }
  }
  return entries;
}
