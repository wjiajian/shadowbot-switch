import assert from 'node:assert/strict';
import { mkdirSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { admitParts, buildInstructions, parsePromptContent, promptAgent } from '../dist/service/host/prompt.js';
import { ShadowBotContext } from '../dist/service/shadowbot.js';
import { storeFixture, tempDirectory } from './helpers/store.mjs';

test('admission distinguishes malformed, duplicated and already persisted IDs', t => {
  const { store, session } = storeFixture(t);
  const part = { id: 'prt_123456', type: 'text', text: 'hello' };
  const prompt = { messageID: 'msg_123456', parts: [part] };
  const admit = overrides => admitParts(store, session, { ...prompt, ...overrides });
  for (const invalid of [{ parts: [] }, { messageID: 'bad' }, { parts: [null] }, { parts: [{ ...part, id: 'bad' }] },
    { parts: [part, part] }]) assert.throws(() => admit(invalid), { status: 400 });
  const { messageID, parts } = admit({});
  assert.deepEqual(parts, [{ ...part, sessionID: session.id, messageID }]);
  store.putMessage({ id: messageID, role: 'user', sessionID: session.id, model: {}, time: { created: 1 } });
  store.putPart(parts[0]);
  assert.throws(() => admit({}), { status: 409, message: 'The prompt message was already admitted' });
  assert.throws(() => admit({ messageID: undefined }), { status: 409, message: 'The prompt part was already admitted' });
});

test('image attachments preserve MIME, workspace and size checks', t => {
  const dir = tempDirectory(t);
  const root = join(dir, 'workspace');
  mkdirSync(root);
  const parse = url => parsePromptContent({ parts: [{ type: 'file', mime: 'image/png', url }] }, root, false);
  const image = { type: 'image', data: 'YWJj', mimeType: 'image/png' };
  assert.deepEqual(parse('data:image/png;base64,YWJj').images, [image]);
  assert.throws(() => parse('data:image/jpeg;base64,YWJj'), { status: 400, message: 'Unsupported attachment URL' });
  for (const base of [root, dir]) writeFileSync(join(base, 'file'), 'abc');
  for (const [base, tooLarge] of [[dir, false], [root, true]]) {
    const path = join(base, 'file');
    if (tooLarge) {
      assert.deepEqual(parse(pathToFileURL(path).href).images, [image]);
      truncateSync(path, 8 * 1024 * 1024 + 1);
    }
    assert.throws(() => parse(pathToFileURL(path).href), { status: 400, message: 'Image attachment is outside the workspace or too large' });
  }
  assert.throws(() => parse('data:image/png;base64,' + 'A'.repeat(12 * 1024 * 1024 + 1)), { status: 400, message: 'Image attachment is too large' });
});

test('only model-bound inline runtime parts with a configured URL are omitted', () => {
  for (const noReply of [true, false]) for (const configured of [true, false]) for (const kind of ['runtime_context', 'other']) {
    const prompt = { noReply, parts: [{ type: 'text', text: 'host', metadata: { xbotPartKind: kind } }] };
    const parse = () => parsePromptContent(prompt, '.', configured);
    if (!noReply && configured && kind === 'runtime_context') assert.throws(parse, { status: 400, message: 'The prompt is empty' });
    else assert.equal(parse().text, 'host');
  }
});

test('runtime-part admission observes changes to the configured environment between turns', t => {
  const key = 'SHADOWBOT_OPENCODE_RUNTIME_CONTEXT_URL';
  const saved = process.env[key];
  t.after(() => { if (saved === undefined) delete process.env[key]; else process.env[key] = saved; });
  delete process.env[key];
  const context = new ShadowBotContext();
  assert.equal(context.hasRuntimeContext, false);
  process.env[key] = 'http://localhost/runtime';
  assert.equal(context.hasRuntimeContext, true);
});

test('role admission and static instructions retain their order and omit empty sections', () => {
  const agent = promptAgent({}, {});
  assert.equal(agent, 'shadowbot-copilot');
  assert.equal(promptAgent({ parentID: 'parent' }, {}), 'shadowbot-explorer');
  assert.throws(() => promptAgent({ parentID: 'parent' }, { agent }), { status: 400 });
  assert.throws(() => promptAgent({}, { agent: 'shadowbot-explorer' }), { status: 400 });
  const input = { config: { agent: { [agent]: { prompt: 'role' } } }, agent, root: '.', resources: 'res',
    rules: 'AGENTS', system: 'system', skills: [{ name: 'one', description: 'first' }] };
  const reference = 'ShadowBot reference directory: ' + join('res', 'Copilot', 'knowledge');
  assert.deepEqual(buildInstructions(input), ['role', 'AGENTS', 'system', reference, 'Available skills. Use the skill tool to read their instructions.\none: first']);
  assert.deepEqual(buildInstructions({ ...input, config: {}, rules: '', system: undefined, skills: [] }), [reference]);
});
