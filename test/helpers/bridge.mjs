import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { json as readJsonBody } from 'node:stream/consumers';
import assert from 'node:assert/strict';

export const schema = readFileSync('contract/schema.sql', 'utf8');

export async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

export function modelFixture({ usageFor = () => 9, beforeReply, readPathFor } = {}) {
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
      const skillName = content.includes('probe-stock-skill') ? 'fixture-stock-allowed' :
        content.includes('probe-skill') ? content.match(/probe-skill ([a-z-]+)/)?.[1] ?? 'fixture-skill' : undefined;
      const requestedTool = readPath ? 'read' : content.includes('probe-tool') ? 'studio-mcp_flow_blocks_list' :
        content.includes('probe-write') ? 'studio-mcp_flow_edit' :
        content.includes('probe-question') ? 'question' :
        skillName ? 'skill' :
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
          requestedTool === 'skill' ? { name: skillName } :
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

export function mcpFixture(name, { beforeInitialize, dropToolResponse = false, extraTools = [] } = {}) {
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

export function tempFixture(runtimeRelease, bundled) {
  const root = mkdtempSync(join(tmpdir(), 'shadowbot-pi-bridge-'));
  const home = join(root, 'home');
  const runtime = runtimeRelease ? join(home, 'harnesses', 'pi', 'releases', runtimeRelease) : home;
  const database = join(home, 'opencode.db');
  const workspace = join(root, 'project');
  const other = join(root, 'other');
  const users = join(root, 'users');
  for (const dir of [runtime, workspace, other, users]) mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(database);
  db.exec(schema);
  db.close();
  writeFileSync(join(runtime, 'schema.sql'), schema);
  writeFileSync(join(home, 'install.json'), JSON.stringify({ database, users, resources: root, bundled,
    runtimeRelease, piVersion: runtimeRelease ? '1.5.2' : undefined }));
  writeFileSync(join(home, 'backend.json'), '{"mode":"pi"}');
  return { root, home, runtime, database, workspace, other };
}

export async function start(fixture, config, extraEnv = {}) {
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

export async function stream(api) {
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

export async function get(response, expected = 200) {
  const actual = await response;
  const text = await actual.text();
  assert.equal(actual.status, expected, text);
  return text ? JSON.parse(text) : undefined;
}
