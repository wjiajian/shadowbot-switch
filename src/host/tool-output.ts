import { object } from '../config.js';
import { parseObject } from './json.js';
import { isExecuteTool, READ_TOOL, TASK_TOOL } from './tool-names.js';
import type { CanonicalToolKind, TextBlock } from './types.js';

const toolOutputBytes = 50 * 1024;

function isText<T extends { type: string }>(part: T): part is T & TextBlock {
  return part.type === 'text' && 'text' in part && typeof part.text === 'string';
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

export function limitToolText<T extends { type: string }>(name: string, content: readonly T[],
  options?: { kind?: CanonicalToolKind }): (T | TextBlock)[] | undefined {
  const kind = options?.kind ?? (name === READ_TOOL ? 'read' : name === TASK_TOOL ? 'task' : undefined);
  if (kind === 'task' || isExecuteTool(name)) return undefined;
  const text = content.filter(isText).map(part => part.text).join('\n\n');
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= toolOutputBytes || content.some(part => isText(part) && hasTree(part.text))) return undefined;
  const marker = `\n[Tool output truncated from ${bytes.length} UTF-8 bytes.]\n`;
  const budget = toolOutputBytes - Buffer.byteLength(marker);
  let limited = head(bytes, budget) + marker;
  if (kind === 'read') {
    const left = Math.floor(budget / 2);
    let right = bytes.length - (budget - left);
    while ((bytes[right] & 0xc0) === 0x80) right++;
    limited = head(bytes, left) + marker + bytes.subarray(right).toString('utf8');
  }
  return [{ type: 'text', text: limited }, ...content.filter(part => part.type === 'image')];
}
