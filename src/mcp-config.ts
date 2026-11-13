import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from './installation.js';
import { object } from './config.js';
import { UserError } from './errors.js';
import { appConfigFiles } from './config-paths.js';

// The shared configuration contract belongs to Switch, independently of any
// adapter's transport library. Validation preserves additional fields as given.
type McpConfigBase = { enabled?: boolean; description?: string; timeout?: number };
export type CustomMcpConfig = McpConfigBase & (
  { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; cwd?: string } |
  { type?: 'http' | 'streamable-http'; url: string; headers?: Record<string, string> }
);

export function mergeMcpEntry(previous: unknown, config: unknown) {
  return object(previous) && object(config) && !('command' in config) && !('url' in config) && !('type' in config) ? { ...previous, ...config } : config;
}

export function mcpInventory(paths: string[]) {
  const entries = new Map<string, unknown>();
  const sources = new Map<string, string>();
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const content = readJson<unknown>(path);
    if (!object(content) || !object(content.mcpServers)) throw new UserError(`${path} 必须包含 mcpServers 对象。`);
    for (const [name, config] of Object.entries(content.mcpServers)) {
      entries.set(name, mergeMcpEntry(entries.get(name), config));
      sources.set(name, path);
    }
  }
  return { entries, sources };
}

export function customMcp(agentDir: string, workspace?: string) {
  return mcpInventory([join(agentDir, 'mcp.json'), ...appConfigFiles(workspace, 'mcp.json')]).entries;
}

/** Used by both offline management and adapters before connecting custom MCP. */
export function validateCustomMcp(name: string, raw: unknown): CustomMcpConfig {
  const invalid = (message: string): never => { throw new UserError(`MCP ${name}：${message}`); };
  if (['studio-mcp', 'xbot-copilot', 'browser-use-mcp'].includes(name.toLowerCase())) invalid('此名称由影刀保留，请使用其他名称。');
  if (!/^[a-z0-9_-]{1,64}$/i.test(name)) invalid('名称只能包含英文字母、数字、下划线和连字符，最长 64 字符。');
  if (!object(raw)) return invalid('配置必须是对象。');
  // Match the runtime's property-presence dispatch, including null/undefined
  // values. An HTTP entry must never carry a command that bypasses stdio checks.
  if (('command' in raw) === ('url' in raw)) invalid('必须且只能配置 command（stdio）或 url（HTTP）中的一个。');
  if ('oauth' in raw) invalid('当前不支持 OAuth 登录和令牌刷新；若服务支持静态令牌，可用 headers 配置。');
  const stringMap = (v: unknown) => object(v) && Object.values(v).every(x => typeof x === 'string');
  const stringField = (v: Record<string, unknown>, key: string) => { if (v[key] !== undefined && typeof v[key] !== 'string') invalid(`${key} 必须是字符串。`); };
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') invalid('enabled 必须是布尔值。');
  if (raw.timeout !== undefined && (typeof raw.timeout !== 'number' || !Number.isFinite(raw.timeout) || raw.timeout <= 0)) invalid('timeout 必须是正数（秒）。');
  stringField(raw, 'description');
  if (typeof raw.url === 'string' && [undefined, 'http', 'streamable-http'].includes(raw.type as string | undefined)) {
    const url = raw.url.replace(/\$\{[A-Z_][A-Z0-9_]*\}/gi, (_, offset: number) => offset === 0 ? 'http://environment.invalid' : 'environment');
    if (!URL.canParse(url) || !['http:', 'https:'].includes(new URL(url).protocol)) invalid('url 必须是 HTTP 或 HTTPS 地址。');
    if (raw.headers !== undefined && !stringMap(raw.headers)) invalid('headers 必须是字符串映射。');
  } else if (typeof raw.command === 'string' && [undefined, 'stdio'].includes(raw.type as string | undefined)) {
    if (raw.args !== undefined && (!Array.isArray(raw.args) || !raw.args.every(x => typeof x === 'string'))) invalid('args 必须是字符串数组。');
    if (raw.env !== undefined && !stringMap(raw.env)) invalid('env 必须是字符串映射。');
    stringField(raw, 'cwd');
  } else invalid('需要 command（stdio）或 url（streamable HTTP）；不支持旧 SSE 传输。');
  return raw as CustomMcpConfig;
}
