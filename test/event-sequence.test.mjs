import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { get, listen, modelFixture, start, stream, tempFixture } from './helpers/bridge.mjs';

const golden = {
  plain: [
    'session.status busy', 'message.updated user', 'message.part.updated text', 'message.updated user',
    'message.updated assistant', 'message.part.updated step-start', 'message.part.updated text',
    'message.part.delta', 'message.part.delta', 'message.part.updated text', 'message.part.updated step-finish',
    'message.updated assistant stop', 'session.updated', 'session.status idle', 'session.idle',
  ],
  read: [
    'session.status busy', 'message.updated user', 'message.part.updated text', 'message.updated user',
    'message.updated assistant', 'message.part.updated step-start', 'message.part.updated step-finish',
    'message.updated assistant tool-calls', 'message.part.updated tool running',
    'message.part.updated tool completed', 'message.updated assistant', 'message.part.updated step-start',
    'message.part.updated text', 'message.part.delta', 'message.part.delta', 'message.part.updated text',
    'message.part.updated step-finish', 'message.updated assistant stop', 'session.updated',
    'session.status idle', 'session.idle',
  ],
  modelError: [
    'session.status busy', 'message.updated user', 'message.part.updated text', 'message.updated user',
    'message.updated assistant', 'message.part.updated step-start', 'message.part.updated step-finish',
    'message.updated assistant error UnknownError', 'message.updated assistant error UnknownError',
    'session.error UnknownError', 'session.updated', 'session.status idle', 'session.idle',
  ],
  abort: [
    'session.status busy', 'message.updated user', 'message.part.updated text', 'message.updated user',
    'message.updated assistant', 'message.part.updated step-start', 'message.part.updated text',
    'message.part.delta', 'message.part.updated text', 'message.part.updated step-finish',
    'message.updated assistant aborted MessageAbortedError',
    'message.updated assistant error MessageAbortedError', 'session.error MessageAbortedError', 'session.updated',
    'session.status idle', 'session.idle',
  ],
  question: [
    'session.status busy', 'message.updated user', 'message.part.updated text', 'message.updated user',
    'message.updated assistant', 'message.part.updated step-start', 'message.part.updated step-finish',
    'message.updated assistant tool-calls', 'message.part.updated tool running', 'question.asked',
    'question.replied', 'message.part.updated tool completed', 'message.updated assistant',
    'message.part.updated step-start', 'message.part.updated text', 'message.part.delta', 'message.part.delta',
    'message.part.updated text', 'message.part.updated step-finish', 'message.updated assistant stop',
    'session.updated', 'session.status idle', 'session.idle',
  ],
  revert: [
    'session.updated', 'session.updated',
  ],
  deleteMessage: [
    'message.removed', 'session.updated',
  ],
  recover: [
    'message.updated assistant error MessageAbortedError', 'session.error MessageAbortedError',
    'session.status idle', 'session.idle',
  ],
};

function signature({ type, properties: p }) {
  return [type, p.status?.type, p.part?.type, p.part?.state?.status, p.info?.role,
    p.info?.finish, p.info?.error?.name, p.error?.name].filter(Boolean).join(' ');
}

test('OpenCode SSE event sequences for model turns, tools, history and crash recovery', { timeout: 30_000 }, async () => {
  const fixture = tempFixture();
  writeFileSync(join(fixture.workspace, 'read.txt'), 'fixture');
  const model = modelFixture({ readPathFor: content => content.includes('probe-read') ? 'read.txt' : undefined,
    beforeReply(content, res) {
      if (content.includes('model-error')) { res.writeHead(401).end('invalid key'); return true; }
      if (content.includes('hold-stream')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'model',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'partial' }, finish_reason: null }] }) + '\n\n');
        return true;
      }
    } });
  const baseURL = await listen(model.server);
  const config = { model: 'fixture/model', provider: { fixture: { npm: '@ai-sdk/openai-compatible',
    options: { baseURL, apiKey: 'fixture' }, models: { model: {} } } }, agent: { 'shadowbot-copilot': { permission: { read: 'allow' } } } };
  let bridge, events;
  try {
    bridge = await start(fixture, config);
    const session = await get(bridge.api('/session', { method: 'POST' }));
    const path = '/session/' + session.id;
    const post = (target, data) => bridge.api(target, { method: 'POST', data });
    const prompt = text => get(post(path + '/prompt_async', { parts: [{ type: 'text', text }] }), 204);
    const connect = async () => { events = await stream(bridge.api); await until('server.connected'); events.history.length = 0; };
    const until = type => events.until(e => e.type === type);
    const sequence = label => {
      const frames = events.history.splice(0).map(signature);
      assert.deepEqual(frames, golden[label], label);
    };
    await connect();
    for (const [label, text] of [['plain', 'hello'], ['read', 'probe-read'], ['modelError', 'model-error'],
      ['abort', 'hold-stream'], ['question', 'probe-question']]) {
      await prompt(text);
      if (label === 'abort') { await until('message.part.delta'); await get(post(path + '/abort')); }
      if (label === 'question') {
        const question = await until('question.asked');
        await get(post('/question/' + question.properties.id + '/reply', { answers: [['Yes']] }));
      }
      await until('session.idle');
      sequence(label);
    }
    const history = await get(bridge.api(path + '/message'));
    const messageID = history.at(-1).info.id;
    await get(post(path + '/revert', { messageID }));
    await until('session.updated');
    await get(post(path + '/unrevert'));
    await until('session.updated');
    sequence('revert');
    await get(bridge.api(path + '/message/' + messageID, { method: 'DELETE' }));
    await until('session.updated');
    sequence('deleteMessage');
    await prompt('hold-stream');
    await until('message.part.delta');
    await events.close();
    process.kill(bridge.pid, 'SIGKILL');
    await bridge.stop();
    bridge = await start(fixture, config);
    await connect();
    await get(bridge.api('/session/status'));
    await until('session.idle');
    sequence('recover');
  } finally {
    await events?.close().catch(() => {});
    await bridge?.stop();
    model.server.closeAllConnections();
    model.server.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
