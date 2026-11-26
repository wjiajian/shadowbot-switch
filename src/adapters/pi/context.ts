import type { ContextEvent, ContextWithSystemEvent } from '@earendil-works/pi-coding-agent';
import { planToolContext, type ContextEntry } from '../../host/tool-context.js';
import { RUNTIME_CONTEXT_KEY } from '../../host/tool-names.js';
export { contextSettings } from '../../host/tool-context.js';
export { limitToolText } from '../../host/tool-output.js';

type Message = ContextEvent['messages'][number];
type Result = Extract<Message, { role: 'toolResult' }>;
export const runtimeContextEntry = RUNTIME_CONTEXT_KEY;

function withText(message: Result, text: string): Result {
  return { ...message, content: [{ type: 'text', text }, ...message.content.filter(part => part.type === 'image')], details: undefined };
}

export function projectToolContext(messages: Message[], compressSnapshots: boolean) {
  const resultIndices = new Map<Result, number>();
  const entries = messages.map((message, index): ContextEntry => {
    if (message.role === 'assistant') return { kind: 'calls', calls: message.content.filter(part => part.type === 'toolCall') };
    if (message.role === 'toolResult') {
      // Pi can present the same result object more than once. Project all its occurrences alike.
      resultIndices.set(message, index);
      return { kind: 'result', toolCallId: message.toolCallId, toolName: message.toolName, isError: message.isError,
        text: message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n\n') };
    }
    return { kind: 'other' };
  });
  const plan = planToolContext(entries, compressSnapshots);
  return messages.map(message => {
    if (message.role !== 'toolResult') return message;
    const text = plan.get(resultIndices.get(message)!);
    return text === undefined ? message : withText(message, text);
  });
}

export function withRuntimeContext(messages: ContextWithSystemEvent['messages'], instructions: string) {
  const [system, ...rest] = messages;
  if (!instructions || system?.role !== 'system') return messages;
  return [{ ...system, sections: { ...system.sections, [runtimeContextEntry]: instructions } }, ...rest];
}
