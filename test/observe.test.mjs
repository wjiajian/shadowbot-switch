import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { json } from 'node:stream/consumers';
import assert from 'node:assert/strict';
import test from 'node:test';
import { originalHash } from '../dist/service/installation.js';

test('observe forwards HTTP and SSE and stores shapes only', {
  skip: process.env.SHADOWBOT_TEST_OBSERVE !== '1', timeout: 30_000,
}, async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'shadowbot-pi-observe-'));
  const launcher = join(fixture, 'opencode.exe');
  const home = join(fixture, 'install');
  const original = join(home, 'original');
  const profile = join(fixture, 'profile');
  const traces = join(home, 'observations');
  mkdirSync(original, { recursive: true });
  mkdirSync(profile);
  copyFileSync(resolve('dist/opencode.exe'), launcher);
  copyFileSync(resolve('.shadowbot-switch/original/opencode.exe'), join(original, 'opencode.exe'));
  writeFileSync(`${launcher}.shadowbot-pi.json`, JSON.stringify({ home }));
  writeFileSync(join(home, 'install.json'), JSON.stringify({ agentPath: launcher, originalHash }));
  writeFileSync(join(home, 'backend.json'), JSON.stringify({ mode: 'observe' }));
  const password = 'fixture-basic-secret';
  const title = 'fixture-message-content';
  const prompt = 'fixture-prompt-content';
  const auth = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` };
  let modelRequests = 0;
  const model = createServer(async (req, res) => {
    const payload = await json(req);
    modelRequests++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [delta, finish_reason] of [[{ role: 'assistant', content: 'fixture reply' }, null], [{}, 'stop']]) {
      res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1,
        model: payload.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    }
    res.end('data: [DONE]\n\n');
  });
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
  const config = { model: 'fixture/model', provider: { fixture: { npm: '@ai-sdk/openai-compatible',
    options: { baseURL: `http://127.0.0.1:${model.address().port}`, apiKey: 'fixture-provider-key' }, models: { model: { name: 'Fixture' } } } } };
  const child = spawn(launcher, ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
    cwd: fixture, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      USERPROFILE: profile, HOME: profile, LOCALAPPDATA: profile, APPDATA: profile,
      XDG_DATA_HOME: join(fixture, 'data'), XDG_CONFIG_HOME: join(fixture, 'config'),
      XDG_CACHE_HOME: join(fixture, 'cache'), XDG_STATE_HOME: join(fixture, 'state'),
      OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_SERVER_PASSWORD: password,
    },
  });
  const closed = once(child, 'close');
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const lines = createInterface({ input: child.stdout });
  const ready = new Promise((resolve, reject) => {
    lines.on('line', line => {
      const match = line.match(/^opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) resolve(match[1]);
    });
    closed.then(([code]) => reject(new Error(`Launcher exited with ${code}: ${stderr}`)), reject);
  });
  try {
    const url = await Promise.race([ready, new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Observe readiness timeout: ${stderr}`)), 20_000).unref();
    })]);
    assert.equal((await fetch(`${url}/global/health`)).status, 401);
    const health = await fetch(`${url}/global/health`, { headers: auth });
    assert.deepEqual(await health.json(), { healthy: true, version: '1.18.12' });
    const response = await fetch(`${url}/session`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ title }),
    });
    assert.equal(response.status, 200);
    const session = await response.json();
    assert.equal(session.title, title);
    const stream = await fetch(`${url}/event`, { headers: auth, signal: AbortSignal.timeout(20_000) });
    assert.match(stream.headers.get('content-type'), /^text\/event-stream/);
    const reader = stream.body.getReader();
    let payload = '';
    while (!payload.includes('server.connected')) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      payload += Buffer.from(chunk.value).toString('utf8');
    }
    const accepted = await fetch(`${url}/session/${session.id}/prompt_async`, { method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ parts: [{ type: 'text', text: prompt }] }) });
    assert.equal(accepted.status, 204);
    while (!payload.includes('session.idle')) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      payload += Buffer.from(chunk.value).toString('utf8');
    }
    assert.ok(modelRequests > 0, payload.slice(-3000));
    await reader.cancel();
    const [file] = readdirSync(traces);
    const trace = readFileSync(join(traces, file), 'utf8');
    for (const secret of [password, auth.authorization, title, prompt, 'fixture reply', 'fixture-provider-key', session.id, fixture]) assert.equal(trace.includes(secret), false);
    assert.match(trace, /"type":"server.connected"/);
    assert.match(trace, /"shape":\{"title":"string"\}/);
  } finally {
    child.kill();
    await closed;
    model.closeAllConnections();
    model.close();
    lines.close();
    rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
