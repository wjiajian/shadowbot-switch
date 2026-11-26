import { resolve } from 'node:path';
import type { McpLocalConfig, McpRemoteConfig, McpStatus } from '@opencode-ai/sdk/v2';
import type { McpConnection } from '../adapter.js';
import { connectionError, isUserError, UserError } from '../errors.js';
import { validateCustomMcp, type CustomMcpConfig } from '../mcp-config.js';
import { limitToolText } from '../host/tool-output.js';
import { mcpToolName } from '../host/tool-names.js';
import type { ContentBlock } from '../host/types.js';

export type HostMcpServerConfig = CustomMcpConfig;
export type McpToolInfo = {
  name: string; title?: string; description?: string; inputSchema: Record<string, unknown>; annotations?: { readOnlyHint?: boolean };
};
export type McpCallResult = { isError?: boolean; content?: unknown[]; structuredContent?: unknown };
export interface McpClientLike {
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>, options: { signal?: AbortSignal }): Promise<McpCallResult>;
  close(): Promise<void>;
  onClose(callback: () => void): void;
}
export type ResolvedLaunch =
  | { kind: 'stdio'; command: string; args?: string[]; cwd: string; env: Record<string, string>; inheritEnv: boolean }
  | { kind: 'http'; url: URL; headers: Record<string, string>; allowLegacySse: boolean };
type Transport = 'stdio' | 'streamable-http' | 'sse';
export interface McpTransportFactory {
  validateBuiltin(name: string, config: object): { kind: 'valid'; config: HostMcpServerConfig } | { kind: 'invalid'; error: string };
  /** On failure the factory closes its clients. A successful return transfers ownership to the hub. */
  open(launch: ResolvedLaunch, options: { timeoutMs: number; workspace: string }): Promise<{ client: McpClientLike; transport: Transport }>;
  normalizeSchema(schema: Record<string, unknown>): Record<string, unknown>;
  toContent(result: McpCallResult): ContentBlock[];
}
export type HostTool = {
  name: string; label: string; description: string; parameters: Record<string, unknown>; builtin: boolean; server: string;
  execute(args: unknown, signal?: AbortSignal): Promise<{ content: ContentBlock[]; details: Record<string, unknown> }>;
};
export const LEGACY_SSE_FALLBACK_STATUSES: readonly number[] = [200, 202, 204, 404, 405, 415];

const serverName = /^[a-z0-9_-]{1,64}$/i;
type Definition = { config: HostMcpServerConfig; builtin: boolean };
type Connection = { client: McpClientLike; tools: McpToolInfo[] };

function substitute(value: string) {
  return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/gi, (_, name: string) => {
    const value = process.env[name];
    if (value === undefined) throw new UserError(`缺少环境变量 ${name}。设置后重新连接 Copilot，再运行 mcp test。`);
    return value;
  });
}

function expanded(values?: Record<string, string>) {
  return Object.fromEntries(Object.entries(values ?? {}).map(([key, value]) => [key, substitute(value)]));
}

export class McpHubCore implements McpConnection {
  private definitions = new Map<string, Definition>();
  private connections = new Map<string, Connection>();
  private statuses = new Map<string, McpStatus>();
  private connecting = new Map<string, Promise<void>>();
  private builtinTail = Promise.resolve();
  private reloadErrors = new Map<string, string>();

  constructor(private workspace: string, private factory: McpTransportFactory, private logPrefix = 'ShadowBot') {}

  async reloadCustom(entries: Map<string, unknown>) {
    const report = { added: 0, updated: 0, removed: 0, unchanged: 0, failed: {} as Record<string, string> };
    this.reloadErrors.clear();
    for (const [name, raw] of entries) {
      let config: CustomMcpConfig;
      try {
        config = validateCustomMcp(name, raw);
        if (this.definitions.get(name)?.builtin) throw new UserError(`MCP ${name} 由宿主管理。`);
      } catch (error) {
        const detail = isUserError(error) ? error.message : 'MCP 配置无效。';
        this.reloadErrors.set(name, detail);
        report.failed[name] = detail;
        if (!this.connections.has(name)) this.statuses.set(name, { status: 'failed', error: detail });
        continue;
      }
      const previous = this.definitions.get(name);
      if (previous && JSON.stringify(previous.config) === JSON.stringify(config) &&
          (this.connections.has(name) || config.enabled === false)) { report.unchanged++; continue; }
      // Prepare the replacement before retiring a working connection. No tool is dispatched here.
      const candidate = new McpHubCore(this.workspace, this.factory, this.logPrefix);
      candidate.definitions.set(name, { config, builtin: false });
      await candidate.connect(name);
      const status = candidate.statuses.get(name)!;
      if (status.status === 'failed') {
        this.reloadErrors.set(name, status.error);
        report.failed[name] = status.error;
        if (!this.connections.has(name)) this.statuses.set(name, status);
        await candidate.close();
        continue;
      }
      await this.disconnect(name);
      this.definitions.set(name, { config, builtin: false });
      this.statuses.set(name, status);
      const connection = candidate.connections.get(name);
      if (connection) {
        candidate.connections.delete(name);
        this.connections.set(name, connection);
        this.watch(name, connection);
      }
      if (previous) report.updated++; else report.added++;
    }
    for (const name of [...this.statuses.keys()]) {
      if (entries.has(name)) continue;
      if (this.definitions.get(name)?.builtin) continue;
      await this.disconnect(name);
      this.definitions.delete(name);
      this.statuses.delete(name);
      report.removed++;
    }
    return report;
  }

  async addBuiltin(name: string, raw: McpLocalConfig | McpRemoteConfig) {
    if (!serverName.test(name)) throw new Error('Invalid host MCP server name');
    if (raw.type !== 'local' && raw.type !== 'remote') throw new Error('Invalid host MCP transport');
    const timeout = raw.timeout === undefined ? undefined : raw.timeout / 1000;
    const config = raw.type === 'local'
      ? { command: raw.command?.[0], args: raw.command?.slice(1), cwd: raw.cwd, env: raw.environment, enabled: raw.enabled, timeout }
      : { url: raw.url, headers: raw.headers, enabled: raw.enabled, timeout };
    const validated = this.factory.validateBuiltin(name, config);
    if (validated.kind === 'invalid') throw new Error(validated.error);
    await this.disconnect(name);
    this.definitions.set(name, { builtin: true, config: validated.config });
    await this.connect(name);
  }

  status() { return Object.fromEntries(this.statuses); }
  configurationErrors() { return Object.fromEntries(this.reloadErrors); }

  private watch(name: string, connection: Connection) {
    connection.client.onClose(() => {
      if (this.connections.get(name) === connection) {
        this.connections.delete(name);
        this.statuses.set(name, { status: 'failed', error: 'MCP 连接已关闭。下一轮将尝试重新连接，也可运行 reload。' });
      }
    });
  }

  async disconnect(name: string) {
    await this.connecting.get(name);
    const previous = this.connections.get(name);
    this.connections.delete(name);
    if (previous) await previous.client.close();
    if (this.definitions.has(name)) this.statuses.set(name, { status: 'disabled' });
  }

  async connect(name: string) {
    const previous = this.connecting.get(name);
    if (previous) return previous;
    const entry = this.definitions.get(name);
    if (!entry) throw new Error('MCP server is not registered');
    if (entry.config.enabled === false) { this.statuses.set(name, { status: 'disabled' }); return; }
    if (this.connections.has(name)) return;
    const work = this.open(name, entry);
    this.connecting.set(name, work);
    try { await work; } finally { this.connecting.delete(name); }
  }

  private async open(name: string, { config, builtin }: Definition) {
    let client: McpClientLike | undefined;
    try {
      const timeout = Math.min(300_000, (config.timeout ?? 15) * 1000);
      let launch: ResolvedLaunch;
      if ('command' in config) {
        const standardEnv = Object.fromEntries(Object.entries(process.env).filter(([key, value]) =>
          value !== undefined && /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA)$/i.test(key))) as Record<string, string>;
        const command = substitute(config.command);
        launch = { kind: 'stdio', command: /^(node|node\.exe)$/i.test(command) ? process.execPath : command, args: config.args?.map(substitute),
          cwd: resolve(this.workspace, substitute(config.cwd ?? '.')), inheritEnv: builtin,
          env: { ...(builtin ? {} : standardEnv), ...expanded(config.env) } };
      } else {
        launch = { kind: 'http', url: new URL(substitute(config.url)), headers: expanded(config.headers), allowLegacySse: builtin };
      }
      const opened = await this.factory.open(launch, { timeoutMs: timeout, workspace: this.workspace });
      client = opened.client;
      const tools = await client.listTools();
      const connection = { client, tools };
      this.connections.set(name, connection);
      this.watch(name, connection);
      this.statuses.set(name, { status: 'connected' });
      if (builtin) console.error(`${this.logPrefix} MCP ${name} transport=${opened.transport}`);
    } catch (error) {
      if (client) await client.close().catch(() => undefined);
      this.statuses.set(name, { status: 'failed', error: connectionError(error) });
    }
  }

  hostTools(onUncertain?: (name: string) => void) {
    const tools = new Map<string, HostTool>();
    const connected = [...this.connections].sort(([a], [b]) => Number(this.definitions.get(b)!.builtin) - Number(this.definitions.get(a)!.builtin));
    for (const [server, connection] of connected) {
      const builtin = this.definitions.get(server)!.builtin;
      for (const tool of connection.tools) {
        const name = mcpToolName(server, tool.name);
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name) || tools.has(name)) continue;
        tools.set(name, { builtin, server,
          name, label: tool.title ?? tool.name, description: tool.description ?? tool.name,
          parameters: this.factory.normalizeSchema(tool.inputSchema),
          execute: async (args, signal) => {
            const invoke = async () => {
              signal?.throwIfAborted();
              const result = await connection.client.callTool(tool.name, args as Record<string, unknown>, { signal }).catch(error => {
                if (tool.annotations?.readOnlyHint !== true) onUncertain?.(name);
                throw error;
              });
              const raw = this.factory.toContent(result);
              const limited = limitToolText(name, raw);
              const content = limited ?? raw;
              if (result.isError) throw new Error(content.map(item => item.type === 'text' ? item.text : '').join('\n') || 'MCP tool failed');
              const structured = result.structuredContent;
              const oversizedDetails = structured !== undefined && limitToolText(name, [{ type: 'text', text: JSON.stringify(structured) }]);
              return { content, details: limited || oversizedDetails ? { truncated: true } : { structuredContent: structured } };
            };
            if (!builtin) return invoke();
            const running = this.builtinTail.then(invoke);
            this.builtinTail = running.then(() => undefined, () => undefined);
            return running;
          },
        });
      }
    }
    return tools;
  }

  async close() {
    await Promise.allSettled([...this.definitions.keys()].map(name => this.disconnect(name)));
  }
}
