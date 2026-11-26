import type { Session } from '@opencode-ai/sdk/v2';
import type { Prompt, RunInput } from '../adapter.js';
import { explorer } from '../config.js';
import type { ShadowBotContext } from '../shadowbot.js';
import type { Store } from '../store.js';
import type { InteractionTarget, ToolReference } from './types.js';

type Reply = ReturnType<Store['message']>;
function string(value: unknown) { return typeof value === 'string' ? value : ''; }

// Child turns inherit the parent's rules snapshot and send interactions to its task call.
export async function runExplorerTask(input: {
  store: Store; context: ShadowBotContext; root: string; parent: Session; tool: ToolReference; args: Record<string, unknown>;
  signal: AbortSignal; instructions: string; logPrefix: string;
  startChild(child: Session, prompt: Prompt, run: RunInput, interaction: InteractionTarget): Promise<Reply>;
  abortChild(sessionID: string): Promise<unknown>;
}) {
  const { store, context, root, parent, tool, args, signal, instructions, logPrefix } = input;
  if (!['explore', explorer].includes(string(args.subagent_type)) || !string(args.prompt)) throw new Error('Invalid Explorer task');
  const prior = string(args.task_id);
  const child = prior ? store.get(prior) : store.create(root, parent.directory, { parentID: parent.id, title: string(args.description) });
  if (!child || child.parentID !== parent.id) throw new Error('Explorer session does not belong to this Copilot session');
  signal.throwIfAborted();
  const cancel = () => { void input.abortChild(child.id).catch(() => console.error(`${logPrefix} Explorer cancellation failed`)); };
  signal.addEventListener('abort', cancel, { once: true });
  let reply: Reply;
  let recycled = false;
  try {
    await context.overlay('start', parent.id, tool.callID).catch(() => console.error(`${logPrefix} Explorer overlay start failed`));
    signal.throwIfAborted();
    reply = await input.startChild(child, { agent: explorer, parts: [{ type: 'text', text: string(args.prompt) }] }, { instructions }, { sessionID: parent.id, tool });
    if (reply?.info.role !== 'assistant' || reply.info.error) throw new Error('Explorer task failed');
  } finally {
    signal.removeEventListener('abort', cancel);
    const cleanup = await context.overlay('end', parent.id, tool.callID).catch(() => {
      console.error(`${logPrefix} Explorer overlay cleanup failed`);
      return undefined;
    });
    recycled = cleanup?.recycled ?? false;
  }
  const text = reply.parts.filter(part => part.type === 'text').map(part => part.text).join('\n');
  const evidence = await context.finalizedEvidence().catch(() => undefined);
  const evidenceText = evidence ? `[SHADOWBOT_EXPLORATION_EVIDENCE]\n${JSON.stringify(evidence.snapshot).slice(0, 24_000)}` : '';
  const notice = recycled ? '任务已结束，runtime已被回收，下次执行将会启动一个全新的runtime' : '';
  return { content: [{ type: 'text' as const, text: [text, evidenceText, notice].filter(Boolean).join('\n\n') }],
    details: { parentSessionId: parent.id, sessionId: child.id, shadowbot_exploration_evidence_snapshot_id: evidence?.id } };
}
