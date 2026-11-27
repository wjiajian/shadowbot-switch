import assert from 'node:assert/strict';
import test from 'node:test';
import { contextSettings, limitToolText, projectToolContext, withRuntimeContext } from '../dist/service/adapters/pi/context.js';

const text = value => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }];
const call = (toolName, toolCallId, args, content, isError = false) => [
  { role: 'assistant', content: [{ type: 'thinking', thinking: 'Keep reasoning' }, { type: 'toolCall', id: toolCallId, name: toolName, arguments: args }] },
  { role: 'toolResult', toolName, toolCallId, content: text(content), isError },
];

test('tool output limits preserve UTF-8 and exempt trees and task handoffs', () => {
  const original = '文件开头\n' + '流程😀'.repeat(20_000) + '\n文件末尾';
  const image = { type: 'image', data: 'fixture', mimeType: 'image/png' };
  const output = limitToolText('read', [...text(original), image]);
  assert.ok(Buffer.byteLength(output[0].text) <= 50 * 1024);
  assert.match(output[0].text, /文件开头.*Tool output truncated.*文件末尾/s);
  assert.doesNotMatch(output[0].text, /�/);
  assert.equal(output[1], image);
  const tree = text({ data: { acc_tree: original } });
  assert.equal(limitToolText('browser-use-mcp_web_snapshot', tree), undefined);
  assert.equal(limitToolText('task', text(original)), undefined);
});

test('manual Pi compaction honors the same snapshot projection settings as normal turns', async t => {
  const { tempFixture, modelFixture, listen } = await import('./helpers/bridge.mjs');
  const { rmSync } = await import('node:fs');
  const { HostConfig } = await import('../dist/service/adapters/pi/config.js');
  const { PiDriver } = await import('../dist/service/adapters/pi/driver.js');
  const fixture = tempFixture(), model = modelFixture();
  const url = await listen(model.server);
  const prior = process.env.SHADOWBOT_OPENCODE_CONTEXT_CONFIG_B64;
  t.after(() => {
    if (prior === undefined) delete process.env.SHADOWBOT_OPENCODE_CONTEXT_CONFIG_B64;
    else process.env.SHADOWBOT_OPENCODE_CONTEXT_CONFIG_B64 = prior;
    model.server.close();
    rmSync(fixture.root, { recursive: true, force: true });
  });
  const config = new HostConfig();
  config.patch({ provider: { fixture: { npm: '@ai-sdk/openai-compatible', options: { baseURL: url, apiKey: 'fixture' }, models: { model: {} } } } });
  const driver = new PiDriver({ home: fixture.home, root: fixture.workspace, config });
  const meta = { id: 'fixture' };
  const manager = driver.history.prepareTurn(meta);
  for (const [key, result] of [['old', 'obsolete-snapshot '.repeat(80)], ['new', 'current-snapshot']]) {
    for (const message of call('studio-mcp_flow_blocks_list', key, {}, result)) manager.appendMessage({ ...message, timestamp: Date.now() });
  }
  meta.native_file = manager.getSessionFile();
  meta.native_leaf = manager.getLeafId();
  for (const [enabled, compress] of [[true, true], [true, false], [false, true]]) {
    process.env.SHADOWBOT_OPENCODE_CONTEXT_CONFIG_B64 = Buffer.from(JSON.stringify({ enabled, compress_tool_results: compress })).toString('base64');
    await driver.summarize(meta, { providerID: 'fixture', modelID: 'model' }, new AbortController().signal);
    const prompt = JSON.stringify(model.requests.at(-1).request.messages);
    assert.equal(prompt.includes('obsolete-snapshot'), !(enabled && compress));
    assert.match(prompt, /current-snapshot/);
  }
});

test('only newer successful snapshots of the same query supersede old results', () => {
  const name = 'studio-mcp_flow_blocks_list';
  const old = call(name, 'one', { flow_id: 'app-flow' }, 'old snapshot '.repeat(80));
  const detailed = call(name, 'two', { flow_id: 'app-flow', detail: 'full' }, 'full snapshot '.repeat(80));
  const page = call(name, 'three', { flow_id: 'app-flow', offset: 50 }, 'second page '.repeat(80));
  const newOne = call(name, 'four', { flow_id: 'app-flow', offset: 0, limit: 50, detail: 'simple' }, 'current snapshot');
  const failed = call(name, 'five', { flow_id: 'app-flow', offset: 50 }, 'request failed', true);
  const messages = [...old, ...detailed, ...page, ...newOne, ...failed];
  const result = projectToolContext(messages, true);
  assert.match(result[1].content[0].text, /updated result/);
  assert.equal(result[0], old[0]);
  assert.equal(result[3], detailed[1]);
  assert.equal(result[5], page[1]);
  assert.equal(result[7], newOne[1]);
  assert.match(messages[1].content[0].text, /old snapshot/);
  assert.equal(projectToolContext(messages, false)[1], old[1]);
  assert.deepEqual(contextSettings(Buffer.from('{"enabled":false,"compress_tool_results":false}').toString('base64')),
    { enabled: false, compressSnapshots: false });
});

test('older accessibility trees are removed from stdout while business prints stay intact', () => {
  const execute = 'xbot-copilot_execute_cell';
  const tree = (id, kind, malformed = false) => call(execute, id, {}, {
    stdout: `before:${id}|tree:${id}|after:${id}`,
    values: [id],
    exploration_events: [{ type: 'acc_tree_snapshot', browser_id: 'browser', kind,
      stdout_ranges: [{ start: malformed ? 99_999 : 8 + id.length, length: 6 + id.length }] }],
  });
  const old = tree('stale', 'full');
  const malformed = tree('broken', 'diff', true);
  const full = tree('current', 'full');
  const diffs = Array.from({ length: 6 }, (_, n) => tree(`diff${n}`, 'diff'));
  const messages = [...old, ...malformed, ...full, ...diffs.flat()];
  const result = projectToolContext(messages, true);
  const data = JSON.parse(result[1].content[0].text);
  assert.equal(data.stdout, 'before:stale|[Earlier accessibility tree omitted]after:stale');
  assert.deepEqual(data.values, ['stale']);
  assert.equal(result[3], malformed[1]);
  assert.equal(result[5], full[1]);
  assert.match(result[7].content[0].text, /Earlier accessibility tree omitted/);
  assert.equal(result.at(-1), diffs.at(-1)[1]);
  assert.match(messages[1].content[0].text, /tree:stale/);
});

test('runtime context occupies one system section and leaves tools intact', () => {
  const system = { role: 'system', content: 'System prompt', sections: { other: 'Keep' }, toolsAdded: [{ name: 'read' }] };
  const first = withRuntimeContext([system], 'Previous runtime context');
  const next = withRuntimeContext(first, 'Current runtime context');
  assert.deepEqual(next[0].sections, { other: 'Keep', 'shadowbot-runtime-context': 'Current runtime context' });
  assert.equal(next[0].toolsAdded, system.toolsAdded);
  assert.deepEqual(system.sections, { other: 'Keep' });
});
