import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { McpClient, McpHttpError, StdioTransport, StreamableHttpTransport, normalizeMcpInputSchema, validateMcpServerConfig, toLlmContent, parseJsonRpcMessage } from '@earendil-works/pi-mcp';
import type { McpServerConfig, McpTransport, JsonRpcMessage, McpTransportSendOptions, Tool } from '@earendil-works/pi-mcp';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { McpLocalConfig, McpRemoteConfig, McpStatus } from '@opencode-ai/sdk/v2';
import { object } from './config.js';
import { limitToolText } from './context.js';
import { connectionError, UserError } from '../../errors.js';

const reserved = new Set(['studio-mcp', 'xbot-copilot', 'browser-use-mcp']);
const serverName = /^[a-z0-9_-]{1,64}$/i;
type Definition = { config: McpServerConfig; builtin: boolean };
type Connection = { client: McpClient; tools: Tool[] };

class LegacySseTransport implements McpTransport {
  private controller = new AbortController();
  private messages = new Set<(message: JsonRpcMessage) => void>();
  private errors = new Set<(error: Error) => void>();
  private closes = new Set<() => void>();
  private endpoint?: URL;
  constructor(private url: URL, private headers: Record<string, string>, private timeout: number) {}
  onMessage(listener: (message: JsonRpcMessage) => void) { this.messages.add(listener); return () => { this.messages.delete(listener); }; }
  onError(listener: (error: Error) => void) { this.errors.add(listener); return () => { this.errors.delete(listener); }; }
  onClose(listener: () => void) { this.closes.add(listener); return () => { this.closes.delete(listener); }; }

  async start() {
    const ready = Promise.withResolvers<void>();
    const timer = setTimeout(() => this.controller.abort(new Error('Legacy MCP endpoint timed out')), this.timeout);
    const pump = async () => {
      const res = await fetch(this.url, { headers: { ...this.headers, accept: 'text/event-stream' }, redirect: 'error', signal: this.controller.signal });
      if (!res.ok || !res.body || !res.headers.get('content-type')?.startsWith('text/event-stream')) throw new Error('Invalid legacy MCP SSE response');
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '', event = '', data = '';
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error('Legacy MCP event stream closed');
          buffer += chunk.value;
          if (buffer.length + data.length > 4 * 1024 * 1024) throw new Error('Legacy MCP event exceeds size limit');
          for (let eol = buffer.indexOf('\n'); eol >= 0; eol = buffer.indexOf('\n')) {
            const line = buffer.slice(0, eol).replace(/\r$/, '');
            buffer = buffer.slice(eol + 1);
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trimStart() + '\n';
            else if (!line) {
              if (event === 'endpoint') {
                const endpoint = new URL(data.trim(), this.url);
                if (endpoint.origin !== this.url.origin || endpoint.username || endpoint.password) throw new Error('Invalid legacy MCP post endpoint');
                this.endpoint = endpoint;
                ready.resolve();
              } else if (data) {
                const message = parseJsonRpcMessage(JSON.parse(data));
                for (const listener of this.messages) listener(message);
              }
              event = data = '';
            }
          }
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    };
    void pump().catch(error => {
      ready.reject(error);
      if (!this.controller.signal.aborted) for (const listener of this.errors) listener(error as Error);
      void this.close();
    });
    try { await ready.promise; } finally { clearTimeout(timer); }
  }

  async send(message: JsonRpcMessage, options?: McpTransportSendOptions) {
    if (!this.endpoint) throw new Error('Legacy MCP transport is not connected');
    const signal = options?.signal ? AbortSignal.any([this.controller.signal, options.signal]) : this.controller.signal;
    const res = await fetch(this.endpoint, { method: 'POST', redirect: 'error', signal,
      headers: { ...this.headers, 'content-type': 'application/json' }, body: JSON.stringify(message) });
    await res.body?.cancel();
    if (!res.ok) throw new Error(`Legacy MCP HTTP ${res.status}`);
  }

  async close() {
    this.controller.abort();
    const listeners = [...this.closes];
    this.closes.clear();
    for (const listener of listeners) listener();
  }
}

export { customMcp } from '../../mcp-config.js';

export function validateCustomMcp(name: string, raw: unknown) {
  if (reserved.has(name.toLowerCase())) throw new UserError(`MCP 名称 ${name} 由影刀保留，请使用其他名称。`);
  if (!serverName.test(name)) throw new UserError(`MCP 名称 ${name} 只能包含英文字母、数字、下划线和连字符，最长 64 字符。`);
  // Validate URL shape without resolving credentials or requiring the caller's environment.
  // Runtime expansion still reports a missing variable by name before connecting.
  const template = object(raw) && typeof raw.url === 'string' ? raw.url : undefined;
  const checked = template ? { ...raw as Record<string, unknown>, url: template.replace(/\$\{[A-Z_][A-Z0-9_]*\}/gi, (token, offset: number) => offset === 0 ? 'http://environment.invalid' : 'environment') } : raw;
  const validated = validateMcpServerConfig(name, checked);
  if (validated.kind === 'invalid') throw new UserError(`MCP ${name}：${validated.error}`);
  return template && 'url' in validated.config ? { ...validated.config, url: template } : validated.config;
}

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

export class McpHub {
  private definitions = new Map<string, Definition>();
  private connections = new Map<string, Connection>();
  private statuses = new Map<string, McpStatus>();
  private connecting = new Map<string, Promise<void>>();
  private builtinTail = Promise.resolve();
  private reloadErrors = new Map<string, string>();

  constructor(private workspace: string) {}

  async configureCustom(entries: Map<string, unknown>) {
    for (const [name, raw] of entries) {
      if (reserved.has(name.toLowerCase()) || this.definitions.get(name)?.builtin) throw new UserError(`MCP server name is reserved: ${name}`);
      if (!serverName.test(name)) throw new Error('Invalid MCP server name');
      const validated = validateMcpServerConfig(name, raw);
      if (validated.kind === 'invalid') {
        this.statuses.set(name, { status: 'failed', error: validated.error });
        continue;
      }
      this.definitions.set(name, { config: validated.config, builtin: false });
      await this.connect(name);
    }
  }

  async reloadCustom(entries: Map<string, unknown>) {
    const report = { added: 0, updated: 0, removed: 0, unchanged: 0, failed: {} as Record<string, string> };
    this.reloadErrors.clear();
    for (const [name, raw] of entries) {
      let config: McpServerConfig;
      try {
        config = validateCustomMcp(name, raw);
        if (this.definitions.get(name)?.builtin) throw new UserError(`MCP ${name} 由宿主管理。`);
      } catch (error) {
        const detail = error instanceof UserError ? error.message : 'MCP 配置无效。';
        this.reloadErrors.set(name, detail);
        report.failed[name] = detail;
        if (!this.connections.has(name)) this.statuses.set(name, { status: 'failed', error: detail });
        continue;
      }
      const previous = this.definitions.get(name);
      if (previous && JSON.stringify(previous.config) === JSON.stringify(config) &&
          (this.connections.has(name) || config.enabled === false)) { report.unchanged++; continue; }
      // Prepare the replacement before retiring a working connection. No tool is dispatched here.
      const candidate = new McpHub(this.workspace);
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
    const validated = validateMcpServerConfig(name, config);
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
    let client: McpClient | undefined;
    try {
      const timeout = Math.min(300_000, (config.timeout ?? 15) * 1000);
      const createClient = () => new McpClient({ name: 'ShadowBotPi', version: '0.1.0', requestTimeoutMs: timeout,
        roots: [{ uri: pathToFileURL(this.workspace).href }] });
      client = createClient();
      let transport = 'stdio';
      if ('command' in config) {
        const standardEnv = Object.fromEntries(Object.entries(process.env).filter(([key, value]) =>
          value !== undefined && /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA)$/i.test(key))) as Record<string, string>;
        const command = substitute(config.command);
        await client.connect(new StdioTransport({ command: /^(node|node\.exe)$/i.test(command) ? process.execPath : command, args: config.args?.map(substitute),
          cwd: resolve(this.workspace, substitute(config.cwd ?? '.')), inheritEnv: builtin,
          env: { ...(builtin ? {} : standardEnv), ...expanded(config.env) } }));
      } else {
        transport = 'streamable-http';
        const url = new URL(substitute(config.url));
        const headers = expanded(config.headers);
        try {
          await client.connect(new StreamableHttpTransport({ url, headers }));
        } catch (error) {
          // Older host servers can expose SSE at arbitrary paths. Only negotiate during
          // initialization, when there is no tool invocation to repeat.
          if (!builtin || !(error instanceof McpHttpError) || ![200, 202, 204, 404, 405, 415].includes(error.status)) throw error;
          transport = 'sse';
          client = createClient();
          await client.connect(new LegacySseTransport(url, headers, timeout));
        }
      }
      const tools = await client.listTools();
      const connection = { client, tools };
      this.connections.set(name, connection);
      this.watch(name, connection);
      this.statuses.set(name, { status: 'connected' });
      if (builtin) console.error(`ShadowBotPi MCP ${name} transport=${transport}`);
    } catch (error) {
      if (client) await client.close().catch(() => undefined);
      this.statuses.set(name, { status: 'failed', error: connectionError(error) });
    }
  }

  tools(onUncertain?: (name: string) => void) {
    const tools = new Map<string, { builtin: boolean; server: string; definition: ToolDefinition }>();
    const connected = [...this.connections].sort(([a], [b]) => Number(this.definitions.get(b)!.builtin) - Number(this.definitions.get(a)!.builtin));
    for (const [server, connection] of connected) {
      const builtin = this.definitions.get(server)!.builtin;
      for (const tool of connection.tools) {
        const name = `${server}_${tool.name.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name) || tools.has(name)) continue;
        tools.set(name, { builtin, server, definition: {
          name, label: tool.title ?? tool.name, description: tool.description ?? tool.name,
          parameters: normalizeMcpInputSchema(tool.inputSchema) as ToolDefinition['parameters'],
          execute: async (_id, args, signal) => {
            const invoke = async () => {
              signal?.throwIfAborted();
              const result = await connection.client.callTool(tool.name, args as Record<string, unknown>, { signal }).catch(error => {
                if (tool.annotations?.readOnlyHint !== true) onUncertain?.(name);
                throw error;
              });
              const raw = toLlmContent(result);
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
        } });
      }
    }
    return tools;
  }

  async close() {
    await Promise.allSettled([...this.definitions.keys()].map(name => this.disconnect(name)));
  }
}
