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
import { assertRunsContract } from '../dist/service/adapter.js';

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
    // Registration can describe a newer release than the installed adapter.
    // Its advertised features must not override the installed capabilities.
    put(join(runtime, 'harnesses', 'fixture', 'harness.json'), { ...spec, capabilities: { skills: true, mcp: true } });
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
    assert.deepEqual(JSON.parse(status.stdout).data.capabilities, { skills: false, mcp: false });
    assert.equal(cli('mcp').status, 0, 'offline MCP management must not require runtime support');
    assert.equal(cli('skills').status, 0, 'offline skill management must not require runtime support');
    const diagnostics = JSON.parse(cli('doctor').stdout).data;
    assert.equal(diagnostics.find(row => row.check === '运行时').status, '通过');
    assert.match(cli('mcp', 'test').stdout, /没有支持 MCP/);
    put(join(home, 'backend.json'), { mode: 'original' });
    assert.match(cli('mcp', 'test').stdout, /没有支持 MCP/, 'original selection must not choose an installed adapter based on newer registration capabilities');
    put(join(home, 'backend.json'), { mode: 'fixture' });
    const start = async () => {
      process = spawn(globalThis.process.execPath, [join(runtime, 'service/main.js'), 'serve', '--port', '0'], { env, windowsHide: true });
      closed = once(process, 'close');
      let errors = ''; process.stderr.on('data', chunk => errors += chunk);
      const lines = createInterface({ input: process.stdout });
      const address = (async () => { for await (const line of lines) { const match = /listening on (http:\/\/\S+)/.exec(line); if (match) return match[1]; } throw new Error(errors); })();
      return Promise.race([address, closed.then(() => { throw new Error(errors); })]);
    };
    // AGENTS.md rules are loaded by the shared layer, so a non-Pi adapter receives them without its own loader.
    put(join(home, 'agent', 'AGENTS.md'), 'fixture-installation-rule');
    put(join(workspace, 'AGENTS.md'), 'fixture-application-rule');
    const base = await start();
    const session = await fetch(base + '/session', { method: 'POST', body: JSON.stringify({ title: 'fixture history' }) }).then(r => r.json());
    const send = body => fetch(`${base}/session/${session.id}/message`, { method: 'POST', body: JSON.stringify(body) }).then(r => r.json());
    const recorded = () => JSON.parse(readFileSync(join(home, 'backends', 'fixture', 'sessions', `${session.id}.json`), 'utf8'));
    const reply = await send({ system: 'host-system-marker', parts: [{ type: 'text', text: 'hello' }] });
    assert.equal(reply.parts[0].text, 'fixture reply');
    let handed = recorded();
    assert.match(handed.instructions, /fixture-installation-rule[\s\S]*fixture-application-rule/);
    assert.equal(handed.prompt.system, 'host-system-marker', 'rules must not be merged into the host system prompt');
    put(join(workspace, 'AGENTS.md'), 'fixture-updated-rule');
    await send({ parts: [{ type: 'text', text: 'again' }] });
    handed = recorded();
    assert.match(handed.instructions, /fixture-updated-rule/);
    assert.doesNotMatch(handed.instructions, /fixture-application-rule/);
    rmSync(join(home, 'agent', 'AGENTS.md'));
    rmSync(join(workspace, 'AGENTS.md'));
    await send({ parts: [{ type: 'text', text: 'no rules' }] });
    assert.equal(recorded().instructions, '');
    assert.equal((await fetch(base + '/mcp')).status, 501);
    assert.deepEqual(await fetch(base + '/skill').then(r => r.json()), []);
    process.kill(); await closed; process = undefined;
    await switchBackend(home, install, 'original', schema, () => {}, registry);
    await switchBackend(home, install, 'pi', schema, () => {}, registry);
    assert.equal(existsSync(join(home, 'backends', 'pi', 'sessions')), false);
    await switchBackend(home, install, 'fixture', schema, () => {}, registry);
    const restarted = await start();
    assert.equal((await fetch(restarted + '/session').then(r => r.json()))[0].id, session.id);
    assert.equal((await fetch(`${restarted}/session/${session.id}/message`).then(r => r.json())).length, 6);
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

test('runs that drop the per-turn run argument are rejected instead of silently ignoring AGENTS.md rules', () => {
  // A two-parameter start() still type-checks against HarnessRuns, so the shared layer checks it at runtime.
  const accepted = { start(session, prompt, run) { return run; } };
  assert.equal(assertRunsContract(accepted, 'current'), accepted);
  assert.doesNotThrow(() => assertRunsContract({ start(session, prompt, run, interaction) {} }, 'extended'));
  assert.throws(() => assertRunsContract({ start(session, prompt) {} }, 'legacy'), /legacy.*run\.instructions/);
  assert.throws(() => assertRunsContract({}, 'missing'), /missing/);
});

test('opening an already migrated store does not acquire a write lock on host history', () => {
  const root = mkdtempSync(join(tmpdir(), 'shadowbot-store-lock-'));
  let writer, store;
  try {
    const dbPath = join(root, 'host.db'), adapterPath = join(root, 'adapter.db');
    writer = new DatabaseSync(dbPath); writer.exec(schema);
    store = new Store(dbPath, adapterPath, () => {}); store.db.close(); store = undefined;
    writer.exec('BEGIN IMMEDIATE');
    store = new Store(dbPath, adapterPath, () => {});
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM session').get().n, 0);
  } finally {
    store?.db.close(); writer?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a different adapter release preserves safe errors and host MCP independently of custom MCP capability', { timeout: 20_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'shadowbot-cross-release-'));
  const home = join(root, 'state'), workspace = join(root, 'workspace');
  const managerID = 'a'.repeat(64), adapterID = 'b'.repeat(64);
  const manager = join(home, 'harnesses', 'fixture', 'releases', managerID);
  const runtime = join(home, 'harnesses', 'fixture', 'releases', adapterID);
  const spec = JSON.parse(readFileSync('test/fixtures/harness/harness.json'));
  let child, closed;
  try {
    for (const directory of [manager, runtime]) {
      cpSync(resolve('dist/service'), join(directory, 'service'), { recursive: true });
      cpSync(resolve('harnesses'), join(directory, 'harnesses'), { recursive: true });
      put(join(directory, 'harnesses/fixture/harness.json'), spec);
      for (const dependency of ['yaml', 'ignore']) cpSync(resolve('node_modules', dependency), join(directory, 'node_modules', dependency), { recursive: true });
      put(join(directory, 'package.json'), { type: 'module' });
      put(join(directory, 'schema.sql'), schema);
    }
    // The copied release has distinct, unbranded error constructors. The manager
    // must recognize them without trusting arbitrary error names or messages.
    put(join(runtime, 'service/adapters/fixture/base.js'), readFileSync('test/fixtures/harness/adapter.mjs', 'utf8'));
    put(join(runtime, 'service', spec.adapter), `
      import { adapter as base } from './base.js';
      import { UserError } from '../../errors.js';
      export const adapter = { ...base, createRuns(context) {
        const runs = base.createRuns(context);
        return { ...runs, rename(session, title) {
          if (title === 'safe') throw new UserError('Fixture configuration needs correction');
          if (title === 'unsafe') throw new Error('private provider payload');
          return runs.rename(session, title);
        } };
      }, mcp: { create() {
        const servers = {};
        return { async addBuiltin(name) { servers[name] = { status: 'connected' }; },
          async reloadCustom() { throw new Error('Custom MCP must remain disabled'); },
          status: () => servers, configurationErrors: () => ({}), async connect() {}, async disconnect() {}, async close() {} };
      } } };
    `);
    mkdirSync(workspace);
    const database = join(root, 'host.db');
    const db = new DatabaseSync(database); db.exec(schema); db.close();
    put(join(home, 'install.json'), { database, resources: join(root, 'resources'), runtime: { harness: 'fixture', release: managerID }, harnesses: { fixture: { release: adapterID, version: spec.version, adapter: spec.adapter, capabilities: spec.capabilities } } });
    put(join(home, 'backend.json'), { mode: 'fixture' });
    put(join(home, 'agent/mcp.json'), { mcpServers: { custom: { command: 'must-not-run' } } });
    const env = { ...process.env, SHADOWBOT_SWITCH_HOME: home, SHADOWBOT_OPENCODE_WORKSPACE_ROOT: workspace,
      OPENCODE_CONFIG: '', OPENCODE_CONFIG_DIR: '', XDG_CONFIG_HOME: '', OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp: { 'studio-mcp': { type: 'remote', url: 'http://127.0.0.1/mcp' } } }) };
    child = spawn(process.execPath, [join(manager, 'service/main.js'), 'serve', '--port', '0'], { env, windowsHide: true });
    closed = once(child, 'close');
    let errors = ''; child.stderr.on('data', chunk => errors += chunk);
    const lines = createInterface({ input: child.stdout });
    const address = (async () => { for await (const line of lines) { const match = /listening on (http:\/\/\S+)/.exec(line); if (match) return match[1]; } throw new Error(errors); })();
    const base = await Promise.race([address, closed.then(() => { throw new Error(errors); })]);
    const session = await fetch(base + '/session', { method: 'POST', body: '{}' }).then(r => r.json());
    const requestError = await fetch(`${base}/session/${session.id}/unrevert`, { method: 'POST' });
    assert.equal(requestError.status, 501);
    assert.equal((await requestError.json()).data.message, 'Fixture operation unavailable');
    const userError = await fetch(`${base}/session/${session.id}`, { method: 'PATCH', body: JSON.stringify({ title: 'safe' }) });
    assert.equal(userError.status, 400);
    assert.equal((await userError.json()).data.message, 'Fixture configuration needs correction');
    const unknown = await fetch(`${base}/session/${session.id}`, { method: 'PATCH', body: JSON.stringify({ title: 'unsafe' }) });
    assert.equal(unknown.status, 500);
    assert.doesNotMatch(await unknown.text(), /private provider payload/);
    assert.deepEqual(await fetch(base + '/mcp').then(r => r.json()), { 'studio-mcp': { status: 'connected' } });
    const added = await fetch(base + '/mcp', { method: 'POST', body: JSON.stringify({ name: 'host-extra', config: { type: 'remote', url: 'http://127.0.0.1/extra' } }) });
    assert.equal(added.status, 200);
    assert.equal((await added.json())['host-extra'].status, 'connected');
  } finally {
    if (child) { child.kill(); await closed; }
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
