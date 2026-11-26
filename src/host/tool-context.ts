import { object } from '../config.js';
import { parseObject } from './json.js';
import { isExecuteTool, SKILL_TOOL, SNAPSHOT_TOOLS } from './tool-names.js';

type Fields = Record<string, unknown>;
export type ContextEntry =
  | { kind: 'calls'; calls: { id: string; name: string; arguments: Fields }[] }
  | { kind: 'result'; toolCallId: string; toolName: string; isError: boolean; text: string }
  | { kind: 'other' };

const snapshotMinChars = 600;

function stableKey(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableKey);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableKey(value[key])]));
  return value;
}

function snapshotKey(name: string, args: Fields) {
  if (name === SKILL_TOOL) return typeof args.name === 'string' ? `skill:${args.name.toLowerCase()}` : undefined;
  if (!SNAPSHOT_TOOLS.has(name)) return undefined;
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

export function planToolContext(entries: readonly ContextEntry[], compressSnapshots: boolean) {
  const calls = new Map<string, Fields>();
  const channels = new Map<string, number>();
  const candidates = new Map<number, { key: string; chars: number }>();
  const executions = new Map<number, { data: Fields; events: Fields[] }>();
  let full: number | undefined;
  const diffs: number[] = [];
  for (const [index, message] of entries.entries()) {
    if (message.kind === 'calls') {
      for (const part of message.calls) calls.set(part.id, part.arguments);
    }
    if (message.kind !== 'result' || message.isError) continue;
    const args = calls.get(message.toolCallId);
    const key = args && snapshotKey(message.toolName, args);
    if (compressSnapshots && key) {
      channels.set(key, index);
      candidates.set(index, { key, chars: JSON.stringify(args).length + message.text.length });
    }
    if (!isExecuteTool(message.toolName)) continue;
    const data = parseObject(message.text);
    if (!data) continue;
    const events = treeEvents(data);
    executions.set(index, { data, events });
    for (const event of events) {
      if (!event.browser_id || (Array.isArray(event.stdout_ranges) && !event.stdout_ranges.length)) continue;
      if (event.kind === 'diff') {
        diffs.push(index);
        if (diffs.length > 5) diffs.shift();
      } else {
        full = index;
        diffs.length = 0;
      }
    }
  }
  const plan = new Map<number, string>();
  for (const [index, message] of entries.entries()) {
    if (message.kind !== 'result') continue;
    const snapshot = candidates.get(index);
    if (snapshot && channels.get(snapshot.key) !== index && (snapshot.chars >= snapshotMinChars || message.toolName === SKILL_TOOL)) {
      plan.set(index, '[An updated result for this query appears later in the conversation.]');
      continue;
    }
    const execution = executions.get(index);
    if (!execution) continue;
    const { data, events } = execution;
    if (events.length) {
      if (index === full || diffs.includes(index)) continue;
      const compressed = trimTree(data, events);
      if (compressed) plan.set(index, JSON.stringify(compressed));
      continue;
    }
    if (typeof data.stdout !== 'string' || data.stdout.length <= 3000) continue;
    plan.set(index, JSON.stringify({ ...data, stdout: `${Array.from(data.stdout).slice(0, 3000).join('')}\n[Earlier stdout truncated.]` }));
  }
  return plan;
}

export function contextSettings(encoded = process.env.SHADOWBOT_OPENCODE_CONTEXT_CONFIG_B64) {
  const value = encoded ? parseObject(Buffer.from(encoded, 'base64').toString('utf8')) : undefined;
  return { enabled: value?.enabled !== false, compressSnapshots: value?.compress_tool_results !== false };
}
