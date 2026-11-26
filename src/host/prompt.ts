import { readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config, Part, Session } from '@opencode-ai/sdk/v2';
import type { Prompt } from '../adapter.js';
import { copilot, explorer, object } from '../config.js';
import { outsideWorkspace } from '../config-paths.js';
import { RequestError } from '../errors.js';
import { agentPrompt } from '../shadowbot.js';
import { id, type Store } from '../store.js';
import { isInlineRuntimeContext } from './runtime-context.js';
import type { ImageBlock } from './types.js';

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

export function parsePromptContent(prompt: Prompt, root: string, hasRuntimeContext: boolean) {
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
    else if (part.url.startsWith('file:')) {
      let path: string;
      try { path = realpathSync.native(fileURLToPath(part.url)); }
      catch { throw new RequestError(400, 'Image attachment is unavailable'); }
      if (outsideWorkspace(relative(root, path)) || statSync(path).size > 8 * 1024 * 1024) throw new RequestError(400, 'Image attachment is outside the workspace or too large');
      data = readFileSync(path).toString('base64');
    } else throw new RequestError(400, 'Unsupported attachment URL');
    if (data.length > 12 * 1024 * 1024) throw new RequestError(400, 'Image attachment is too large');
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
