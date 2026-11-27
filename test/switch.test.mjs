import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../dist/service/store.js';
import { switchBackend, verifySchema } from '../dist/service/switch.js';

const schema = readFileSync('contract/schema.sql', 'utf8');
const insert = "INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES (?, '.', 1, 1, '[]')";

test('backend snapshots preserve WAL, isolate pointers, and recover an interrupted switch', { timeout: 20_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'shadowbot-pi-switch-'));
  const home = join(root, 'pi');
  const users = join(root, 'users');
  const database = join(root, 'opencode.db');
  const pointer = join(users, 'user', 'apps', 'app', 'copilot', 'agent', 'sessions', 'current-session.json');
  const projectFile = join(users, 'user', 'apps', 'app', 'flow.json');
  const backendFile = join(home, 'backend.json');
  const pending = join(home, 'switch.pending.json');
  const install = { database, users };
  mkdirSync(dirname(pointer), { recursive: true });
  mkdirSync(home);
  writeFileSync(backendFile, '{"mode":"observe"}');
  writeFileSync(projectFile, '{"flow":"original-content"}');
  writeFileSync(pointer, '{"sessionId":"original"}');
  const db = new DatabaseSync(database);
  db.exec(schema);
  db.exec('CREATE TABLE host_extension(id INTEGER); INSERT INTO host_extension VALUES(1); ALTER TABLE project ADD COLUMN future TEXT');
  verifySchema(database);
  db.close();
  const writer = spawn(process.execPath, ['--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
    db.prepare(${JSON.stringify(insert)}).run('original-in-wal');
    console.log('committed');
    setInterval(() => {}, 1000);
  `, database], { windowsHide: true });
  const closed = once(writer, 'close');
  try {
    await Promise.race([once(writer.stdout, 'data'), closed.then(() => { throw new Error('WAL fixture stopped early'); })]);
    writer.kill();
    await closed;
    assert.ok(existsSync(database + '-wal'));
    const read = () => {
      const db = new DatabaseSync(database, { readOnly: true });
      try { return db.prepare('SELECT id FROM project ORDER BY id').all().map(row => row.id); }
      finally { db.close(); }
    };
    await switchBackend(home, install, 'pi', schema, () => {});
    assert.deepEqual(read(), []);
    assert.equal(existsSync(pointer), false);
    const pi = new DatabaseSync(database);
    assert.equal(pi.prepare('SELECT count(*) AS n FROM host_extension').get().n, 0);
    pi.prepare(insert).run('pi-only');
    pi.close();
    writeFileSync(pointer, '{"sessionId":"pi"}');
    await switchBackend(home, install, 'original', schema, () => {});
    assert.deepEqual(read(), ['original-in-wal']);
    assert.equal(readFileSync(pointer, 'utf8'), '{"sessionId":"original"}');
    await switchBackend(home, install, 'pi', schema, () => {});
    assert.deepEqual(read(), ['pi-only']);
    assert.equal(readFileSync(pointer, 'utf8'), '{"sessionId":"pi"}');
    writeFileSync(pending, '{"previous":"original","source":"original","destination":"pi"}');
    await switchBackend(home, install, 'original', schema, () => {});
    assert.equal(existsSync(pending), false);
    assert.deepEqual(read(), ['original-in-wal']);
    assert.equal(readFileSync(pointer, 'utf8'), '{"sessionId":"original"}');
    assert.equal(readFileSync(projectFile, 'utf8'), '{"flow":"original-content"}');
    assert.match(readFileSync(join(home, 'switch-log.jsonl'), 'utf8'), /"action":"recovered"/);
  } finally {
    writer.kill();
    await closed;
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test('busy and interrupted pre-replacement switches preserve the active history', { timeout: 15_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'shadowbot-pi-switch-busy-'));
  const home = join(root, 'pi');
  const users = join(root, 'users');
  const database = join(root, 'opencode.db');
  const pending = join(home, 'switch.pending.json');
  const backend = join(home, 'backend.json');
  const install = { database, users };
  const stopped = () => {};
  mkdirSync(home);
  writeFileSync(backend, '{"mode":"observe"}');
  const original = new DatabaseSync(database);
  original.exec(`${schema}\nPRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;`);
  original.prepare(insert).run('original');
  const reader = new DatabaseSync(database, { readOnly: true });
  try {
    reader.exec('BEGIN');
    const select = 'SELECT id FROM project ORDER BY rowid';
    assert.equal(reader.prepare(select).all().length, 1);
    original.prepare(insert).run('committed-in-wal');
    await assert.rejects(switchBackend(home, install, 'pi', schema, stopped), /busy/i);
    assert.equal(existsSync(pending), false);
    assert.equal(JSON.parse(readFileSync(backend, 'utf8')).mode, 'observe');
    reader.exec('ROLLBACK');
    original.prepare(insert).run('newer-than-snapshot');

    // Simulate termination after the durable journal is written and before the database rename.
    const stage = randomUUID();
    const staged = join(root, `shadowbot-pi-${stage}.db`);
    writeFileSync(staged, 'The staging marker still exists');
    writeFileSync(pending, JSON.stringify({ previous: 'observe', source: 'original', destination: 'pi', stage }));
    await switchBackend(home, install, 'original', schema, stopped);
    assert.equal(existsSync(pending), false);
    assert.equal(existsSync(staged), false);
    assert.deepEqual(original.prepare(select).all().map(row => row.id), ['original', 'committed-in-wal', 'newer-than-snapshot']);
    assert.match(readFileSync(join(home, 'switch-log.jsonl'), 'utf8'), /"action":"discarded"/);
  } finally {
    reader.close();
    original.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test('same-backend reattachment and switching away reject mixed histories before saving snapshots', async t => {
  const home = mkdtempSync(join(tmpdir(), 'switch-mixed-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const database = join(home, 'active.db');
  const install = { database, users: join(home, 'users') };
  const db = new DatabaseSync(database);
  db.exec(schema);
  db.close();
  writeFileSync(join(home, 'backend.json'), '{"mode":"original"}');
  const change = destination => switchBackend(home, install, destination, schema, () => {});
  await change('pi');
  const snapshot = () => readFileSync(join(home, 'backends', 'pi', 'snapshot.json'), 'utf8');
  const before = snapshot();
  const store = new Store(database, join(home, 'backends', 'pi', 'adapter.db'), () => {});
  try {
    const session = store.create(home, home, { metadata: { marker: 1 } });
    store.patchSession(session.id, { title: undefined, metadata: undefined });
    assert.deepEqual(store.get(session.id).metadata, { marker: 1 });
    assert.equal(store.get(session.id).title, session.title);
    writeFileSync(join(home, 'install.json'), JSON.stringify({ ...install, resources: home, agentPath: join(home, 'opencode.exe') }));
    const assertStopped = async () => {
      for (const destination of ['pi', 'original']) await assert.rejects(change(destination), /活动会话库/);
      const doctor = spawnSync(process.execPath, ['dist/service/control.js', 'doctor', '--json'], {
        env: { ...process.env, SHADOWBOT_SWITCH_HOME: home }, encoding: 'utf8', windowsHide: true,
      });
      const check = JSON.parse(doctor.stdout).data.find(row => row.check === '会话数据库');
      assert.equal(check.status, '失败');
      assert.match(check.detail, /活动会话库/);
      assert.equal(snapshot(), before);
      assert.equal(JSON.parse(readFileSync(join(home, 'backend.json'))).mode, 'pi');
      assert.equal(existsSync(join(home, 'switch.pending.json')), false);
    };
    store.db.prepare("UPDATE main.session SET metadata=? WHERE id=?").run('{"shadowbotContextCompatibility":{"state":"completed"}}', session.id);
    await assertStopped();
    store.patchSession(session.id, { metadata: { marker: 1 } });
    await change('pi');
    store.db.prepare('DELETE FROM adapter.session WHERE id=?').run(session.id);
    await assertStopped();
    assert.ok(store.db.prepare('SELECT 1 FROM main.session WHERE id=?').get(session.id));
  } finally { store.db.close(); }
});

test('standalone ownership preflight handles a missing adapter and sessions without metadata', t => {
  const root = mkdtempSync(join(tmpdir(), 'switch-cli-'));
  const database = join(root, 'opencode.db');
  const adapter = join(root, 'adapter.db');
  const db = new DatabaseSync(database);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  db.exec('CREATE TABLE session(id TEXT, title TEXT, time_updated INTEGER)');
  const check = expected => {
    const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/history-ownership.ts', database, adapter],
      { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, expected, result.stderr);
    if (expected) assert.match(result.stderr, /活动会话库/);
  };
  check(0);
  db.exec("INSERT INTO session VALUES ('one', 'draft', 1)");
  check(1);
  assert.equal(existsSync(adapter), false);
  const history = new DatabaseSync(adapter);
  history.exec('CREATE TABLE session(id TEXT, session TEXT)');
  history.prepare('INSERT INTO session VALUES (?, ?)').run('one', JSON.stringify({ title: 'draft', time: { updated: 1 } }));
  history.close();
  check(0);
  db.exec("UPDATE session SET title = 'changed'");
  check(1);
});

test('schema verification identifies the missing required column', t => {
  const root = mkdtempSync(join(tmpdir(), 'switch-schema-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'host.db');
  const db = new DatabaseSync(file);
  db.exec(schema);
  db.exec('ALTER TABLE part DROP COLUMN data');
  db.close();
  assert.throws(() => verifySchema(file), /missing part\.data/);
});
