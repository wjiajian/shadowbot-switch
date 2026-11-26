import { pathToFileURL } from 'node:url';
import { McpClient, McpHttpError, StdioTransport, StreamableHttpTransport, normalizeMcpInputSchema, validateMcpServerConfig, toLlmContent, parseJsonRpcMessage } from '@earendil-works/pi-mcp';
import type { McpTransport, JsonRpcMessage, McpTransportSendOptions } from '@earendil-works/pi-mcp';
import { LEGACY_SSE_FALLBACK_STATUSES, type McpTransportFactory } from '../../mcp/hub.js';

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

export const piTransportFactory: McpTransportFactory = {
  validateBuiltin(name, config) {
    const result = validateMcpServerConfig(name, config);
    return result.kind === 'invalid' ? result : { kind: 'valid', config: result.config };
  },
  normalizeSchema: normalizeMcpInputSchema,
  toContent: result => toLlmContent(result as Parameters<typeof toLlmContent>[0]),
  async open(launch, { timeoutMs, workspace }) {
    const createClient = () => new McpClient({ name: 'ShadowBotPi', version: '0.1.0', requestTimeoutMs: timeoutMs,
      roots: [{ uri: pathToFileURL(workspace).href }] });
    let client = createClient();
    try {
      if (launch.kind === 'stdio') {
        await client.connect(new StdioTransport(launch));
        return { client, transport: 'stdio' };
      }
      const { url, headers } = launch;
      try {
        await client.connect(new StreamableHttpTransport({ url, headers }));
        return { client, transport: 'streamable-http' };
      } catch (error) {
        // Negotiate only during initialization, before any tool invocation.
        if (!launch.allowLegacySse || !(error instanceof McpHttpError) || !LEGACY_SSE_FALLBACK_STATUSES.includes(error.status)) throw error;
        // McpClient.connect closes the failed transport before rejecting.
        client = createClient();
        await client.connect(new LegacySseTransport(url, headers, timeoutMs));
        return { client, transport: 'sse' };
      }
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  },
};
