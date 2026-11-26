import type { Prompt } from '../adapter.js';
import { explorer, object } from '../config.js';
import type { ShadowBotContext } from '../shadowbot.js';
import { databaseBusy } from '../store.js';

export function isInlineRuntimeContext(part: unknown, prompt: Prompt, hasRuntimeContext: boolean) {
  return !prompt.noReply && hasRuntimeContext && object(part) && part.type === 'text' &&
    object(part.metadata) && part.metadata.xbotPartKind === 'runtime_context';
}

export function turnRuntimeContext(context: ShadowBotContext, agent: string, signal: AbortSignal) {
  return context.instructions(agent === explorer, signal);
}

export function refreshRuntimeContext(context: ShadowBotContext, agent: string, signal: AbortSignal) {
  return context.instructions(agent === explorer, signal, true);
}

export function refreshFailureIsFatal(error: unknown) {
  return !databaseBusy(error);
}
