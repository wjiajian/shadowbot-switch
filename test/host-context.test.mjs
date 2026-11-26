import assert from 'node:assert/strict';
import test from 'node:test';
import { limitToolText } from '../dist/service/host/tool-output.js';
import { planToolContext } from '../dist/service/host/tool-context.js';
import * as pi from '../dist/service/adapters/pi/context.js';

const text = text => ({ type: 'text', text });
const image = { type: 'image', data: 'abc', mimeType: 'image/png' };
const result = (toolName, text, toolCallId = 'id', isError = false) => ({ kind: 'result', toolName, toolCallId, isError, text });

test('tool output preserves byte boundaries, tail policy, images and per-block exemptions', () => {
  const large = '头' + '流程😀'.repeat(6100) + '末';
  const content = [image, text(large)];
  for (const [name, blocks] of [['read', content], ['grep', content], ['task', content], ['xbot-copilot_execute', content],
    ['other', [text('{}'), text(JSON.stringify({ acc_tree: large }))]], ['short', [text('😀')]]]) {
    const output = limitToolText(name, blocks);
    assert.deepEqual(output, pi.limitToolText(name, blocks));
    if (!['read', 'grep'].includes(name)) { assert.equal(output, undefined); continue; }
    assert.equal(output[1], image);
    assert.ok(Buffer.byteLength(output[0].text) <= 51200);
    assert.doesNotMatch(output[0].text, /�/);
    assert.equal(output[0].text.endsWith('末'), name === 'read');
  }
  assert.deepEqual(limitToolText('alias', content, { kind: 'read' }), limitToolText('read', content));
});

test('only later successful normalized snapshots supersede at the character threshold', () => {
  const name = 'studio-mcp_flow_blocks_list';
  function pair(name, args, body, isError = false) {
    return [{ kind: 'calls', calls: [{ id: 'id', name, arguments: args }] }, result(name, body, 'id', isError)];
  }
  const plan = planToolContext([...pair(name, {}, 'a'.repeat(597)), ...pair(name, {}, 'a'.repeat(598)),
    ...pair(name, { limit: 50, offset: 0, detail: 'simple' }, 'current'),
    ...pair('skill', { name: 'Foo' }, 'tiny'), ...pair('skill', { name: 'foo' }, 'current'),
    ...pair('todowrite', {}, 'a'.repeat(700)), ...pair('todowrite', {}, 'failed', true)], true);
  assert.deepEqual([...plan.keys()], [3, 7]);
});

test('tree history spans browsers and ignores invalid, overlapping and already-trimmed ranges', () => {
  function tree(browser_id, kind, stdout_ranges = [{ start: 1, length: 2 }]) {
    return result('xbot-copilot_execute', JSON.stringify({ stdout: 'a😀' + 'x'.repeat(4000),
      exploration_events: [{ type: 'acc_tree_snapshot', browser_id, kind, stdout_ranges }] }));
  }
  const plan = planToolContext([tree('one', 'full'), tree('one', 'diff', [{ start: -1, length: 1 }]),
    tree('one', 'diff', [{ start: 1, length: 3 }, { start: 2, length: 1 }]), tree('two', 'full'),
    ...Array.from({ length: 6 }, (_, n) => tree(String(n), 'diff')), tree('old', 'full', []),
    result('xbot-copilot_execute_cell', JSON.stringify({ stdout: '😀'.repeat(3001) }))], false);
  assert.deepEqual([...plan.keys()], [0, 4, 11]);
  assert.equal(JSON.parse(plan.get(0)).stdout, 'a[Earlier accessibility tree omitted]' + 'x'.repeat(4000));
  assert.equal(JSON.parse(plan.get(11)).stdout, '😀'.repeat(3000) + '\n[Earlier stdout truncated.]');
});

test('Pi projection retains unchanged messages and image identity and clears replaced details', () => {
  const make = () => ({ role: 'toolResult', toolCallId: 'id', toolName: 'skill', isError: false,
    content: [text('tiny'), image], details: { name: 'test' } });
  const messages = [{ role: 'assistant', content: [{ type: 'toolCall', name: 'skill', id: 'id', arguments: { name: 'test' } }] },
    make(), make()];
  const projected = pi.projectToolContext(messages, true);
  assert.equal(projected[0], messages[0]);
  assert.equal(projected[2], messages[2]);
  assert.equal(projected[1].content[1], image);
  assert.equal(projected[1].details, undefined);
  assert.match(projected[1].content[0].text, /updated result/);
  const repeated = pi.projectToolContext([messages[0], messages[1], messages[1]], true);
  assert.equal(repeated[1], messages[1]);
  assert.equal(repeated[2], messages[1]);
});
