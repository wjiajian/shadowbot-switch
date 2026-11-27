import { closeSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config, Part, Session } from '@opencode-ai/sdk/v2';
import type { Prompt } from '../adapter.js';
import { copilot, explorer, object } from '../config.js';
import { isRequestError, RequestError } from '../errors.js';
import { agentPrompt } from '../shadowbot.js';
import { id, type Store } from '../store.js';
import { isInlineRuntimeContext } from './runtime-context.js';
import type { ImageBlock } from './types.js';

const MAX_FILE_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_BASE64_IMAGE_CHARS = 12 * 1024 * 1024;

function hasImageSignature(bytes: Buffer, mime: string) {
  if (mime === 'image/png') {
    return bytes.length >= 8
      && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
      && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  }
  if (mime === 'image/jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mime === 'image/gif') {
    if (bytes.length < 6) return false;
    const header = bytes.subarray(0, 6).toString('ascii');
    return header === 'GIF87a' || header === 'GIF89a';
  }
  if (mime === 'image/webp') {
    return bytes.length >= 12
      && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
      && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  }
  return false;
}

function readLocalImage(rawUrl: string, mime: string) {
  let url: URL;
  try { url = new URL(rawUrl); }
  catch { throw new RequestError(400, 'Image attachment is unavailable'); }
  if (url.protocol !== 'file:' || (url.hostname && url.hostname.toLowerCase() !== 'localhost')) {
    throw new RequestError(400, 'Unsupported attachment URL');
  }
  let path: string;
  let fd: number;
  try {
    path = realpathSync.native(fileURLToPath(url));
    fd = openSync(path, 'r');
  } catch { throw new RequestError(400, 'Image attachment is unavailable'); }
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new RequestError(400, 'Image attachment is unavailable');
    if (info.size > MAX_FILE_IMAGE_BYTES) throw new RequestError(400, 'Image attachment is too large');
    const chunks: Buffer[] = [];
    let total = 0;
    const chunk = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const read = readSync(fd, chunk, 0, Math.min(chunk.length, MAX_FILE_IMAGE_BYTES + 1 - total), null);
      if (read === 0) break;
      total += read;
      if (total > MAX_FILE_IMAGE_BYTES) throw new RequestError(400, 'Image attachment is too large');
      chunks.push(Buffer.from(chunk.subarray(0, read)));
    }
    const bytes = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, total);
    if (!hasImageSignature(bytes, mime)) throw new RequestError(400, 'Image attachment content does not match its declared MIME type');
    return bytes.toString('base64');
  } catch (error) {
    if (isRequestError(error)) throw error;
    throw new RequestError(400, 'Image attachment is unavailable');
  } finally {
    closeSync(fd);
  }
}

export function admitParts(store: Store, session: Session, prompt: Prompt) {
  if (!Array.isArray(prompt.parts) || !prompt.parts.length) throw new RequestError(400, 'The prompt requires parts');
  if (prompt.messageID && !/^msg_[a-zA-Z0-9]{6,64}$/.test(prompt.messageID)) throw new RequestError(400, 'Invalid message ID');
  const messageID = prompt.messageID ?? id('msg');
  if (store.db.prepare('SELECT 1 FROM main.message WHERE id=?').get(messageID)) {
    throw new RequestError(409, 'The prompt message was already admitted');
  }
  const provided = new Set<string>();
  const parts = prompt.parts.map(input => {
    if (!object(input)) throw new RequestError(400, 'Invalid prompt part');
    const partID = input.id ?? id('prt');
    if (typeof partID !== 'string' || !/^prt_[a-zA-Z0-9]{6,64}$/.test(partID) || provided.has(partID)) {
      throw new RequestError(400, 'Invalid or duplicate prompt part ID');
    }
    if (store.db.prepare('SELECT 1 FROM main.part WHERE id=?').get(partID)) throw new RequestError(409, 'The prompt part was already admitted');
    provided.add(partID);
    return { ...input, id: partID, sessionID: session.id, messageID } as Part;
  });
  return { messageID, parts };
}

export function promptAgent(session: Session, prompt: Prompt) {
  const agent = prompt.agent || (session.parentID ? explorer : copilot);
  if (agent !== (session.parentID ? explorer : copilot)) throw new RequestError(400, 'This session cannot use the requested agent');
  return agent;
}

export function parsePromptContent(prompt: Prompt, _root: string, hasRuntimeContext: boolean) {
  const text: string[] = [];
  const images: ImageBlock[] = [];
  for (const part of prompt.parts) {
    if (part.type === 'text' && typeof part.text === 'string') {
      if (!isInlineRuntimeContext(part, prompt, hasRuntimeContext)) text.push(part.text);
      continue;
    }
    if (part.type !== 'file' || typeof part.url !== 'string' || !/^image\/(png|jpeg|gif|webp)$/.test(part.mime)) {
      throw new RequestError(400, 'Only text and supported image parts are accepted');
    }
    let data: string;
    const prefix = `data:${part.mime};base64,`;
    if (part.url.startsWith(prefix)) data = part.url.slice(prefix.length);
    else if (part.url.startsWith('file:')) data = readLocalImage(part.url, part.mime);
    else throw new RequestError(400, 'Unsupported attachment URL');
    if (data.length > MAX_BASE64_IMAGE_CHARS) throw new RequestError(400, 'Image attachment is too large');
    images.push({ type: 'image', data, mimeType: part.mime });
  }
  if (!text.length && !images.length) throw new RequestError(400, 'The prompt is empty');
  return { text: text.join('\n\n'), images };
}

export function buildInstructions(input: {
  config: Config; root: string; agent: string; rules: string; system?: string;
  resources: string; skills: { name: string; description: string }[];
}) {
  const summary = input.skills.map(skill => `${skill.name}: ${skill.description}`).join('\n');
  // AGENTS.md rules come from the shared layer (run.instructions). prompt.system stays
  // exactly what the host sent, because it is persisted and echoed back to the host.
  return [agentPrompt(input.config, input.root, input.agent), input.rules, input.system,
    `ShadowBot reference directory: ${join(input.resources, 'Copilot', 'knowledge')}`,
    summary && `Available skills. Use the skill tool to read their instructions.\n${summary}`].filter((value): value is string => Boolean(value));
}
