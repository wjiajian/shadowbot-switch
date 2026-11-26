import assert from 'node:assert/strict';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import test from 'node:test';
import { authorizeToolCall, filesystemPath, hostToolNames, turnToolPolicy, visibleMcpTools } from '../dist/service/host/tools.js';
import { tempDirectory } from './helpers/store.mjs';

const descriptors = { read: { kind: 'read', permission: 'read' }, ls: { kind: 'list', permission: 'read' } };
const policy = (entries = [], customPolicy, enabled = () => true) => ({ policies: entries, customPolicy, enabled });
function setup(t) {
  const root = tempDirectory(t);
  const asks = [];
  const controller = new AbortController();
  const tool = { messageID: 'message', callID: 'call' };
  const options = { name: 'question', args: {}, root, policy: policy(), skills: [], mcp: () => undefined, descriptors,
    sessionID: 'child', interactionSession: 'parent', reference: () => tool, signal: controller.signal,
    interactions: { permission: async (...args) => { asks.push(args); return true; } } };
  return { root, asks, controller, tool, check: overrides => authorizeToolCall({ ...options, ...overrides }) };
}
const denied = reason => ({ allow: false, reason });
const allowed = { allow: true };

test('authorization decision table for skills, questions and MCP tools', async t => {
  const { check, asks } = setup(t);
  const skill = { name: 'skill', args: { name: 'one' } };
  assert.deepEqual(await check({ ...skill, policy: policy([], undefined, () => false) }), denied('Tool disabled for this turn'));
  assert.deepEqual(await check(skill), denied('The requested skill is unavailable'));
  const custom = { ...skill, skills: [{ name: 'one', source: 'custom' }] };
  const official = { ...skill, skills: [{ name: 'one', source: 'official' }] };
  assert.deepEqual(await check({ ...custom, policy: policy(['deny']) }), allowed);
  assert.deepEqual(await check(official), allowed);
  assert.deepEqual(await check({ ...official, policy: policy(['deny']) }), denied('Tool denied by the workspace permission policy'));
  assert.deepEqual(await check({}), allowed);
  assert.equal(asks.length, 0);
  assert.deepEqual(await check({ ...official, policy: policy(['ask']) }), allowed);
  assert.deepEqual(asks.pop()[4], { patterns: ['one'], always: ['one'], metadata: {} });
  const mcp = { name: 'server_tool', mcp: () => ({ builtin: false }) };
  assert.deepEqual(await check({ ...mcp, policy: policy(['deny']) }), allowed);
  assert.equal(asks.pop()[1], 'server_tool');
  assert.deepEqual(await check({ ...mcp, policy: policy(['deny'], 'allow') }), allowed);
  assert.deepEqual(await check({ ...mcp, mcp: () => ({ builtin: true }), policy: policy(['deny'], 'allow') }),
    denied('Tool denied by the workspace permission policy'));
  assert.equal(asks.length, 0);
});

test('filesystem rule targets and outside requests retain their scope and order', async t => {
  const { check, root, tool, asks } = setup(t);
  const path = join(root, 'file');
  writeFileSync(path, '');
  const options = { name: 'read', args: { path: 'file' } };
  assert.deepEqual(await check({ ...options, policy: policy([{ read: { file: 'allow' } }]) }), { allow: true, checkedPath: path });
  assert.deepEqual(await check({ ...options, name: 'ls', policy: policy([{ read: { file: 'deny' } }]) }), denied('Tool denied by the workspace permission policy'));
  assert.deepEqual(await check(options), { allow: true, checkedPath: path });
  assert.deepEqual(asks.map(row => row[1]), ['read']);
  asks.length = 0;
  const inside = join(root, 'inside');
  mkdirSync(inside);
  const external = { ...options, root: inside, args: { path } };
  assert.deepEqual(await check({ ...external, policy: policy([{ external_directory: 'deny' }]) }), denied('Access outside the workspace is denied'));
  assert.deepEqual(await check(external), { allow: true, checkedPath: path });
  assert.deepEqual(asks.map(row => [row[0], row[1], row[2], row[5]]), [['child', 'external_directory', tool, 'parent'], ['child', 'read', tool, 'parent']]);
  assert.deepEqual(asks[0][4], { patterns: [join(root, '*')], always: [join(root, '*')], metadata: { filepath: path, parentDir: root } });
  const reject = { permission: async () => false };
  assert.deepEqual(await check({ ...external, interactions: reject }), denied('Access outside the workspace was declined'));
  assert.deepEqual(await check({ ...options, interactions: reject }), denied('Permission denied by the user'));
  assert.deepEqual(await check({ ...options, args: { path: 'missing' } }), denied('The filesystem path is unavailable'));
  assert.deepEqual(options.args, { path: 'file' });
});

test('aborted decisions block and pending asks reject', async t => {
  const { check, controller } = setup(t);
  const pending = check({ name: 'other', interactions: { permission: (_session, _name, _ref, signal) =>
    new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('Run cancelled')))) } });
  controller.abort();
  await assert.rejects(pending, /Run cancelled/);
  assert.deepEqual(await check({}), denied('Run cancelled'));
});

test('realpath target is rechecked after the permission reply', async t => {
  const { check, root } = setup(t);
  const other = join(root, 'other');
  writeFileSync(other, '');
  for (const swap of [false, true]) {
    const path = join(root, String(swap));
    writeFileSync(path, '');
    const answer = await check({ name: 'read', args: { path }, interactions: { permission: async () => {
      rmSync(path);
      if (swap) symlinkSync(other, path);
      return true;
    } } });
    assert.deepEqual(answer, denied('The filesystem path changed before the tool could run'));
  }
});

test('MCP visibility follows role, permissions and tool switches', t => {
  const root = tempDirectory(t);
  const tools = new Map(['custom', 'xbot-copilot', 'browser-use-mcp', 'studio'].map(server => [server, { server, builtin: server !== 'custom' }]));
  const forAgent = (agent, config = {}, prompt = {}) => turnToolPolicy(config, agent, {}, prompt, root, root);
  for (const [role, expected] of [['copilot', ['custom', 'xbot-copilot', 'studio']], ['explorer', ['custom', 'xbot-copilot', 'browser-use-mcp']]]) {
    const agent = 'shadowbot-' + role;
    assert.deepEqual([...visibleMcpTools(tools, agent, forAgent(agent)).keys()], expected);
    const filtered = forAgent(agent, { permission: { read: 'deny', studio: 'deny' } }, { tools: { custom: false } });
    assert.deepEqual([...visibleMcpTools(tools, agent, filtered).keys()], expected.filter(n => !['custom', 'studio'].includes(n)));
    assert.deepEqual(hostToolNames(agent).filter(filtered.enabled), role === 'copilot' ?
      ['skill', 'question', 'read', 'task', 'grep', 'find', 'ls'] : ['skill', 'question', 'read']);
  }
});

test('Windows mount-style drive paths resolve to the same directory', { skip: process.platform !== 'win32' }, t => {
  const root = tempDirectory(t);
  const drive = parse(root).root.slice(0, 1).toLowerCase();
  assert.equal(filesystemPath(dirname(root), '/mnt/' + drive + '/' + root.slice(3).replaceAll('\\', '/')), root);
});
