import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionHistory } from '../dist/service/host/history.js';
import { storeFixture } from './helpers/store.mjs';

function fixture(t, hasNative = true) {
  const { root, store, session } = storeFixture(t);
  const events = [];
  const native = { repairInterrupted() {}, parentOf: (_meta, entry) => { events.push(entry); return null; },
    prepareDelete: meta => {
      assert.ok(store.get(meta.id));
      events.push('prepare ' + meta.id);
      return () => { assert.equal(store.get(meta.id), undefined); events.push('cleanup ' + meta.id); };
    } };
  const history = new SessionHistory({ store, root, displayName: 'Mock', logPrefix: 'Host', isActive: () => false,
    native: hasNative ? native : undefined, interactions: { clearGrants: id => {
      assert.equal(store.get(id), undefined); events.push('clear ' + id);
    } } });
  const user = id => ({ id, sessionID: session.id, role: 'user', model: {}, time: { created: 1 } });
  return { history, root, store, session, events, user };
}

test('native history availability is checked before lookup; missing mappings have a separate conflict', t => {
  const missing = fixture(t, false);
  for (const op of ['revert', 'unrevert', 'deleteMessage']) assert.throws(() => missing.history[op](missing.session, 'unknown'), { status: 501 });
  const { history, store, session, user } = fixture(t);
  store.putMessage(user('user'));
  assert.throws(() => history.revert(session, 'user'), { status: 409, message: 'The message has no native Mock entry' });
  assert.throws(() => history.deleteMessage(session, 'user'), { status: 409 });
});

test('recursive delete prepares native cleanup before database deletion and clears grants before cleanup', t => {
  const { root, store, session, history, events } = fixture(t);
  const child = store.create(root, root, { parentID: session.id });
  assert.equal(history.delete(session), true);
  assert.deepEqual(events, [child.id, session.id].flatMap(id => ['prepare ', 'clear ', 'cleanup '].map(action => action + id)));
});

test('message deletion uses native parents, accepts repeated requests and handles local commands by anchor', t => {
  const { store, session, history, events, user } = fixture(t);
  store.putMessage(user('native-user'));
  store.mapMessage(session.id, 'native-user', 'native-entry');
  assert.equal(history.deleteMessage(session, 'native-user'), true);
  assert.equal(history.deleteMessage(session, 'native-user'), true);
  store.putMessage(user('local-user'));
  store.putMessage({ id: 'local-reply', sessionID: session.id, parentID: 'local-user', role: 'assistant', time: { created: 1 } });
  store.recordCommand(session.id, 'local-user', 'local-reply', null);
  history.revert(session, 'local-reply');
  history.unrevert(session);
  assert.equal(history.deleteMessage(session, 'local-reply'), true);
  assert.deepEqual(events, ['native-entry']);
  assert.deepEqual(store.messages(session.id), []);
});
