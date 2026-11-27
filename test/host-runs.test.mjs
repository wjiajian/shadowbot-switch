import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { createHostRuns } from '../dist/service/host/runs.js';
import { storeFixture } from './helpers/store.mjs';

function step(recorder, error) {
  recorder.finishStep({ segments: [{ index: 0, kind: 'text', text: 'reply' }],
    cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, finish: error ? 'error' : 'stop', error });
}

class MockDriver {
  displayName = 'Mock';
  logPrefix = 'ShadowBotMock';
  fallbackError = 'Mock request failed';
  aborted = [];
  async resolveModel() { return { selection: { modelID: 'model', providerID: 'provider' }, handle: {} }; }
  async abort(id) { this.aborted.push(id); }
  async runTurn(turn) { step(turn.recorder); }
}

function fixture(t, driver = new MockDriver()) {
  const frames = [];
  const { store, root, session } = storeFixture(t, frame => frames.push(frame));
  const empty = join(root, 'missing');
  const ctx = { store, root, resources: root, home: root, config: { value: {} }, mcp: {},
    skillSources: { bridge: empty, resources: empty, cache: empty }, context: {
      hasRuntimeContext: false, instructions: async () => 'runtime', overlay: async () => {}, finalizedEvidence: async () => {},
    } };
  const runs = createHostRuns(ctx, driver);
  frames.length = 0;
  const send = (text = 'hello', extra = {}) => runs.start(session, { parts: [{ type: 'text', text }], ...extra }, { instructions: 'rules' });
  return { frames, session, store, driver, runs, send, ctx };
}

test('a driver without thinking support receives /thinking as a normal turn', async t => {
  const { driver, runs, send, session, frames } = fixture(t);
  assert.ok(runs.start.length >= 3);
  assert.throws(() => runs.start(session, {}, { instructions: '' }), { status: 400 });
  driver.runTurn = async turn => {
    assert.equal(turn.text, '/thinking high');
    assert.equal(turn.runtimeContext, 'runtime');
    assert.equal(turn.instructions[0], 'rules');
    step(turn.recorder);
  };
  const reply = await send('/thinking high');
  assert.equal(reply.parts.find(part => part.type === 'text').text, 'reply');
  assert.deepEqual(frames.map(f => f.type), ['session.status', 'message.updated', 'message.part.updated', 'message.updated',
    'message.updated', 'message.part.updated', 'message.part.updated', 'message.part.updated', 'message.part.updated',
    'message.updated', 'session.updated', 'session.status', 'session.idle']);
});

test('noReply without native history persists the user, releases the lease and emits idle', async t => {
  const { driver, session, store, frames, send } = fixture(t);
  driver.resolveModel = async () => assert.fail('noReply resolved a model');
  const reply = await send('saved', { noReply: true });
  assert.equal(reply.info.role, 'user');
  assert.deepEqual(store.message(session.id, reply.info.id), reply);
  assert.equal(store.meta(session.id).running, 0);
  assert.deepEqual(frames.map(f => f.type), ['session.status', 'message.updated', 'message.part.updated', 'session.updated', 'session.status', 'session.idle']);
});

test('driver, HTTP, translation, refresh and database errors use the shared finish order', async t => {
  const { driver, send, frames, ctx } = fixture(t);
  ctx.context.instructions = async (_explorer, _signal, refresh) => { if (refresh) throw new Error(); return ''; };
  for (const [operation, message] of [
    [async () => { throw new Error('raw provider body'); }, driver.fallbackError],
    [async turn => step(turn.recorder, { message: 'model error', aborted: false }), 'model error'],
    [async turn => { turn.translationFailed(new Error()); turn.abort(); }, driver.fallbackError],
    [async turn => { await turn.refreshRuntimeContext(); }, /Mock compacted the conversation/],
    [async () => { throw Object.assign(new Error(), { code: 'ERR_SQLITE_ERROR', errcode: 5 }); }, /database became busy/],
    [async turn => { turn.markUncertain('write'); throw new Error(); }, /MCP tool write did not confirm its outcome/],
  ]) {
    frames.length = 0;
    driver.runTurn = operation;
    const reply = await send();
    const error = reply.info.error.data.message;
    if (typeof message === 'string') assert.equal(error, message); else assert.match(error, message);
    assert.deepEqual(frames.slice(-5).map(f => f.type), ['message.updated', 'session.error', 'session.updated', 'session.status', 'session.idle']);
  }
});

test('compaction propagates SQLite busy after claiming the session and releases the lease', async t => {
  const { driver, runs, session, store, frames } = fixture(t);
  const busy = Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
  driver.summarize = async () => { throw busy; };
  await assert.rejects(runs.summarize(session, { providerID: 'fixture', modelID: 'model' }), error => error === busy);
  assert.equal(frames.some(frame => frame.type === 'session.error'), false);
  assert.equal(runs.active.size, 0);
  assert.equal(store.meta(session.id).running, 0);
});

test('explicit cancellation takes priority over an uncertain tool', async t => {
  const { driver, session, runs, send } = fixture(t);
  const entered = Promise.withResolvers();
  driver.runTurn = async turn => {
    entered.resolve();
    await new Promise(resolve => turn.signal.addEventListener('abort', resolve, { once: true }));
    turn.markUncertain('write');
  };
  const reply = send();
  await entered.promise;
  assert.throws(() => send(), { status: 409 });
  assert.equal(await runs.abort(session.id), true);
  assert.match((await reply).info.error.data.message, /Chat cancelled/);
  assert.equal(runs.active.size, 0);
});

test('Explorer shares the parent task reference and rules while the child asks for permission', async t => {
  const { driver, frames, session, runs, send } = fixture(t);
  const asked = Promise.withResolvers();
  driver.runTurn = async turn => {
    if (turn.session.parentID) {
      assert.equal(turn.session.parentID, session.id);
      assert.equal(turn.instructions[0], 'rules');
      const decision = turn.authorize('child-call', 'custom', {});
      asked.resolve();
      assert.deepEqual(await decision, { allow: true });
    } else {
      turn.recorder.begin();
      turn.recorder.toolRunning('parent-task', 'task', {});
      await turn.hostTools.find(tool => tool.name === 'task').execute('parent-task', { prompt: 'inspect', subagent_type: 'explore' });
    }
    step(turn.recorder);
  };
  const reply = send();
  await asked.promise;
  const frame = frames.find(f => f.type === 'permission.asked');
  assert.equal(frame.properties.sessionID, session.id);
  assert.equal(frame.properties.tool.callID, 'parent-task');
  assert.equal(runs.interactions.permissionReply(frame.properties.id, 'always', () => true), true);
  assert.equal((await reply).info.finish, 'stop');
});

test('thinking command registration honors installed capabilities and legacy Pi manifests', async () => {
  const { thinkingEnabled } = await import('../dist/service/thinking-command.js');
  const caps = { skills: true, mcp: true };
  assert.equal(thinkingEnabled('pi', {}, caps), true);
  assert.equal(thinkingEnabled('mock', {}, caps), false);
  assert.equal(thinkingEnabled('mock', {}, { ...caps, thinking: true }), true);
  assert.equal(thinkingEnabled('mock', { command: { thinking: {} } }, { ...caps, thinking: true }), false);
});

test('disabling the installation thinking command delivers slash text to a capable driver', async t => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { driver, ctx, send } = fixture(t);
  driver.thinking = { supportedLevels: () => ['high'], baseline: () => assert.fail('disabled local command ran') };
  mkdirSync(join(ctx.home, 'agent'), { recursive: true });
  writeFileSync(join(ctx.home, 'agent', 'shadowbot.json'), '{"thinkingCommand":false}');
  driver.runTurn = async turn => { assert.equal(turn.text, '/thinking high'); step(turn.recorder); };
  assert.equal((await send('/thinking high')).info.finish, 'stop');
});
