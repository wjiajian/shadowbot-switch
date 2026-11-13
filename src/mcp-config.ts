import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from './installation.js';
import { object } from './config.js';
import { UserError } from './errors.js';
import { appConfigFiles } from './config-paths.js';

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

/** Shared, offline configuration validation. Connecting a transport belongs to its adapter. */
export function validateCustomMcp(name: string, raw: unknown): Record<string, unknown> {
  const invalid = (message: string): never => { throw new UserError(`MCP ${name}：${message}`); };
  if (['studio-mcp', 'xbot-copilot', 'browser-use-mcp'].includes(name.toLowerCase())) invalid('此名称由影刀保留，请使用其他名称。');
  if (!/^[a-z0-9_-]{1,64}$/i.test(name)) invalid('名称只能包含英文字母、数字、下划线和连字符，最长 64 字符。');
  if (!object(raw)) return invalid('配置必须是对象。');
  const stringMap = (v: unknown) => object(v) && Object.values(v).every(x => typeof x === 'string');
  const stringField = (v: Record<string, unknown>, key: string) => { if (v[key] !== undefined && typeof v[key] !== 'string') invalid(`${key} 必须是字符串。`); };
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') invalid('enabled 必须是布尔值。');
  if (raw.timeout !== undefined && (typeof raw.timeout !== 'number' || !Number.isFinite(raw.timeout) || raw.timeout <= 0)) invalid('timeout 必须是正数（秒）。');
  stringField(raw, 'description');
  if (typeof raw.url === 'string' && [undefined, 'http', 'streamable-http'].includes(raw.type as string | undefined)) {
    const url = raw.url.replace(/\$\{[A-Z_][A-Z0-9_]*\}/gi, (_, offset: number) => offset === 0 ? 'http://environment.invalid' : 'environment');
    if (!URL.canParse(url) || !['http:', 'https:'].includes(new URL(url).protocol)) invalid('url 必须是 HTTP 或 HTTPS 地址。');
    if (raw.headers !== undefined && !stringMap(raw.headers)) invalid('headers 必须是字符串映射。');
    if (raw.oauth !== undefined) {
      if (!object(raw.oauth)) return invalid('oauth 必须是对象。');
      const oauth = raw.oauth;
      for (const key of ['clientId', 'clientSecret', 'scope', 'clientName']) stringField(oauth, key);
      if (typeof oauth.clientName === 'string' && !oauth.clientName.trim()) invalid('clientName 不能为空。');
      const port = oauth.callbackPort;
      if (port !== undefined && (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)) invalid('callbackPort 必须是有效端口号。');
      const loopback = (url: URL) => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (oauth.callbackUrl !== undefined) {
        if (typeof oauth.callbackUrl !== 'string' || !URL.canParse(oauth.callbackUrl)) return invalid('callbackUrl 必须是本地 HTTP 回调地址。');
        const callback = new URL(oauth.callbackUrl);
        if (callback.protocol !== 'http:' || !loopback(callback) || callback.search || callback.hash || callback.port && port !== undefined && Number(callback.port) !== port) invalid('callbackUrl 必须是本地 HTTP 回调地址，且与 callbackPort 一致。');
      }
      if (oauth.clientRegistration !== undefined && !['auto', 'dcr'].includes(oauth.clientRegistration as string)) invalid('clientRegistration 支持 auto 或 dcr。');
      if (oauth.authServerMetadataUrl !== undefined) {
        if (typeof oauth.authServerMetadataUrl !== 'string' || !URL.canParse(oauth.authServerMetadataUrl)) return invalid('authServerMetadataUrl 无效。');
        const metadata = new URL(oauth.authServerMetadataUrl);
        if (metadata.protocol !== 'https:' && !(metadata.protocol === 'http:' && loopback(metadata))) invalid('authServerMetadataUrl 必须是 HTTPS 或本地 HTTP 地址。');
      }
    }
  } else if (typeof raw.command === 'string' && [undefined, 'stdio'].includes(raw.type as string | undefined)) {
    if (raw.args !== undefined && (!Array.isArray(raw.args) || !raw.args.every(x => typeof x === 'string'))) invalid('args 必须是字符串数组。');
    if (raw.env !== undefined && !stringMap(raw.env)) invalid('env 必须是字符串映射。');
    stringField(raw, 'cwd');
  } else invalid('需要 command（stdio）或 url（streamable HTTP）；不支持旧 SSE 传输。');
  return raw;
}
