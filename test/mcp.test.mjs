import { createServer } from 'node:http';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { json } from 'node:stream/consumers';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
import { McpHub } from '../dist/service/mcp.js';

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
    await hub.configureCustom(new Map([['local', { command: process.execPath, args: [resolve('test/fixtures/mcp-stdio.mjs')], timeout: 3 }]]));
    await hub.addBuiltin('studio-mcp', { type: 'remote', url: `http://127.0.0.1:${server.address().port}/host-mcp`, timeout: 3000 });
    assert.equal(hub.status().local.status, 'connected');
    assert.equal(hub.status()['studio-mcp'].status, 'connected');
    const tools = hub.tools();
    assert.equal((await tools.get('local_echo').definition.execute('fixture1', {})).content[0].text, 'stdio fixture output');
    assert.equal((await tools.get('studio-mcp_flow_blocks_list').definition.execute('fixture2', {})).content[0].text, 'legacy SSE fixture output');
    assert.equal(rejectedInitializations, 1);
    await assert.rejects(hub.configureCustom(new Map([['studio-mcp', { command: process.execPath }]])), /reserved/);
    await hub.disconnect('studio-mcp');
    assert.equal(hub.status()['studio-mcp'].status, 'disabled');
  } finally {
    await hub.close();
    server.closeAllConnections();
    server.close();
  }
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
