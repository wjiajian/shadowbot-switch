import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { HarnessRegistry } from '../dist/service/harnesses.js';
import { runtimeDirectory } from '../dist/service/installation.js';
import { switchBackend } from '../dist/service/switch.js';
import { Store } from '../dist/service/store.js';

const schema = readFileSync('contract/schema.sql', 'utf8');
const put = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)); };

test('a registered non-Pi adapter launches the shared host, persists its history, gates capabilities, and needs no Pi SDK', { timeout: 20_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'shadowbot-harness-contract-'));
  const home = join(root, 'state'), workspace = join(root, 'workspace'), release = 'c'.repeat(64);
  const runtime = join(home, 'harnesses', 'fixture', 'releases', release);
  const spec = JSON.parse(readFileSync('test/fixtures/harness/harness.json'));
  const install = { format: 2, database: join(root, 'active.db'), users: join(root, 'users'), resources: join(root, 'resources'),
    runtime: { harness: 'fixture', release }, harnesses: { fixture: { release, version: spec.version, adapter: spec.adapter, launch: spec.launch, capabilities: spec.capabilities } } };
  let process;
  let closed;
  try {
    cpSync(resolve('dist/service'), join(runtime, 'service'), { recursive: true });
    cpSync(resolve('harnesses'), join(runtime, 'harnesses'), { recursive: true });
    put(join(runtime, 'harnesses', 'fixture', 'harness.json'), spec);
    put(join(runtime, 'service', spec.adapter), readFileSync('test/fixtures/harness/adapter.mjs', 'utf8'));
    cpSync(resolve('node_modules/yaml'), join(runtime, 'node_modules', 'yaml'), { recursive: true });
    cpSync(resolve('node_modules/ignore'), join(runtime, 'node_modules', 'ignore'), { recursive: true });
    put(join(runtime, 'package.json'), { type: 'module' });
    put(join(runtime, 'schema.sql'), schema);
    put(join(home, 'install.json'), install);
    put(join(home, 'backend.json'), { mode: 'original' });
    mkdirSync(workspace);
    const db = new DatabaseSync(install.database); db.exec(schema); db.close();
    const registry = new HarnessRegistry(join(runtime, 'harnesses'));
    assert.equal(registry.get('test-engine').id, 'fixture');
    assert.equal(runtimeDirectory(home, install, 'fixture'), runtime);
    await switchBackend(home, install, 'fixture', schema, () => {}, registry);
    const env = { ...globalThis.process.env, SHADOWBOT_SWITCH_HOME: home, SHADOWBOT_PI_HOME: '', OPENCODE_CONFIG_CONTENT: '{}', OPENCODE_CONFIG: '', OPENCODE_CONFIG_DIR: '', XDG_CONFIG_HOME: '', SHADOWBOT_OPENCODE_WORKSPACE_ROOT: workspace };
    const cli = (...args) => spawnSync(globalThis.process.execPath, [join(runtime, 'service/control.js'), ...args, '--json'], { env, encoding: 'utf8', windowsHide: true });
    const status = cli('status');
    assert.equal(status.status, 0, status.stderr + status.stdout);
    assert.equal(JSON.parse(status.stdout).data.harness, 'fixture');
    assert.equal(cli('mcp').status, 1);
    assert.match(cli('skills').stdout, /不支持/);
    const diagnostics = JSON.parse(cli('doctor').stdout).data;
    assert.equal(diagnostics.find(row => row.check === '运行时').status, '通过');
    const start = async () => {
      process = spawn(globalThis.process.execPath, [join(runtime, 'service/main.js'), 'serve', '--port', '0'], { env, windowsHide: true });
      closed = once(process, 'close');
      let errors = ''; process.stderr.on('data', chunk => errors += chunk);
      const lines = createInterface({ input: process.stdout });
      const address = (async () => { for await (const line of lines) { const match = /listening on (http:\/\/\S+)/.exec(line); if (match) return match[1]; } throw new Error(errors); })();
      return Promise.race([address, closed.then(() => { throw new Error(errors); })]);
    };
    const base = await start();
    const session = await fetch(base + '/session', { method: 'POST', body: JSON.stringify({ title: 'fixture history' }) }).then(r => r.json());
    const reply = await fetch(`${base}/session/${session.id}/message`, { method: 'POST', body: JSON.stringify({ parts: [{ type: 'text', text: 'hello' }] }) }).then(r => r.json());
    assert.equal(reply.parts[0].text, 'fixture reply');
    assert.equal((await fetch(base + '/mcp')).status, 501);
    assert.deepEqual(await fetch(base + '/skill').then(r => r.json()), []);
    process.kill(); await closed; process = undefined;
    await switchBackend(home, install, 'original', schema, () => {}, registry);
    await switchBackend(home, install, 'pi', schema, () => {}, registry);
    assert.equal(existsSync(join(home, 'backends', 'pi', 'sessions')), false);
    await switchBackend(home, install, 'fixture', schema, () => {}, registry);
    const restarted = await start();
    assert.equal((await fetch(restarted + '/session').then(r => r.json()))[0].id, session.id);
    assert.equal((await fetch(`${restarted}/session/${session.id}/message`).then(r => r.json())).length, 2);
    process.kill(); await closed; process = undefined;
    // Simulate an interruption after the database replacement, before committing the mode.
    put(join(home, 'switch.pending.json'), { previous: 'original', source: 'original', destination: 'fixture' });
    await switchBackend(home, install, 'original', schema, () => {}, registry);
    const restored = new DatabaseSync(install.database);
    assert.equal(restored.prepare('SELECT count(*) AS n FROM session').get().n, 0); restored.close();
    assert.ok(existsSync(join(home, 'backends', 'fixture', 'sessions', `${session.id}.json`)));
    assert.equal(existsSync(join(runtime, 'node_modules', '@earendil-works')), false);
  } finally {
    if (process) { process.kill(); await closed; }
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test('legacy adapter databases migrate native mapping columns without losing transcript anchors', () => {
  const root = mkdtempSync(join(tmpdir(), 'shadowbot-native-migration-'));
  try {
    const dbPath = join(root, 'host.db'), adapterPath = join(root, 'adapter.db');
    const db = new DatabaseSync(dbPath); db.exec(schema); db.close();
    let store = new Store(dbPath, adapterPath, () => {});
    const session = store.create(root, root, { title: 'legacy' });
    store.native(session.id, 'old-session.jsonl', 'leaf');
    store.mapMessage(session.id, 'message', 'entry');
    store.db.exec('ALTER TABLE adapter.session RENAME COLUMN native_file TO pi_file; ALTER TABLE adapter.session RENAME COLUMN native_leaf TO pi_leaf; ALTER TABLE adapter.message_map RENAME COLUMN native_entry TO pi_entry');
    store.db.close();
    store = new Store(dbPath, adapterPath, () => {});
    assert.equal(store.meta(session.id).native_file, 'old-session.jsonl');
    assert.equal(store.meta(session.id).native_leaf, 'leaf');
    assert.equal(store.mapped(session.id, 'message'), 'entry');
    store.db.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
