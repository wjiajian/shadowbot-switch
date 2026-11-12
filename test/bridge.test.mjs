import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { json as readJsonBody } from 'node:stream/consumers';
import assert from 'node:assert/strict';
import test from 'node:test';

const schema = readFileSync('contract/schema.sql', 'utf8');

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

function modelFixture({ usageFor = () => 9, beforeReply, readPathFor } = {}) {
  const requests = [];
  const server = createServer(async (req, res) => {
    try {
      const request = await readJsonBody(req);
      requests.push({ request, authorization: req.headers.authorization,
        providerHeader: req.headers['x-fixture-provider'], modelHeader: req.headers['x-fixture-model'] });
      const user = request.messages.findLast(item => item.role === 'user');
      const last = request.messages.at(-1);
      const content = JSON.stringify(user?.content);
      if (await beforeReply?.(content, res)) return;
      const readPath = readPathFor?.(content);
      const requestedTool = readPath ? 'read' : content.includes('probe-tool') ? 'studio-mcp_flow_blocks_list' :
        content.includes('probe-write') ? 'studio-mcp_flow_edit' :
        content.includes('probe-question') ? 'question' :
        content.includes('probe-skill') || content.includes('probe-stock-skill') ? 'skill' :
        content.includes('probe-custom') ? 'fixture_echo' :
        content.includes('Capture synthetic page evidence') ? 'xbot-copilot_execute_cell' :
        content.includes('probe-explorer') ? 'task' : undefined;
      const useTool = requestedTool && last.role !== 'tool';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({
        id: 'fixture', object: 'chat.completion.chunk', created: 1, model: request.model,
        choices: [{ index: 0, delta, finish_reason }],
      })}\n\n`);
      if (useTool) {
        const args = requestedTool === 'read' ? { path: readPath } :
          requestedTool === 'skill' ? { name: content.includes('probe-stock-skill') ? 'fixture-stock-allowed' : 'fixture-skill' } :
          requestedTool === 'question' ? { questions: [{ header: 'Choice', question: 'Continue?', options: [{ label: 'Yes', description: 'Continue' }] }] } :
          requestedTool === 'task' ? { description: 'Fixture browser task', subagent_type: 'shadowbot-explorer', prompt: 'Capture synthetic page evidence' } : {};
        chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_fixture', type: 'function', function: { name: requestedTool, arguments: JSON.stringify(args) } }] });
      } else {
        chunk({ role: 'assistant', content: 'Pi ' });
        chunk({ content: 'fixture reply' });
      }
      chunk({}, useTool ? 'tool_calls' : 'stop');
      const inputTokens = usageFor(content);
      res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: request.model,
        choices: [], usage: { prompt_tokens: inputTokens, completion_tokens: 4, total_tokens: inputTokens + 4 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    } catch {
      res.writeHead(400).end();
    }
  });
  return { server, requests };
}

function mcpFixture(name, { beforeInitialize, dropToolResponse = false, extraTools = [] } = {}) {
  let calls = 0;
  let initializations = 0;
  let held;
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' || req.method === 'DELETE') { res.writeHead(405).end(); return; }
    const message = await readJsonBody(req);
    if (!Object.hasOwn(message, 'id')) { res.writeHead(202).end(); return; }
    let result;
    if (message.method === 'initialize') {
      initializations++;
      await beforeInitialize?.();
      result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name, version: '1' } };
    }
    if (message.method === 'tools/list') result = { tools: [name, ...extraTools].map(name => ({ name, inputSchema: { type: 'object', properties: {} } })) };
    if (message.method === 'tools/call') {
      calls++;
      if (dropToolResponse) { res.destroy(); return; }
      if (held) { held.resolve(); return; }
      result = { content: [{ type: 'text', text: 'MCP fixture output' }] };
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  return { server, calls: () => calls, initializations: () => initializations,
    hold: () => { held = Promise.withResolvers(); return held.promise; } };
}

function tempFixture() {
  const root = mkdtempSync(join(tmpdir(), 'shadowbot-pi-bridge-'));
  const home = join(root, 'home');
  const database = join(home, 'opencode.db');
  const workspace = join(root, 'project');
  const other = join(root, 'other');
  const users = join(root, 'users');
  for (const dir of [home, workspace, other, users]) mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(database);
  db.exec(schema);
  db.close();
  writeFileSync(join(home, 'schema.sql'), schema);
  writeFileSync(join(home, 'install.json'), JSON.stringify({ database, users, resources: root }));
  writeFileSync(join(home, 'backend.json'), '{"mode":"pi"}');
  return { root, home, database, workspace, other };
}

async function start(fixture, config, extraEnv = {}) {
  const processLog = [];
  const password = 'fixture-server-auth';
  const child = spawn(process.execPath, [resolve('dist/service/main.js'), 'serve', '--port=0'], {
    cwd: fixture.workspace, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env, SHADOWBOT_PI_HOME: fixture.home, OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_SERVER_PASSWORD: password, ...extraEnv,
    },
  });
  const closed = once(child, 'close');
  child.stderr.on('data', data => processLog.push(data.toString()));
  const stdout = createInterface({ input: child.stdout });
  const url = await Promise.race([
    once(stdout, 'line').then(([line]) => {
      assert.match(line, /^opencode server listening on http:\/\/127\.0\.0\.1:/);
      return line.split(' ').at(-1);
    }),
    closed.then(([code]) => { throw new Error(`Bridge exited ${code}\n${processLog.join('')}`); }),
  ]);
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
  const api = (path, { method = 'GET', data, directory = fixture.workspace } = {}) => fetch(`${url}${path}`, {
    method, headers: { authorization, 'x-opencode-directory': encodeURIComponent(directory), 'content-type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(15_000),
  });
  const stop = async () => { child.kill(); await closed; stdout.close(); };
  return { url, api, stop, processLog, pid: child.pid };
}

async function stream(api) {
  const response = await api('/event');
  assert.equal(response.status, 200);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  const history = [];
  return {
    async until(predicate) {
      while (true) {
        const end = buffer.indexOf('\n\n');
        if (end >= 0) {
          const event = JSON.parse(buffer.slice(6, end));
          buffer = buffer.slice(end + 2);
          history.push(event);
          if (predicate(event)) return event;
        } else {
          const chunk = await reader.read();
          if (chunk.done) throw new Error('Event stream ended');
          buffer += chunk.value;
        }
      }
    },
    history, close: () => reader.cancel(),
  };
}

async function get(response, expected = 200) {
  const actual = await response;
  const text = await actual.text();
  assert.equal(actual.status, expected, text);
  return text ? JSON.parse(text) : undefined;
}

test('Pi chat, MCP, skills, permission, question, restore and revert', { timeout: 60_000 }, async () => {
  const fixture = tempFixture();
  const model = modelFixture();
  const modelURL = await listen(model.server);
  const studio = mcpFixture('flow_blocks_list');
  const studioURL = await listen(studio.server);
  const custom = mcpFixture('echo');
  const customURL = await listen(custom.server);
  for (const name of ['fixture-stock-allowed', 'fixture-stock-denied']) {
    const stock = join(fixture.home, 'skills', name);
    mkdirSync(stock, { recursive: true });
    writeFileSync(join(stock, 'SKILL.md'), `---\nname: ${name}\ndescription: Fixture host skill.\n---\nHost skill instructions.\n`);
  }
  const skills = join(fixture.workspace, '.pi', 'skills', 'fixture-skill');
  mkdirSync(skills, { recursive: true });
  writeFileSync(join(skills, 'SKILL.md'), '---\nname: fixture-skill\ndescription: Synthetic fixture skill.\n---\nFixture instructions.\n');
  writeFileSync(join(fixture.workspace, '.pi', 'shadowbot.json'), '{"enabledSkills":["fixture-skill"]}');
  writeFileSync(join(fixture.workspace, '.pi', 'mcp.json'), JSON.stringify({ mcpServers: { fixture: { url: customURL } } }));
  const config = { model: 'fixture/model', provider: { fixture: { npm: '@ai-sdk/openai-compatible',
    options: { baseURL: modelURL, apiKey: 'fixture-model-key', headers: { 'X-Fixture-Provider': 'provider' } },
    models: { model: { name: 'Fixture', headers: { 'X-Fixture-Model': 'model' } } } } },
  permission: { 'studio-mcp_*': 'allow', question: 'allow' },
  agent: { 'shadowbot-copilot': { permission: { skill: { '*': 'deny', 'fixture-stock-allowed': 'ask' } } } } };
  let bridge;
  let events;
  try {
    bridge = await start(fixture, config);
    const { api } = bridge;
    assert.equal((await fetch(`${bridge.url}/global/health`)).status, 401);
    assert.deepEqual(await get(api('/global/health')), { healthy: true, version: '1.18.12' });
    const session = await get(api('/session', { method: 'POST', data: { title: 'Fixture session' } }));
    const path = `/session/${session.id}`;
    assert.deepEqual(await get(api('/session', { directory: fixture.other })), []);
    await get(api(path, { directory: fixture.other }), 404);
    assert.deepEqual((await get(api('/skill'))).map(skill => skill.name).sort(), ['fixture-skill', 'fixture-stock-allowed']);
    const statuses = await get(api('/mcp', { method: 'POST', data: { name: 'studio-mcp', config: { type: 'remote', url: studioURL } } }));
    assert.equal(statuses['studio-mcp'].status, 'connected');
    assert.equal(statuses.fixture.status, 'connected');
    events = await stream(api);
    await events.until(event => event.type === 'server.connected');
    const prompt = text => get(api(`${path}/prompt_async`, { method: 'POST', data: { parts: [{ type: 'text', text }] } }), 204);
    await prompt('probe-tool');
    await events.until(event => event.type === 'session.idle');
    const history = await get(api(`${path}/message`));
    assert.equal(studio.calls(), 1, JSON.stringify({ history, modelRequests: model.requests.map(({ request }) => request), bridge: bridge.processLog }));
    assert.ok(events.history.some(event => event.type === 'message.part.delta'));
    assert.ok(history.flatMap(message => message.parts).some(part => part.type === 'tool' && part.state.status === 'completed'));
    assert.equal(history.at(-1).parts.find(part => part.type === 'text').text, 'Pi fixture reply');
    assert.equal(history.at(-1).info.tokens.output, 4);
    assert.equal(model.requests[0].authorization, 'Bearer fixture-model-key');
    assert.equal(model.requests[0].providerHeader, 'provider');
    assert.equal(model.requests[0].modelHeader, 'model');
    assert.match(JSON.stringify(model.requests[0].request.messages), /fixture-skill/);
    assert.match(JSON.stringify(model.requests[0].request.messages), /fixture-stock-allowed/);
    assert.doesNotMatch(JSON.stringify(model.requests[0].request.messages), /fixture-stock-denied/);

    await prompt('probe-skill');
    await events.until(event => event.type === 'session.idle');
    const skill = (await get(api(`${path}/message`))).flatMap(message => message.parts).find(part => part.type === 'tool' && part.tool === 'skill');
    assert.equal(skill.state.status, 'completed');
    assert.equal(skill.state.metadata.dir, skills);
    assert.ok(skill.state.output.includes(`Base directory for this skill: ${skills}`));

    await prompt('probe-stock-skill');
    const skillAsk = (await events.until(event => event.type === 'permission.asked')).properties;
    assert.equal(skillAsk.permission, 'skill');
    assert.deepEqual(skillAsk.patterns, ['fixture-stock-allowed']);
    await get(api(`/permission/${skillAsk.id}/reply`, { method: 'POST', data: { reply: 'once' } }));
    await events.until(event => event.type === 'session.idle');
    assert.match(JSON.stringify(model.requests.at(-1).request.messages), /Host skill instructions/);

    await prompt('probe-question');
    const question = await events.until(event => event.type === 'question.asked');
    assert.equal((await get(api('/question'))).length, 1);
    await get(api(`/question/${question.properties.id}/reply`, { method: 'POST', data: { answers: [['Yes']] } }));
    await events.until(event => event.type === 'session.idle');
    await get(api(`/question/${question.properties.id}/reply`, { method: 'POST', data: { answers: [['Yes']] } }), 404);

    await prompt('probe-custom');
    const permission = await events.until(event => event.type === 'permission.asked');
    assert.equal(custom.calls(), 0);
    await get(api('/config', { method: 'PATCH', data: { model: 'fixture/second', provider: { fixture: { models: { second: { name: 'Second' } } } } } }));
    await get(api('/auth/fixture', { method: 'PUT', data: { type: 'api', key: 'fixture-updated-key' } }));
    await get(api(`/permission/${permission.properties.id}/reply`, { method: 'POST', data: { reply: 'once' } }));
    await events.until(event => event.type === 'session.idle');
    assert.equal(custom.calls(), 1);
    assert.equal(model.requests.at(-1).request.model, 'model');
    assert.equal(model.requests.at(-1).authorization, 'Bearer fixture-model-key');

    await prompt('probe-custom');
    const rejected = (await events.until(event => event.type === 'permission.asked')).properties;
    await get(api(`/permission/${rejected.id}/reply`, { method: 'POST', data: { reply: 'reject' } }));
    await events.until(event => event.type === 'session.idle');
    assert.equal(custom.calls(), 1);

    const userConfig = join(fixture.workspace, '.pi', 'shadowbot.json');
    writeFileSync(userConfig, '{"enabledSkills":["fixture-skill"],"mcpPermission":{"fixture_echo":"allow"}}');
    const asks = events.history.filter(event => event.type === 'permission.asked').length;
    await prompt('probe-custom');
    await events.until(event => event.type === 'session.idle');
    assert.equal(custom.calls(), 2);
    assert.equal(events.history.filter(event => event.type === 'permission.asked').length, asks);
    writeFileSync(userConfig, '{"enabledSkills":["fixture-skill"]}');

    await prompt('probe-custom');
    await events.until(event => event.type === 'permission.asked');
    assert.equal(model.requests.at(-1).request.model, 'second');
    assert.equal(model.requests.at(-1).authorization, 'Bearer fixture-updated-key');
    assert.equal(model.requests.at(-1).providerHeader, 'provider');
    await get(api(`${path}/abort`, { method: 'POST' }));
    await events.until(event => event.type === 'session.idle');
    assert.equal(custom.calls(), 2);
    assert.deepEqual(await get(api('/permission')), []);
    await get(api(path, { method: 'PATCH', data: { title: 'Renamed' } }));

    const dispatched = custom.hold();
    const interrupted = { messageID: 'msg_fixturestream', parts: [{ type: 'text', text: 'probe-custom' }] };
    await get(api(`${path}/prompt_async`, { method: 'POST', data: interrupted }), 204);
    const waiting = await events.until(event => event.type === 'permission.asked');
    await get(api(`/permission/${waiting.properties.id}/reply`, { method: 'POST', data: { reply: 'once' } }));
    await dispatched;
    await events.close();
    events = undefined;
    await get(api(`${path}/prompt_async`, { method: 'POST', data: interrupted }), 409);
    assert.equal(custom.calls(), 3);
    await bridge.stop();

    bridge = await start(fixture, config);
    assert.equal((await get(bridge.api(path))).title, 'Renamed');
    const restored = await get(bridge.api(`${path}/message`));
    assert.equal(restored[0].info.id, history[0].info.id);
    assert.equal(restored.at(-1).parts.find(part => part.type === 'tool').state.status, 'error');
    assert.equal(restored.at(-1).info.error.name, 'MessageAbortedError');
    assert.deepEqual(await get(bridge.api('/session/status')), {});
    await get(bridge.api(`${path}/prompt_async`, { method: 'POST', data: interrupted }), 409);
    await get(bridge.api(`${path}/message`, { method: 'POST', data: { parts: [{ type: 'text', text: 'After crash' }] } }));
    assert.match(JSON.stringify(model.requests.at(-1).request.messages), /Pi was interrupted/);
    assert.equal(custom.calls(), 3);
    await get(bridge.api(`${path}/revert`, { method: 'POST', data: { messageID: history[0].info.id } }));
    assert.deepEqual(await get(bridge.api(`${path}/message`)), []);
    await get(bridge.api(`${path}/message`, { method: 'POST', data: { parts: [{ type: 'text', text: 'After revert' }] } }));
    assert.doesNotMatch(JSON.stringify(model.requests.at(-1).request.messages), /probe-tool|probe-custom/);
    assert.equal((await get(bridge.api(`${path}/message`))).length, 2);
    const other = await get(bridge.api('/session', { method: 'POST', directory: fixture.other }));
    assert.deepEqual(await get(bridge.api('/mcp', { directory: fixture.other })), {});
    await get(bridge.api(`/session/${other.id}/message`, { method: 'POST', directory: fixture.other,
      data: { parts: [{ type: 'text', text: 'Other workspace only' }] } }));
    const otherRequest = model.requests.at(-1).request;
    assert.doesNotMatch(JSON.stringify(otherRequest.messages), /After revert|fixture-skill/);
    assert.doesNotMatch(JSON.stringify(otherRequest.tools), /fixture_echo/);
    await get(bridge.api(`/session/${other.id}`), 404);
    assert.equal(await get(bridge.api(path, { method: 'DELETE' })), true);
    await get(bridge.api(path), 404);
  } finally {
    await events?.close().catch(() => undefined);
    await bridge?.stop();
    for (const { server } of [model, studio, custom]) server.closeAllConnections(), server.close();
    rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test('Explorer closes its overlay after success, failure and cancellation', { timeout: 30_000 }, async () => {
  const fixture = tempFixture();
  writeFileSync(join(fixture.workspace, 'reference.md'), 'delegated reference');
  let scenario = 'success';
  const childStarted = Promise.withResolvers();
  const model = modelFixture({ readPathFor: content => scenario === 'permission' && content.includes('Capture synthetic page evidence') ? 'reference.md' : undefined,
    beforeReply: async (content, res) => {
    if (!content.includes('Capture synthetic page evidence') || ['success', 'permission', 'reference'].includes(scenario)) return false;
    if (scenario === 'failure') {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Fixture Explorer model error' } }));
    } else {
      res.writeHead(200, { 'content-type': 'text/event-stream' }).flushHeaders();
      childStarted.resolve();
      await once(res, 'close');
    }
    return true;
  } });
  const modelURL = await listen(model.server);
  const xbot = mcpFixture('execute_cell');
  const xbotURL = await listen(xbot.server);
  const phases = [];
  let evidenceReads = 0;
  const host = createServer(async (req, res) => {
    let data;
    if (req.url === '/opencode/explorer-overlay') {
      const body = await readJsonBody(req);
      phases.push(body.Phase);
      data = { code: 0, data: { runtimeRecycled: body.Phase === 'end' } };
    } else if (req.url === '/opencode/exploration-evidence') {
      evidenceReads++;
      const snapshot = { project_selectors: ['fixture-selector'] };
      data = phases.at(-1) === 'end' ? { finalized: true, task_id: 'fixture-evidence', latest_finalized_task_id: 'fixture-evidence',
        snapshot: scenario === 'reference' ? undefined : snapshot, latest_finalized_snapshot: snapshot } : { finalized: false };
    } else if (req.url === '/opencode/browser-preferences') {
      data = { code: 0, data: { preference_source: 'fixture', available_browsers: [{ display_name: 'Fixture Chrome', mode: 'chrome' }],
        common_browsers: [{ display_name: 'Fixture Edge', web_type: 'edge' }] } };
    } else data = { code: 0, data: 'fixture host context' };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(data));
  });
  const hostURL = await listen(host);
  const artifacts = join(fixture.home, 'runtime');
  let bridge;
  let events;
  try {
    bridge = await start(fixture, { model: 'fixture/model', provider: { fixture: { npm: '@ai-sdk/openai-compatible',
      options: { baseURL: modelURL, apiKey: 'fixture-key' }, models: { model: { name: 'Fixture' } } } },
    agent: {
      'shadowbot-copilot': { tools: { 'xbot-copilot_execute_cell': false }, permission: { '*': 'deny', task: { '*': 'deny', 'shadowbot-explorer': 'allow' } } },
      'shadowbot-explorer': { permission: { '*': 'deny', 'xbot-copilot_execute_cell': 'allow', read: 'ask' } },
    } }, {
      SHADOWBOT_OPENCODE_WORKSPACE_ROOT: fixture.workspace,
      SHADOWBOT_OPENCODE_REWRITE_DIR: artifacts,
      SHADOWBOT_OPENCODE_EVIDENCE_URL: `${hostURL}/opencode/exploration-evidence`,
      SHADOWBOT_OPENCODE_RUNTIME_CONTEXT_URL: `${hostURL}/opencode/runtime-context`,
    });
    const { api } = bridge;
    const registered = await get(api('/mcp', { method: 'POST', data: { name: 'xbot-copilot', config: { type: 'remote', url: xbotURL } } }));
    assert.equal(registered['xbot-copilot'].status, 'connected');
    assert.equal(JSON.parse(readFileSync(join(artifacts, 'plugin-health.json'), 'utf8')).plugin_loaded, true);
    const pathInfo = await get(api('/path', { directory: fixture.other }));
    assert.equal(pathInfo.worktree, fixture.workspace);
    assert.equal(pathInfo.directory, fixture.other);
    const parent = await get(api('/session', { method: 'POST', directory: fixture.other, data: { title: 'Copilot' } }));
    await get(api(`/session/${parent.id}/message`, { method: 'POST', data: { parts: [{ type: 'text', text: 'probe-explorer' }] } }));
    const [child] = await get(api(`/session/${parent.id}/children`));
    assert.equal(child.parentID, parent.id);
    assert.deepEqual(phases, ['start', 'end']);
    const messages = await get(api(`/session/${parent.id}/message`));
    const card = messages.flatMap(message => message.parts).find(part => part.type === 'tool');
    assert.equal(card.state.status, 'completed');
    assert.equal(card.state.metadata.sessionId, child.id);
    assert.equal(card.state.metadata.shadowbot_exploration_evidence_snapshot_id, 'fixture-evidence');
    assert.match(card.state.output, /fixture-selector/);
    assert.match(card.state.output, /"evidence_role":"authoritative"/);
    assert.match(JSON.stringify(model.requests[1].request.messages), /fixture host context.*SHADOWBOT_BROWSER_PREFERENCE.*Fixture Chrome.*Fixture Edge/s);
    assert.doesNotMatch(JSON.stringify(model.requests[0].request.messages), /SHADOWBOT_BROWSER_PREFERENCE/);
    assert.doesNotMatch(JSON.stringify(model.requests[0].request.tools ?? []), /"name":"xbot-copilot_execute_cell"/);
    assert.match(JSON.stringify(model.requests[1].request.tools ?? []), /"name":"xbot-copilot_execute_cell"/);
    assert.equal(xbot.calls(), 1);
    assert.doesNotMatch(JSON.stringify(model.requests[1].request.tools ?? []), /"name":"task"/);
    events = await stream(api);
    await events.until(event => event.type === 'server.connected');
    await get(api(`/session/${parent.id}`, { method: 'DELETE' }));
    const removed = await events.until(event => event.type === 'session.deleted' && event.properties.info.id === parent.id);
    assert.equal(removed.properties.info.directory, fixture.other);

    scenario = 'permission';
    phases.length = 0;
    const delegated = await get(api('/session', { method: 'POST' }));
    await get(api(`/session/${delegated.id}/prompt_async`, { method: 'POST', data: { parts: [{ type: 'text', text: 'probe-explorer' }] } }), 204);
    const delegatedAsk = (await events.until(event => event.type === 'permission.asked')).properties;
    assert.equal(delegatedAsk.sessionID, delegated.id);
    const taskCard = (await get(api(`/session/${delegated.id}/message`))).flatMap(message => message.parts).find(part => part.type === 'tool');
    assert.deepEqual(delegatedAsk.tool, { messageID: taskCard.messageID, callID: taskCard.callID });
    await get(api(`/session/${delegated.id}/permissions/${delegatedAsk.id}`, { method: 'POST', data: { response: 'once' } }));
    await events.until(event => event.type === 'session.idle' && event.properties.sessionID === delegated.id);
    assert.deepEqual(phases, ['start', 'end']);
    assert.ok(model.requests.some(({ request }) => JSON.stringify(request.messages).includes('delegated reference')));

    scenario = 'reference';
    phases.length = 0;
    const reference = await get(api('/session', { method: 'POST' }));
    await get(api(`/session/${reference.id}/message`, { method: 'POST', data: { parts: [{ type: 'text', text: 'probe-explorer' }] } }));
    const referenceCard = (await get(api(`/session/${reference.id}/message`))).flatMap(message => message.parts).find(part => part.type === 'tool');
    assert.equal(referenceCard.state.status, 'completed');
    assert.equal(referenceCard.state.metadata.shadowbot_exploration_evidence_snapshot_id, undefined);
    assert.doesNotMatch(referenceCard.state.output, /SHADOWBOT_EXPLORATION_EVIDENCE/);

    const successfulReads = evidenceReads;
    const exploration = { parts: [{ type: 'text', text: 'probe-explorer' }] };
    scenario = 'failure';
    phases.length = 0;
    const failed = await get(api('/session', { method: 'POST' }));
    await get(api(`/session/${failed.id}/message`, { method: 'POST', data: exploration }));
    const failedMessages = await get(api(`/session/${failed.id}/message`));
    assert.equal(failedMessages.flatMap(message => message.parts).find(part => part.type === 'tool').state.status, 'error');
    assert.deepEqual(phases, ['start', 'end']);
    assert.equal(evidenceReads, successfulReads);

    scenario = 'cancel';
    phases.length = 0;
    const cancelled = await get(api('/session', { method: 'POST' }));
    await get(api(`/session/${cancelled.id}/prompt_async`, { method: 'POST', data: exploration }), 204);
    await childStarted.promise;
    assert.equal(await get(api(`/session/${cancelled.id}/abort`, { method: 'POST' })), true);
    assert.deepEqual(phases, ['start', 'end']);
    assert.equal(evidenceReads, successfulReads);
    assert.deepEqual(await get(api('/session/status')), {});
  } finally {
    await events?.close().catch(() => undefined);
    await bridge?.stop();
    for (const server of [host, model.server, xbot.server]) { server.closeAllConnections(); server.close(); }
    rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test('concurrent prompts share one MCP reload and wait for its completed tool set', { timeout: 30_000 }, async () => {
  const fixture = tempFixture();
  const model = modelFixture();
  const modelURL = await listen(model.server);
  const connecting = Promise.withResolvers();
  const proceed = Promise.withResolvers();
  const custom = mcpFixture('echo', { beforeInitialize: async () => { connecting.resolve(); await proceed.promise; } });
  const customURL = await listen(custom.server);
  const config = { model: 'fixture/model', provider: { fixture: { npm: '@ai-sdk/openai-compatible',
    options: { baseURL: modelURL, apiKey: 'fixture-model-key' }, models: { model: { name: 'Fixture' } } } } };
  let bridge;
  try {
    bridge = await start(fixture, config);
    const { api } = bridge;
    const first = await get(api('/session', { method: 'POST' }));
    const second = await get(api('/session', { method: 'POST' }));
    const settings = join(fixture.workspace, '.pi');
    mkdirSync(settings);
    writeFileSync(join(settings, 'mcp.json'), JSON.stringify({ mcpServers: { fixture: { url: customURL } } }));
    writeFileSync(join(fixture.home, 'reload.request'), 'reload-fixture');
    const prompt = session => get(api(`/session/${session.id}/message`, { method: 'POST', data: { parts: [{ type: 'text', text: 'Check tools' }] } }));
    const firstReply = prompt(first);
    await connecting.promise;
    const secondReply = prompt(second);
    // Let the second HTTP request reach the bridge while MCP initialize is still held.
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(model.requests.length, 0);
    proceed.resolve();
    await Promise.all([firstReply, secondReply]);
    assert.equal(custom.initializations(), 1);
    assert.equal(model.requests.length, 2);
    assert.ok(model.requests.every(({ request }) => request.tools.some(tool => tool.function?.name === 'fixture_echo')));
  } finally {
    proceed.resolve();
    await bridge?.stop();
    for (const { server } of [model, custom]) { server.closeAllConnections(); server.close(); }
    rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test('SQLite busy rejects admission and status recovers an abandoned local run lease', { timeout: 20_000 }, async () => {
  const fixture = tempFixture();
  const model = modelFixture();
  const modelURL = await listen(model.server);
  const config = { model: 'fixture/model', provider: { fixture: { npm: '@ai-sdk/openai-compatible',
    options: { baseURL: modelURL, apiKey: 'fixture-model-key' }, models: { model: { name: 'Fixture' } } } } };
  let bridge;
  let writer;
  try {
    bridge = await start(fixture, config);
    const { api } = bridge;
    const session = await get(api('/session', { method: 'POST' }));
    const messageID = 'msg_fixtureSqliteBusy';
    const prompt = () => api(`/session/${session.id}/message`, { method: 'POST', data: {
      messageID, parts: [{ type: 'text', text: 'Retry after releasing the session database' }],
    } });
    writer = new DatabaseSync(join(fixture.home, 'backends', 'pi', 'adapter.db'));
    writer.exec('BEGIN IMMEDIATE');
    const error = await get(prompt(), 503);
    assert.equal(error.name, 'DatabaseBusyError');
    assert.equal(model.requests.length, 0);
    writer.exec('ROLLBACK');
    writer.prepare('UPDATE session SET running=1, owner_pid=? WHERE id=?').run(bridge.pid, session.id);
    assert.deepEqual(await get(api('/session/status')), {});
    await get(prompt());
    assert.equal(model.requests.length, 1);
    assert.equal((await get(api(`/session/${session.id}/message`)))[0].info.id, messageID);
  } finally {
    writer?.close();
    await bridge?.stop();
    model.server.closeAllConnections();
    model.server.close();
    rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test('an unconfirmed MCP write ends the Pi turn before the model can repeat it', { timeout: 20_000 }, async () => {
  const fixture = tempFixture();
  const model = modelFixture();
  const modelURL = await listen(model.server);
  const mcp = mcpFixture('flow_edit', { dropToolResponse: true });
  const mcpURL = await listen(mcp.server);
  const config = { model: 'fixture/model', provider: { fixture: { npm: '@ai-sdk/openai-compatible',
    options: { baseURL: modelURL, apiKey: 'fixture-model-key' }, models: { model: { name: 'Fixture' } } } },
    permission: { 'studio-mcp_*': 'allow' } };
  let bridge;
  try {
    bridge = await start(fixture, config);
    const { api } = bridge;
    const session = await get(api('/session', { method: 'POST' }));
    const registered = await get(api('/mcp', { method: 'POST', data: {
      name: 'studio-mcp', config: { type: 'remote', url: mcpURL, timeout: 3000 },
    } }));
    assert.equal(registered['studio-mcp'].status, 'connected');
    const outcome = await get(api(`/session/${session.id}/message`, { method: 'POST', data: { parts: [{ type: 'text', text: 'probe-write' }] } }));
    assert.match(outcome.info.error.data.message, /did not confirm its outcome/);
    assert.equal(mcp.calls(), 1);
    assert.equal(model.requests.length, 1);
    assert.deepEqual(await get(api('/session/status')), {});
  } finally {
    await bridge?.stop();
    for (const { server } of [mcp, model]) { server.closeAllConnections(); server.close(); }
    rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test('Pi compaction refreshes and persists the current ShadowBot runtime context', { timeout: 30_000 }, async () => {
  const fixture = tempFixture();
  const trigger = 'force-compaction ';
  const model = modelFixture({ usageFor: content => content.includes(trigger) ? 26_000 : 9 });
  const modelURL = await listen(model.server);
  let reads = 0;
  const host = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: `host-runtime-context-${++reads}` }));
  });
  const hostURL = await listen(host);
  const config = { model: 'fixture/model', provider: { fixture: { npm: '@ai-sdk/openai-compatible',
    options: { baseURL: modelURL, apiKey: 'fixture-key' }, models: { model: { name: 'Fixture', limit: { context: 32_768, output: 4096 } } } } } };
  let bridge;
  try {
    const env = { SHADOWBOT_OPENCODE_RUNTIME_CONTEXT_URL: hostURL };
    bridge = await start(fixture, config, env);
    const session = await get(bridge.api('/session', { method: 'POST' }));
    const prompt = text => get(bridge.api(`/session/${session.id}/message`, { method: 'POST', data: { parts: [{ type: 'text', text }] } }));
    await prompt('Original conversation history');
    assert.match(JSON.stringify(model.requests[0].request.messages), /host-runtime-context-1/);
    await prompt(trigger + 'x '.repeat(45_000));
    assert.equal(reads, 3);
    assert.ok(model.requests.length >= 3, 'A separate summary request should have completed');
    const db = new DatabaseSync(join(fixture.home, 'backends', 'pi', 'adapter.db'), { readOnly: true });
    let file;
    try { file = db.prepare('SELECT pi_file FROM session WHERE id=?').get(session.id).pi_file; }
    finally { db.close(); }
    const entries = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
    const compaction = entries.findLast(entry => entry.type === 'compaction');
    const snapshot = entries.findLast(entry => entry.type === 'custom' && entry.customType === 'shadowbot-runtime-context');
    assert.equal(snapshot.data.compactionID, compaction.id);
    assert.match(snapshot.data.instructions, /host-runtime-context-3/);
    await bridge.stop();
    const relocated = join(fixture.root, 'project-local');
    renameSync(fixture.home, relocated);
    const installPath = join(relocated, 'install.json');
    const install = JSON.parse(readFileSync(installPath, 'utf8'));
    install.database = join(relocated, 'opencode.db');
    writeFileSync(installPath, JSON.stringify(install));
    bridge = await start({ ...fixture, home: relocated }, config, env);
    await prompt('Continue after compaction and migration');
    const request = JSON.stringify(model.requests.at(-1).request.messages);
    assert.match(request, /host-runtime-context-4/);
    assert.doesNotMatch(request, /host-runtime-context-[123]/);
  } finally {
    await bridge?.stop();
    for (const server of [model.server, host]) { server.closeAllConnections(); server.close(); }
    rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test('the recorded host turn preserves part IDs, snapshot metadata and the catalog model', { timeout: 20_000 }, async () => {
  const fixture = tempFixture();
  const model = modelFixture();
  const modelURL = await listen(model.server);
  const runtime = createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' })
    .end(JSON.stringify({ data: 'current workspace context' })));
  const contextURL = await listen(runtime);
  let bridge;
  try {
    bridge = await start(fixture, {
      model: 'deepseek/deepseek-flash', provider: { deepseek: { options: { apiKey: 'fixture-deepseek-key', baseURL: modelURL } } },
      agent: { 'shadowbot-copilot': { model: 'deepseek/deepseek-flash', top_p: 0.9, permission: { task: { '*': 'deny', 'shadowbot-explorer': 'allow' } } } },
      command: { review: { template: 'Review this item: $ARGUMENTS' } },
    }, { SHADOWBOT_OPENCODE_RUNTIME_CONTEXT_URL: contextURL, SHADOWBOT_OPENCODE_WORKSPACE_ROOT: fixture.workspace });
    const { api } = bridge;
    const providers = await get(api('/provider'));
    const deepseek = providers.all.find(provider => provider.id === 'deepseek');
    assert.equal(providers.default.deepseek, 'deepseek-flash');
    assert.equal(deepseek.models['deepseek-flash'].api.url, modelURL);
    assert.equal(deepseek.models['deepseek-flash'].capabilities.input.text, true);
    assert.ok(deepseek.models['deepseek-flash'].limit.context > 0);
    assert.equal(deepseek.options.apiKey, undefined);
    const [agent] = await get(api('/agent'));
    assert.deepEqual(agent.model, { providerID: 'deepseek', modelID: 'deepseek-flash' });
    assert.equal(agent.topP, 0.9);
    assert.deepEqual(agent.permission, [
      { permission: 'task', pattern: '*', action: 'deny' }, { permission: 'task', pattern: 'shadowbot-explorer', action: 'allow' },
    ]);
    assert.equal((await get(api('/command')))[0].template, 'Review this item: $ARGUMENTS');
    await get(api('/unsupported-fixture-route'), 501);
    const session = await get(api('/session', { method: 'POST', data: { title: 'Recorded host sequence' } }));
    const messageID = 'msg_hostfixture';
    const textPart = { id: 'prt_hostfixture', type: 'text', text: 'Reply with OK', metadata: { xbotTurn: { pending: true } } };
    const context = { id: 'prt_hostcontext', type: 'text', text: 'stale submitted runtime context',
      metadata: { xbotPartKind: 'runtime_context', xbotVisible: false } };
    const result = await get(api(`/session/${session.id}/message`, { method: 'POST', data: {
      agent: 'shadowbot-copilot', messageID, model: { providerID: 'deepseek', modelID: 'deepseek-flash' },
      system: 'Fixture system instructions', parts: [context, textPart],
    } }));
    assert.equal(result.info.modelID, 'deepseek-flash');
    assert.equal(model.requests[0].request.model, 'deepseek-flash');
    assert.equal(model.requests[0].authorization, 'Bearer fixture-deepseek-key');
    assert.match(JSON.stringify(model.requests[0].request.messages), /current workspace context/);
    assert.doesNotMatch(JSON.stringify(model.requests[0].request.messages), /stale submitted runtime context/);
    const patch = { ...textPart, sessionID: session.id, messageID, metadata: { xbotTurn: { outcome: 'completed' } } };
    const url = `/session/${session.id}/message/${messageID}/part/${textPart.id}`;
    assert.deepEqual(await get(api(url, { method: 'PATCH', data: patch })), patch);
    const persisted = await get(api(`/session/${session.id}/message/${messageID}`));
    assert.equal(persisted.parts.find(part => part.id === context.id).metadata.xbotVisible, false);
    assert.deepEqual(persisted.parts.find(part => part.id === textPart.id), patch);
    assert.equal(model.requests.length, 1);
    await get(api(`/session/${session.id}/command`, { method: 'POST', data: { command: 'review', arguments: 'fixture argument' } }));
    assert.match(JSON.stringify(model.requests.at(-1).request.messages), /Review this item: fixture argument/);
  } finally {
    await bridge?.stop();
    for (const server of [model.server, runtime]) { server.closeAllConnections(); server.close(); }
    rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test('file access uses the workspace and keeps external grants scoped to one directory', { timeout: 25_000 }, async () => {
  const fixture = tempFixture();
  const unrelated = join(fixture.root, 'third-workspace');
  mkdirSync(unrelated);
  writeFileSync(join(fixture.workspace, 'local.txt'), 'local fixture text');
  writeFileSync(join(fixture.other, 'external.txt'), 'approved fixture text');
  writeFileSync(join(fixture.other, 'same-directory.txt'), 'same directory fixture text');
  writeFileSync(join(unrelated, 'unrelated.txt'), 'unrelated fixture text');
  symlinkSync(fixture.other, join(fixture.workspace, 'linked-workspace'), process.platform === 'win32' ? 'junction' : 'dir');
  const inputs = new Map([
    ['local read', 'local.txt'], ['linked read', 'linked-workspace/external.txt'],
    ['approved directory read', join(fixture.other, 'same-directory.txt')], ['unrelated read', join(unrelated, 'unrelated.txt')],
  ]);
  const model = modelFixture({ readPathFor: content => [...inputs].find(([label]) => content.includes(label))?.[1] });
  const modelURL = await listen(model.server);
  let bridge;
  let events;
  try {
    bridge = await start(fixture, { model: 'fixture/model', provider: { fixture: { npm: '@ai-sdk/openai-compatible',
      options: { baseURL: modelURL, apiKey: 'fixture-key' }, models: { model: { name: 'Fixture' } } } },
    agent: { 'shadowbot-copilot': { permission: { '*': 'deny', read: 'allow', external_directory: 'ask' } } } });
    const { api } = bridge;
    const session = await get(api('/session', { method: 'POST' }));
    const message = text => api(`/session/${session.id}/message`, { method: 'POST', data: { parts: [{ type: 'text', text }] } });
    await get(api(`/session/${session.id}/message`, { method: 'POST', data: { parts: [{ type: 'file', mime: 'image/png',
      url: pathToFileURL(join(fixture.workspace, 'linked-workspace', 'external.txt')).href }] } }), 400);
    assert.equal(model.requests.length, 0);
    events = await stream(api);
    await events.until(event => event.type === 'server.connected');
    await get(message('local read'));
    assert.match(JSON.stringify(model.requests.at(-1).request.messages), /local fixture text/);

    const linked = message('linked read');
    const asked = (await events.until(event => event.type === 'permission.asked')).properties;
    const directory = realpathSync.native(fixture.other);
    assert.equal(asked.permission, 'external_directory');
    assert.deepEqual(asked.patterns, [join(directory, '*')]);
    assert.equal(asked.metadata.filepath, join(directory, 'external.txt'));
    await get(api(`/permission/${asked.id}/reply`, { method: 'POST', data: { reply: 'always' } }));
    await get(linked);
    assert.match(JSON.stringify(model.requests.at(-1).request.messages), /approved fixture text/);

    await get(message('approved directory read'));
    assert.match(JSON.stringify(model.requests.at(-1).request.messages), /same directory fixture text/);
    const rejected = message('unrelated read');
    const separate = (await events.until(event => event.type === 'permission.asked')).properties;
    assert.deepEqual(separate.patterns, [join(realpathSync.native(unrelated), '*')]);
    await get(api(`/permission/${separate.id}/reply`, { method: 'POST', data: { reply: 'reject' } }));
    await get(rejected);
    const transcript = JSON.stringify(model.requests.at(-1).request.messages);
    assert.match(transcript, /Access outside the workspace was declined/);
    assert.doesNotMatch(transcript, /unrelated fixture text/);
  } finally {
    await events?.close().catch(() => undefined);
    await bridge?.stop();
    model.server.closeAllConnections();
    model.server.close();
    rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test('ShadowBot rollback accepts assistant targets and repeated removal of a turn', { timeout: 20_000 }, async () => {
  const fixture = tempFixture();
  const model = modelFixture();
  const studio = mcpFixture('flow_blocks_list', { extraTools: ['app_save', 'flow_export'] });
  const modelURL = await listen(model.server);
  const studioURL = await listen(studio.server);
  let bridge;
  let events;
  try {
    bridge = await start(fixture, { model: 'fixture/model', provider: { fixture: { npm: '@ai-sdk/openai-compatible',
      options: { baseURL: modelURL, apiKey: 'fixture-key' }, models: { model: { name: 'Fixture' } } } },
    permission: { '*': 'deny', 'studio-mcp_flow_blocks_list': 'allow', 'studio-mcp_flow_export': { 'approved-folder/*': 'allow' } } });
    const { api } = bridge;
    await get(api('/mcp', { method: 'POST', data: { name: 'studio-mcp', config: { type: 'remote', url: studioURL } } }));
    const session = await get(api('/session', { method: 'POST' }));
    const path = `/session/${session.id}`;
    const send = text => get(api(`${path}/message`, { method: 'POST', data: { parts: [{ type: 'text', text }] } }));
    const messages = () => get(api(`${path}/message`));
    const remove = (message, status = 200) => get(api(`${path}/message/${message}`, { method: 'DELETE' }), status);
    await send('Keep this turn');
    await send('probe-tool in the turn to remove');
    assert.equal(studio.calls(), 1);
    const tools = model.requests.at(-1).request.tools.map(tool => tool.function.name);
    assert.ok(tools.includes('studio-mcp_flow_export'));
    assert.ok(!tools.includes('studio-mcp_app_save'));
    const before = await messages();
    const [firstUser, firstReply, targetUser, targetToolReply, targetFinalReply] = before.map(item => item.info.id);
    assert.equal(before.length, 5);

    const reverted = await get(api(`${path}/revert`, { method: 'POST', data: { messageID: targetFinalReply } }));
    assert.equal(reverted.revert.messageID, targetUser);
    assert.deepEqual((await messages()).map(item => item.info.id), [firstUser, firstReply]);
    await get(api(`${path}/unrevert`, { method: 'POST' }));
    assert.deepEqual(await messages(), before);

    events = await stream(api);
    await events.until(event => event.type === 'server.connected');
    assert.equal(await remove(targetFinalReply), true);
    assert.equal((await events.until(event => event.type === 'message.removed')).properties.messageID, targetFinalReply);
    assert.deepEqual((await messages()).map(item => item.info.id), [firstUser, firstReply, targetUser, targetToolReply]);
    assert.equal(await remove(targetUser), true);
    assert.equal(await remove(targetToolReply), true);
    assert.equal(await remove(targetFinalReply), true);
    await remove('msg_nonexistent', 404);
    assert.deepEqual((await messages()).map(item => item.info.id), [firstUser, firstReply]);
    await send('Continue the retained conversation');
    const continuation = JSON.stringify(model.requests.at(-1).request.messages);
    assert.match(continuation, /Keep this turn/);
    assert.doesNotMatch(continuation, /probe-tool|MCP fixture output/);
    assert.equal(studio.calls(), 1);
  } finally {
    await events?.close().catch(() => undefined);
    await bridge?.stop();
    for (const { server } of [model, studio]) { server.closeAllConnections(); server.close(); }
    rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
