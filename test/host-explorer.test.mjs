import assert from 'node:assert/strict';
import test from 'node:test';
import { runExplorerTask } from '../dist/service/host/explorer.js';
function fixture() {
  const events = [];
  const controller = new AbortController();
  const tool = { messageID: 'msg', callID: 'call' };
  const child = { id: 'child', parentID: 'parent' };
  const input = { root: 'root', parent: { id: 'parent', directory: 'dir' }, tool, signal: controller.signal,
    args: { subagent_type: 'explore', prompt: 'inspect', description: 'child' }, instructions: 'rules', logPrefix: 'ShadowBotPi',
    store: { create: (...args) => { assert.deepEqual(args, ['root', 'dir', { parentID: 'parent', title: 'child' }]); return child; } },
    context: {
      overlay: async (phase, session, call) => { events.push(phase); assert.deepEqual([session, call], ['parent', 'call']); return { recycled: true }; },
      finalizedEvidence: async () => { events.push('evidence'); return { id: 'snapshot', snapshot: { key: 'value' } }; },
    },
    startChild: async (...args) => {
      events.push('child');
      assert.deepEqual(args, [child, { agent: 'shadowbot-explorer', parts: [{ type: 'text', text: 'inspect' }] },
        { instructions: 'rules' }, { sessionID: 'parent', tool }]);
      return { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'reply' }] };
    },
    abortChild: async id => events.push('cancel-' + id),
  };
  return { events, input, controller };
}
test('Explorer routes the child to its parent, closes the overlay and appends finalized evidence', async () => {
  const { events, input } = fixture();
  const reply = await runExplorerTask(input);
  assert.deepEqual(events, ['start', 'child', 'end', 'evidence']);
  assert.deepEqual(reply.details, { sessionId: 'child', parentSessionId: 'parent', shadowbot_exploration_evidence_snapshot_id: 'snapshot' });
  assert.equal(reply.content[0].text, 'reply\n\n[SHADOWBOT_EXPLORATION_EVIDENCE]\n{"key":"value"}\n\n任务已结束，runtime已被回收，下次执行将会启动一个全新的runtime');
});
test('Explorer closes the overlay on failure and forwards parent cancellation', async () => {
  const { events, input, controller } = fixture();
  input.startChild = async () => { controller.abort(); return { info: { role: 'assistant', error: {} } }; };
  await assert.rejects(runExplorerTask(input), /Explorer task failed/);
  assert.deepEqual(events, ['start', 'cancel-child', 'end']);
});
test('Explorer rejects a task from another parent before opening the overlay', async () => {
  const { events, input } = fixture();
  input.args.task_id = 'foreign';
  input.store.get = () => ({ parentID: 'other' });
  await assert.rejects(runExplorerTask(input), /Explorer session does not belong to this Copilot session/);
  assert.deepEqual(events, []);
});
test('Explorer still runs the child after an overlay start failure', async t => {
  const { input, events } = fixture();
  const log = t.mock.method(console, 'error', () => {});
  input.context.overlay = async phase => { events.push(phase); if (phase === 'start') throw new Error(); };
  await runExplorerTask(input);
  assert.deepEqual(events, ['start', 'child', 'end', 'evidence']);
  assert.deepEqual(log.mock.calls[0].arguments, ['ShadowBotPi Explorer overlay start failed']);
});
