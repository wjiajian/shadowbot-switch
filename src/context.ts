import type { ContextEvent, ContextWithSystemEvent } from '@earendil-works/pi-coding-agent';
import type { ImageContent, TextContent } from '@earendil-works/pi-ai';
import { object } from './config.js';

type Content = TextContent | ImageContent;
type Message = ContextEvent['messages'][number];
type Result = Extract<Message, { role: 'toolResult' }>;
type Fields = Record<string, unknown>;
export const runtimeContextEntry = 'shadowbot-runtime-context';
const toolOutputBytes = 50 * 1024;
const snapshotMinChars = 600;

function textOf(content: Content[]) {
  return content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n\n');
}

function parseObject(text: string) {
  try {
    const parsed: unknown = JSON.parse(text);
    return object(parsed) ? parsed : undefined;
  } catch { return undefined; }
}

function isExecute(name: string) {
  return ['xbot-copilot_execute', 'xbot-copilot_execute_cell'].includes(name);
}

function hasTree(text: string) {
  const stack: unknown[] = [parseObject(text)];
  while (stack.length) {
    const entry = stack.pop();
    if (Array.isArray(entry)) { for (const child of entry) stack.push(child); continue; }
    if (!object(entry)) continue;
    if (typeof entry.acc_tree === 'string' || entry.type === 'acc_tree_snapshot') return true;
    for (const field of Object.values(entry)) if (typeof field === 'object' && field !== null) stack.push(field);
  }
  return false;
}

function head(buffer: Buffer, length: number) {
  while (length > 0 && (buffer[length] & 0xc0) === 0x80) length--;
  return buffer.subarray(0, length).toString('utf8');
}

export function limitToolText(name: string, content: Content[]): Content[] | undefined {
  if (name === 'task' || isExecute(name)) return undefined;
  const text = textOf(content);
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= toolOutputBytes || content.some(part => part.type === 'text' && hasTree(part.text))) return undefined;
  const marker = `\n[Tool output truncated from ${bytes.length} UTF-8 bytes.]\n`;
  const budget = toolOutputBytes - Buffer.byteLength(marker);
  let limited = head(bytes, budget) + marker;
  if (name === 'read') {
    const left = Math.floor(budget / 2);
    let right = bytes.length - (budget - left);
    while ((bytes[right] & 0xc0) === 0x80) right++;
    limited = head(bytes, left) + marker + bytes.subarray(right).toString('utf8');
  }
  return [{ type: 'text', text: limited }, ...content.filter(part => part.type === 'image')];
}

const snapshots = new Set(['studio-mcp_flow_blocks_list', 'studio-mcp_flow_blocks_forms', 'studio-mcp_app_logs',
  'studio-mcp_flow_get_variable_snapshots', 'studio-mcp_diagnostics_snapshot', 'todowrite']);

function stableKey(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableKey);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableKey(value[key])]));
  return value;
}

function snapshotKey(name: string, args: Fields) {
  if (name === 'skill') return typeof args.name === 'string' ? `skill:${args.name.toLowerCase()}` : undefined;
  if (!snapshots.has(name)) return undefined;
  const normalized = name === 'studio-mcp_flow_blocks_list' ? { ...args, offset: args.offset ?? 0, limit: args.limit ?? 50, detail: args.detail ?? 'simple' } : args;
  return `${name}:${JSON.stringify(stableKey(normalized))}`;
}

function treeEvents(data?: Fields) {
  return Array.isArray(data?.exploration_events) ? data.exploration_events.filter((event): event is Fields =>
    object(event) && event.type === 'acc_tree_snapshot') : [];
}

function trimTree(data: Fields, events: Fields[]) {
  const { stdout } = data;
  if (typeof stdout !== 'string' || !events.every(event => Array.isArray(event.stdout_ranges))) return;
  const ranges = new Map<number, number>();
  for (const range of events.flatMap(event => event.stdout_ranges as unknown[])) {
    if (!object(range) || typeof range.start !== 'number' || typeof range.length !== 'number' ||
        !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.length) || range.start < 0 ||
        range.length <= 0 || range.start + range.length > stdout.length) return;
    if (ranges.has(range.start) && ranges.get(range.start) !== range.length) return;
    ranges.set(range.start, range.length);
  }
  if (!ranges.size) return;
  const descending = [...ranges].sort(([a], [b]) => b - a);
  let end = stdout.length;
  let result = '';
  for (const [start, length] of descending) {
    if (start + length > end) return;
    result = `[Earlier accessibility tree omitted]${stdout.slice(start + length, end)}${result}`;
    end = start;
  }
  const next = { ...data, stdout: stdout.slice(0, end) + result,
    exploration_events: (data.exploration_events as unknown[]).map(event => events.includes(event as Fields) ? { ...(event as Fields), stdout_ranges: [] } : event) };
  return next;
}

function withText(message: Result, text: string): Result {
  return { ...message, content: [{ type: 'text', text }, ...message.content.filter(part => part.type === 'image')], details: undefined };
}

export function projectToolContext(messages: Message[], compressSnapshots: boolean) {
  const calls = new Map<string, Fields>();
  const channels = new Map<string, Result>();
  const candidates = new Map<Result, { key: string; chars: number }>();
  const executions = new Map<Result, { data: Fields; events: Fields[] }>();
  let full: Result | undefined;
  const diffs: Result[] = [];
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const part of message.content) if (part.type === 'toolCall') calls.set(part.id, part.arguments);
    }
    if (message.role !== 'toolResult' || message.isError) continue;
    const args = calls.get(message.toolCallId);
    const key = args && snapshotKey(message.toolName, args);
    if (compressSnapshots && key) {
      channels.set(key, message);
      candidates.set(message, { key, chars: JSON.stringify(args).length + textOf(message.content).length });
    }
    if (!isExecute(message.toolName)) continue;
    const data = parseObject(textOf(message.content));
    if (!data) continue;
    const events = treeEvents(data);
    executions.set(message, { data, events });
    for (const event of events) {
      if (!event.browser_id || (Array.isArray(event.stdout_ranges) && !event.stdout_ranges.length)) continue;
      if (event.kind === 'diff') {
        diffs.push(message);
        if (diffs.length > 5) diffs.shift();
      } else {
        full = message;
        diffs.length = 0;
      }
    }
  }
  return messages.map(message => {
    if (message.role !== 'toolResult') return message;
    const snapshot = candidates.get(message);
    if (snapshot && channels.get(snapshot.key) !== message && (snapshot.chars >= snapshotMinChars || message.toolName === 'skill')) {
      return withText(message, '[An updated result for this query appears later in the conversation.]');
    }
    const execution = executions.get(message);
    if (!execution) return message;
    const { data, events } = execution;
    if (events.length) {
      if (message === full || diffs.includes(message)) return message;
      const compressed = trimTree(data, events);
      return compressed ? withText(message, JSON.stringify(compressed)) : message;
    }
    if (typeof data.stdout !== 'string' || data.stdout.length <= 3000) return message;
    return withText(message, JSON.stringify({ ...data, stdout: `${Array.from(data.stdout).slice(0, 3000).join('')}\n[Earlier stdout truncated.]` }));
  });
}

export function withRuntimeContext(messages: ContextWithSystemEvent['messages'], instructions: string) {
  const [system, ...rest] = messages;
  if (!instructions || system?.role !== 'system') return messages;
  return [{ ...system, sections: { ...system.sections, [runtimeContextEntry]: instructions } }, ...rest];
}

export function contextSettings(encoded = process.env.SHADOWBOT_OPENCODE_CONTEXT_CONFIG_B64) {
  const value = encoded ? parseObject(Buffer.from(encoded, 'base64').toString('utf8')) : undefined;
  return { enabled: value?.enabled !== false, compressSnapshots: value?.compress_tool_results !== false };
}
