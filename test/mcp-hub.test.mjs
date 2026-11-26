import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { McpHubCore } from '../dist/service/mcp/hub.js';
import { tempDirectory } from './helpers/store.mjs';

function fixture(t) {
  const clients = [];
  const hub = new McpHubCore(tempDirectory(t), {
    validateBuiltin: (_name, config) => ({ kind: 'valid', config }),
    normalizeSchema: schema => schema, toContent: result => result.content,
    async open(launch, options) {
      const listeners = [];
      const client = { launch, options, closed: false,
        listTools: async () => {
          if (launch.command === 'fail') throw new Error('discovery failed');
          return [{ name: launch.args?.[0] || 'echo', inputSchema: { type: 'object' } }];
        },
        callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
        close: async () => { client.closed = true; listeners.forEach(f => f()); },
        onClose: listener => listeners.push(listener),
      };
      clients.push(client);
      return { client, transport: 'stdio' };
    },
  });
  t.after(() => hub.close());
  const builtin = (name, args = []) => hub.addBuiltin(name, { type: 'local', command: ['node', ...args] });
  return { clients, hub, builtin };
}

test('failed candidates close their client and preserve the active connection', async t => {
  const { hub, clients } = fixture(t);
  await hub.reloadCustom(new Map([['custom', { command: 'ok' }]]));
  const report = await hub.reloadCustom(new Map([['custom', { command: 'fail' }]]));
  assert.ok(report.failed.custom);
  assert.equal(clients[0].closed, false);
  assert.equal(clients[1].closed, true);
  assert.equal((await hub.hostTools().get('custom_echo').execute({})).content[0].text, 'ok');
  await clients[0].close();
  assert.equal(hub.status().custom.status, 'failed');
});

test('builtins share a queue across servers while custom calls can run concurrently', async t => {
  const { hub, clients, builtin } = fixture(t);
  await builtin('one');
  await builtin('two');
  await hub.reloadCustom(new Map([['custom', { command: 'ok' }]]));
  const gate = Promise.withResolvers();
  const started = [];
  for (const [index, client] of clients.entries()) client.callTool = async () => {
    started.push(index);
    if (!index) await gate.promise;
    return { content: [] };
  };
  const tools = hub.hostTools();
  const a = tools.get('one_echo').execute({});
  const b = tools.get('two_echo').execute({});
  await Promise.all([tools.get('custom_echo').execute({}), tools.get('custom_echo').execute({})]);
  assert.deepEqual(started.toSorted(), [0, 2, 2]);
  gate.resolve();
  await Promise.all([a, b]);
  assert.equal(started.at(-1), 1);
});

test('uncertain writes notify once, protocol errors stay confirmed and oversized details are omitted', async t => {
  const { hub, clients, builtin } = fixture(t);
  await builtin('one');
  const notifications = [];
  const tool = hub.hostTools(name => notifications.push(name)).get('one_echo');
  let calls = 0;
  clients[0].callTool = async () => { calls++; throw new Error('lost'); };
  await assert.rejects(tool.execute({}), /lost/);
  assert.equal(calls, 1);
  clients[0].callTool = async () => ({ isError: true, content: [{ type: 'text', text: 'refused' }] });
  await assert.rejects(tool.execute({}), /refused/);
  assert.deepEqual(notifications, ['one_echo']);
  clients[0].callTool = async () => ({ content: [], structuredContent: { repeated: 'a'.repeat(52000) } });
  assert.deepEqual((await tool.execute({})).details, { truncated: true });
});

test('launch policy preserves env isolation, exposes missing variables and gives builtins naming priority', async t => {
  const { hub, clients, builtin } = fixture(t);
  await hub.reloadCustom(new Map([['one_two', { command: 'node.exe', args: ['echo'], env: { EXTRA: 'custom' } }]]));
  await builtin('one', ['two.echo']);
  const [custom, stock] = clients.map(c => c.launch);
  assert.equal(custom.command, process.execPath);
  assert.equal(custom.inheritEnv, false);
  assert.equal(custom.env.EXTRA, 'custom');
  assert.ok(Object.keys(custom.env).every(k => /^(EXTRA|PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA)$/i.test(k)));
  assert.equal(stock.inheritEnv, true);
  assert.deepEqual(stock.env, {});
  assert.equal(hub.hostTools().get('one_two_echo').server, 'one');
  const missing = await hub.reloadCustom(new Map([['broken', { command: '${SHADOWBOT_TEST_MISSING_COMMAND_537}' }]]));
  assert.match(missing.failed.broken, /缺少环境变量 SHADOWBOT_TEST_MISSING_COMMAND_537/);
});

test('packaged core and Pi MCP adapter load with Pi SDKs only under the adapter', t => {
  const root = tempDirectory(t);
  cpSync('dist/service', join(root, 'service'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  mkdirSync(join(root, 'node_modules'));
  for (const name of ['ignore', 'yaml']) symlinkSync(resolve('node_modules', name), join(root, 'node_modules', name), 'junction');
  symlinkSync(resolve('node_modules'), join(root, 'service/adapters/pi/node_modules'), 'junction');
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    assert.throws(() => import.meta.resolve('@earendil-works/pi-mcp'), { code: 'ERR_MODULE_NOT_FOUND' });
    const { McpHubCore } = await import('./service/mcp/hub.js');
    const { McpHub } = await import('./service/adapters/pi/mcp.js');
    assert.ok(new McpHub('.') instanceof McpHubCore);
  `], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
});
