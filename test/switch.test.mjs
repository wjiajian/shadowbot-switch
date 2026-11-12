import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import test from 'node:test';
import { switchBackend } from '../dist/service/switch.js';

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
