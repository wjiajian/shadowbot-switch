import { createServer } from 'node:http';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { json } from 'node:stream/consumers';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
import { McpHub } from '../dist/service/adapters/pi/mcp.js';
import { validateCustomMcp } from '../dist/service/mcp-config.js';

test('stdio and legacy SSE run real Pi MCP requests', { timeout: 15_000 }, async () => {
  let sse;
  let rejectedInitializations = 0;
  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/host-mcp') {
      const message = await json(req);
      assert.equal(message.method, 'initialize');
      rejectedInitializations++;
      res.writeHead(405).end();
      return;
    }
    if (req.method === 'GET' && req.url === '/host-mcp') {
      sse = res;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: endpoint\ndata: /messages?sessionId=fixture\n\n');
      return;
    }
    if (req.method !== 'POST' || !req.url.startsWith('/messages?')) { res.writeHead(404).end(); return; }
    const message = await json(req);
    res.writeHead(202).end();
    if (message.id === undefined) return;
    const replies = {
      initialize: { protocolVersion: message.params?.protocolVersion, serverInfo: { name: 'sse-fixture', version: '1' }, capabilities: { tools: {} } },
      'tools/list': { tools: [{ name: 'flow.blocks.list', inputSchema: { type: 'object', properties: {} } }] },
      'tools/call': { content: [{ type: 'text', text: 'legacy SSE fixture output' }] },
    };
    if (message.method === 'tools/call') assert.equal(message.params.name, 'flow.blocks.list');
    sse.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: replies[message.method] })}\n\n`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const hub = new McpHub(process.cwd());
  try {
    await hub.reloadCustom(new Map([['local', { command: process.execPath, args: [resolve('test/fixtures/mcp-stdio.mjs')], timeout: 3 }]]));
    await hub.addBuiltin('studio-mcp', { type: 'remote', url: `http://127.0.0.1:${server.address().port}/host-mcp`, timeout: 3000 });
    assert.equal(hub.status().local.status, 'connected');
    assert.equal(hub.status()['studio-mcp'].status, 'connected');
    const tools = hub.tools();
    assert.equal((await tools.get('local_echo').definition.execute('fixture1', {})).content[0].text, 'stdio fixture output');
    assert.equal((await tools.get('studio-mcp_flow_blocks_list').definition.execute('fixture2', {})).content[0].text, 'legacy SSE fixture output');
    assert.equal(rejectedInitializations, 1);
    const invalid = await hub.reloadCustom(new Map([['studio-mcp', { command: process.execPath }]]));
    assert.match(invalid.failed['studio-mcp'], /保留/);
    assert.equal(hub.status()['studio-mcp'].status, 'connected');
    await hub.disconnect('studio-mcp');
    assert.equal(hub.status()['studio-mcp'].status, 'disabled');
  } finally {
    await hub.close();
    server.closeAllConnections();
    server.close();
  }
});

test('offline checks and Pi reload share custom MCP validation, including transport and unsupported OAuth', async () => {
  const cases = [
    ['stdio', { command: 'must-not-run', args: ['one'], env: { TOKEN: '${UNSET_TEST_TOKEN}' }, cwd: '.', timeout: 3 }, true],
    ['http', { type: 'streamable-http', url: '${UNSET_TEST_URL}/mcp', headers: { Authorization: '${UNSET_TEST_TOKEN}' } }, true],
    ['oauth', { url: 'https://example.com/mcp', oauth: { clientId: 'client', callbackUrl: 'http://[::1]:8080/callback', callbackPort: 8080, clientRegistration: 'dcr', authServerMetadataUrl: 'http://localhost/metadata' } }, false],
    ['infinite_timeout', { command: 'must-not-run', timeout: Infinity }, false],
    ['negative_timeout', { command: 'must-not-run', timeout: -1 }, false],
    ['bad_args', { command: 'must-not-run', args: [1] }, false],
    ['bad_environment', { command: 'must-not-run', env: { TOKEN: 1 } }, false],
    ['bad_header', { url: 'https://example.com/mcp', headers: { Token: false } }, false],
    ['sse', { type: 'sse', url: 'https://example.com/mcp' }, false],
    ['oauth_null', { url: 'https://example.com/mcp', oauth: null }, false],
    ['oauth_false', { url: 'https://example.com/mcp', oauth: false }, false],
    ['stdio_oauth', { command: 'must-not-run', oauth: {} }, false],
    ['unsupported_registration', { url: 'https://example.com/mcp', oauth: { clientRegistration: 'cimd' } }, false],
    ['studio-mcp', { command: 'must-not-run' }, false],
  ];
  const hub = new McpHub(process.cwd());
  try {
    for (const [name, config, valid] of cases) {
      const raw = { ...config, enabled: false };
      let offlineError;
      if (valid) assert.deepEqual(validateCustomMcp(name, raw), raw);
      else assert.throws(() => validateCustomMcp(name, raw), error => { offlineError = error.message; return true; });
      const report = await hub.reloadCustom(new Map([[name, raw]]));
      assert.equal(report.failed[name], offlineError, name);
      assert.equal(hub.status()[name].status, valid ? 'disabled' : 'failed', name);
    }
  } finally { await hub.close(); }
});

test('a dropped connection does not resend a dispatched MCP tool call', { timeout: 15_000 }, async () => {
  let toolCalls = 0;
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') { res.writeHead(405).end(); return; }
    const message = await json(req);
    if (message.id === undefined) { res.writeHead(202).end(); return; }
    if (message.method === 'tools/call') {
      toolCalls++;
      res.destroy();
      return;
    }
    const result = message.method === 'initialize'
      ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
      : { tools: [{ name: 'flow_edit', inputSchema: { type: 'object', properties: {} } }] };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const hub = new McpHub(process.cwd());
  try {
    await hub.addBuiltin('studio-mcp', { type: 'remote', url: `http://127.0.0.1:${server.address().port}/mcp`, timeout: 3000 });
    const tool = hub.tools().get('studio-mcp_flow_edit');
    assert.ok(tool);
    await assert.rejects(tool.definition.execute('dispatched-once', {}));
    assert.equal(toolCalls, 1);
  } finally {
    await hub.close();
    server.closeAllConnections();
    server.close();
  }
});

test('conflicting MCP transports are rejected before launching a command', { timeout: 10_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'shadowbot-mcp-conflict-'));
  const marker = join(root, 'launched'), executable = join(root, 'server.mjs');
  writeFileSync(executable, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'launched');\nawait import(${JSON.stringify(pathToFileURL(resolve('test/fixtures/mcp-stdio.mjs')).href)});`);
  const hub = new McpHub(root);
  try {
    const config = { type: 'http', url: 'http://127.0.0.1:1/mcp', command: process.execPath, args: [executable], timeout: 1 };
    const report = await hub.reloadCustom(new Map([['conflict', config]]));
    assert.equal(existsSync(marker), false, 'an HTTP entry must not execute an unvalidated command');
    assert.match(report.failed.conflict, /command.*url/);
    for (const type of [undefined, 'http', 'streamable-http', 'stdio']) {
      for (const command of [process.execPath, null, 42, undefined]) {
        assert.throws(() => validateCustomMcp('conflict', { ...config, type, command }), /command.*url/);
      }
    }
    assert.throws(() => validateCustomMcp('conflict', { command: 'node', url: null }), /command.*url/);
  } finally {
    await hub.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('unsupported MCP OAuth is reported before connecting while explicit header tokens remain usable', { timeout: 10_000 }, async () => {
  let requests = 0;
  const server = createServer(async (req, res) => {
    requests++;
    if (req.headers.authorization !== 'Bearer fixture-token') { res.writeHead(401).end(); return; }
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    const message = await json(req);
    if (message.id === undefined) { res.writeHead(202).end(); return; }
    const result = message.method === 'initialize'
      ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'token-fixture', version: '1' } }
      : { tools: [] };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const hub = new McpHub(process.cwd());
  try {
    const config = { url: `http://127.0.0.1:${server.address().port}/mcp`, oauth: { clientId: 'fixture', clientSecret: 'must-not-leak' } };
    const report = await hub.reloadCustom(new Map([['oauth', config]]));
    assert.equal(requests, 0, 'unsupported OAuth must not silently fall through to an unauthenticated connection');
    assert.match(report.failed.oauth, /不支持 OAuth/);
    assert.doesNotMatch(report.failed.oauth, /must-not-leak/);
    assert.throws(() => validateCustomMcp('oauth', config), /不支持 OAuth/);
    const tokenConfig = { url: config.url, headers: { Authorization: 'Bearer fixture-token' } };
    assert.deepEqual(validateCustomMcp('oauth', tokenConfig), tokenConfig);
    assert.deepEqual((await hub.reloadCustom(new Map([['oauth', tokenConfig]]))).failed, {});
    assert.equal(hub.status().oauth.status, 'connected');
    const authenticatedRequests = requests;
    assert.ok(authenticatedRequests > 0);
    assert.match((await hub.reloadCustom(new Map([['oauth', config]]))).failed.oauth, /不支持 OAuth/);
    assert.equal(requests, authenticatedRequests);
    assert.equal(hub.status().oauth.status, 'connected', 'invalid auth changes must preserve the working connection');
  } finally {
    await hub.close(); server.closeAllConnections(); server.close();
  }
});

test('the host flow and browser tools use one workspace queue', { timeout: 15_000 }, async () => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const order = [];
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    const message = await json(req);
    if (message.id === undefined) { res.writeHead(202).end(); return; }
    const studio = req.url === '/studio';
    const name = studio ? 'flow_edit' : 'execute_cell';
    let result;
    if (message.method === 'initialize') {
      result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name, version: '1' } };
    } else if (message.method === 'tools/list') {
      result = { tools: [{ name, inputSchema: { type: 'object', properties: {} } }] };
    } else if (message.method === 'tools/call') {
      order.push(`${name}:start`);
      if (studio) { started.resolve(); await release.promise; }
      order.push(`${name}:end`);
      result = { content: [{ type: 'text', text: 'fixture' }] };
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const hub = new McpHub(process.cwd());
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    await hub.addBuiltin('studio-mcp', { type: 'remote', url: `${url}/studio` });
    await hub.addBuiltin('xbot-copilot', { type: 'remote', url: `${url}/browser` });
    const tools = hub.tools();
    const first = tools.get('studio-mcp_flow_edit').definition.execute('fixture-flow', {});
    await started.promise;
    const second = tools.get('xbot-copilot_execute_cell').definition.execute('fixture-browser', {});
    await delay(50);
    const beforeRelease = [...order];
    release.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(beforeRelease, ['flow_edit:start']);
    assert.deepEqual(order, ['flow_edit:start', 'flow_edit:end', 'execute_cell:start', 'execute_cell:end']);
  } finally {
    release.resolve();
    await hub.close();
    server.closeAllConnections();
    server.close();
  }
});

test('incremental MCP reload preserves healthy connections, replaces only changed services, and reports failed replacements', { timeout: 15_000 }, async () => {
  const initializes = new Map();
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    const message = await json(req);
    if (message.id === undefined) { res.writeHead(202).end(); return; }
    if (req.url === '/broken') { res.writeHead(401).end('secret credential must not leak'); return; }
    if (message.method === 'initialize') initializes.set(req.url, (initializes.get(req.url) ?? 0) + 1);
    const result = message.method === 'initialize' ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
      : message.method === 'tools/list' ? { tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }] }
      : { content: [{ type: 'text', text: req.url }] };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const hub = new McpHub(process.cwd());
  try {
    const entries = new Map([['a', { url: `${url}/a` }], ['b', { url: `${url}/b` }]]);
    assert.equal((await hub.reloadCustom(entries)).added, 2);
    assert.equal((await hub.reloadCustom(entries)).unchanged, 2);
    assert.deepEqual(Object.fromEntries(initializes), { '/a': 1, '/b': 1 });
    entries.set('b', { url: `${url}/updated` });
    assert.equal((await hub.reloadCustom(entries)).updated, 1);
    assert.equal(initializes.get('/a'), 1);
    entries.set('b', { url: `${url}/broken`, headers: { Authorization: 'private-token' } });
    const failed = await hub.reloadCustom(entries);
    assert.match(failed.failed.b, /401/);
    assert.doesNotMatch(JSON.stringify(failed), /private-token|secret credential/);
    assert.equal(hub.status().b.status, 'connected');
    assert.equal((await hub.tools().get('b_echo').definition.execute('test', {})).content[0].text, '/updated');
    entries.set('b', { url: '${SHADOWBOT_FIXTURE_UNSET_VARIABLE}' });
    assert.match((await hub.reloadCustom(entries)).failed.b, /SHADOWBOT_FIXTURE_UNSET_VARIABLE/);
    entries.delete('b');
    assert.equal((await hub.reloadCustom(entries)).removed, 1);
    assert.equal(hub.tools().has('b_echo'), false);
    assert.equal(hub.status().a.status, 'connected');
  } finally { await hub.close(); server.closeAllConnections(); server.close(); }
});
