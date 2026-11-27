import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const cli = resolve('dist/service/control.js');
const hash = value => createHash('sha256').update(value).digest('hex');
function write(path, value) {
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
}
function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'switch-editor-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'state'), app = join(root, 'app'), agent = join(home, 'agent');
  fs.mkdirSync(app);
  const install = { resources: join(root, 'Resources'), users: join(root, 'users'), runtimeRelease: 'a'.repeat(64), piVersion: '1.5.2' };
  write(join(home, 'install.json'), install); write(join(home, 'backend.json'), { mode: 'pi' });
  const env = { ...process.env, SHADOWBOT_SWITCH_HOME: home, OPENCODE_CONFIG_CONTENT: '{}', OPENCODE_CONFIG: '', OPENCODE_CONFIG_DIR: '', XDG_CONFIG_HOME: '' };
  const command = (status, ...args) => {
    const r = spawnSync(process.execPath, [cli, ...args, '--json'], { encoding: 'utf8', env, windowsHide: true });
    assert.equal(r.status, status, args.join(' ') + '\n' + r.stdout + r.stderr);
    return JSON.parse(r.stdout);
  };
  const ok = (...args) => command(0, ...args).data, fail = (...args) => command(1, ...args);
  const manifest = id => JSON.parse(fs.readFileSync(join(home, 'config-backups', id + '.backup.json')));
  return { root, home, agent, app, env, install, ok, fail, manifest };
}

test('rules edit exact bytes, detect stale drafts and remove the selected root to reveal fallback', t => {
  const { root, home, app, ok, fail, manifest } = fixture(t);
  const stage = join(root, 'from'), fallback = join(app, '.shadowbot-switch', 'AGENTS.md'), first = join(app, 'AGENTS.md');
  const scope = ['--app', app], args = ['--scope', 'application', ...scope];
  const show = () => ok('rules', 'show', ...scope).layers[1];
  const save = (expect, fn = ok) => fn('rules', 'save', '--from', stage, '--expect', expect, ...args);
  assert.equal(show().path, fallback);
  assert.deepEqual(ok('config', 'rules', 'show', ...scope).layers[1], show());
  write(stage, '\uFEFF 你好\r\n ');
  const added = save('absent');
  assert.equal(added.sha256, hash(fs.readFileSync(stage)));
  assert.equal(show().content, ' 你好\r\n '); assert.equal(show().bom, true); assert.equal(show().eol, 'crlf');
  write(first, 'root');
  assert.deepEqual(show().shadowed, { path: fallback });
  assert.equal(save(added.sha256, fail).code, 'conflict');
  write(stage, Buffer.alloc(32768, 97));
  const replaced = save(hash('root'));
  assert.equal(manifest(replaced.backup).kind, 'rules-save');
  assert.equal(replaced.bytes, 32768);
  for (const value of [Buffer.alloc(32769), Buffer.from([255])]) {
    write(stage, value); assert.equal(save(replaced.sha256, fail).code, 'invalid');
    assert.equal(hash(fs.readFileSync(first)), replaced.sha256);
  }
  assert.equal(ok('rules', 'remove', '--expect', replaced.sha256, ...args).fallbackActive, true);
  assert.equal(show().location, 'fallback');
  write(first, ''); assert.equal(show().effective, false); assert.equal(show().location, 'root');
  fs.unlinkSync(first);
  fs.rmSync(dirname(fallback), { recursive: true });
  const outside = join(root, 'outside'); write(join(outside, 'AGENTS.md'), 'private');
  fs.symlinkSync(outside, dirname(fallback), 'junction'); write(stage, 'next');
  assert.equal(show().readonlyReason, 'link'); assert.ok(!JSON.stringify(show()).includes('private"'));
  assert.equal(save('absent', fail).code, 'readonly'); assert.equal(fs.readFileSync(join(outside, 'AGENTS.md'), 'utf8'), 'private');
  assert.equal(fail('rules', 'save', '--scope', 'application', '--global', '--expect', 'absent', '--from', stage).code, 'invalid');
  assert.ok(fs.existsSync(join(home, 'config-backups')));
});

test('settings preserve unknown fields, effective order, menu state and broken files', t => {
  const { root, agent, app, install, ok, fail } = fixture(t);
  const file = join(agent, 'shadowbot.json'), patch = join(root, 'patch'), menu = join(install.resources, 'Copilot', 'commands', 'thinking.md');
  write(file, { enabledSkills: ['left'], disabledSkills: ['right'], other: { text: 'keep' } });
  const show = () => ok('settings', 'show', '--global');
  const save = (value, expect, fn = ok, scope = ['--global']) => {
    write(patch, { version: 1, ...value });
    return fn('settings', 'save', '--from', patch, '--expect', expect, ...scope);
  };
  const rules = [{ pattern: '*', action: 'ask' }, { pattern: 'docs_*', action: 'allow' }];
  const a = save({ mcpPermission: rules, thinkingCommand: true }, show().sha256);
  assert.ok(fs.existsSync(menu));
  const b = save({ thinkingCommand: false }, a.sha256);
  assert.equal(fs.existsSync(menu), false);
  assert.deepEqual(show().file.mcpPermission, rules);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { enabledSkills: ['left'], disabledSkills: ['right'], other: { text: 'keep' },
    mcpPermission: { '*': 'ask', 'docs_*': 'allow' }, thinkingCommand: false });
  assert.equal(save({}, a.sha256, fail).code, 'conflict');
  for (const invalid of [[...rules, rules[1]], [{ pattern: 'a b', action: 'deny' }], [{ pattern: 'a', action: 'no' }]]) {
    assert.equal(save({ mcpPermission: invalid }, b.sha256, fail).code, 'invalid');
  }
  const local = join(app, '.shadowbot-switch', 'shadowbot.json');
  assert.equal(save({ thinkingCommand: true }, 'absent', fail, ['--app', app]).code, 'invalid');
  write(local, { thinkingCommand: true, mcpPermission: { 'docs_*': 'deny', 'app_*': 'allow' } });
  const shown = ok('settings', 'show', '--app', app);
  assert.equal(shown.effective.thinkingCommand, false);
  assert.deepEqual(shown.effective.mcpPermission, [rules[0], { pattern: 'docs_*', action: 'deny' }, { pattern: 'app_*', action: 'allow' }]);
  assert.match(shown.warnings.join(''), /只在安装级/);
  assert.match(fail('config', 'check', '--app', app).data.warnings.join(''), /只在安装级/);
  save({ thinkingCommand: null, mcpPermission: [] }, b.sha256);
  assert.ok(fs.existsSync(menu)); assert.equal(show().file.thinkingCommand, null);
  for (const raw of ['[1]', '{', '{"thinkingCommand":"no"}']) {
    write(file, raw); assert.ok(show().error);
    assert.equal(save({}, hash(raw), fail).code, 'invalid'); assert.equal(fs.readFileSync(file, 'utf8'), raw);
  }
});

test('overlapping writers using the same digest commit exactly one edit', async t => {
  const { agent, root, env } = fixture(t), from = join(root, 'rule');
  write(from, 'new'); write(join(agent, 'AGENTS.md'), 'old');
  const args = [cli, 'rules', 'save', '--scope', 'installation', '--global', '--expect', hash('old'), '--from', from, '--json'];
  const results = await Promise.all(Array.from({ length: 4 }, () => promisify(execFile)(process.execPath, args, { env }).catch(error => error)));
  const parsed = results.map(r => JSON.parse(r.stdout));
  assert.equal(parsed.filter(r => r.data).length, 1);
  assert.equal(parsed.filter(r => r.code === 'conflict').length, 3);
});

test('import plans are read-only and backup restoration can undo creation, then undo the restore', t => {
  const { root, home, agent, ok, fail, manifest } = fixture(t);
  const bundle = join(root, 'package'), old = join(agent, 'old'), added = join(agent, 'new');
  write(old, 'before');
  write(bundle, { format: 'shadowbot-switch-config', version: 1, entries: ['old', 'new'].map(path => ({ path: 'agent/' + path, data: Buffer.from(path).toString('base64') })) });
  const plan = ok('config', 'import', bundle, '--dry-run');
  assert.equal(plan.dryRun, true); assert.deepEqual(plan.conflicts, [old]); assert.deepEqual(plan.files.map(f => f.action), ['overwrite', 'create']);
  assert.equal(fs.existsSync(join(home, 'config-backups')), false);
  assert.equal(fail('config', 'import', bundle).code, 'exists'); assert.equal(fs.existsSync(added), false);
  const { backup } = ok('config', 'import', bundle, '--replace');
  assert.deepEqual(manifest(backup).entries[1], { target: added, stored: null, type: 'file', existed: false });
  const restore = (id, ...flags) => ok('config', 'restore', id, '--global', ...flags);
  assert.deepEqual(restore(backup, '--dry-run').files.map(f => f.action), ['overwrite', 'delete']);
  assert.ok(fs.existsSync(added));
  const before = restore(backup).backup;
  assert.equal(fs.existsSync(added), false); assert.equal(fs.readFileSync(old, 'utf8'), 'before');
  assert.equal(manifest(before).source, backup);
  restore(before); assert.equal(fs.readFileSync(added, 'utf8'), 'new');
  const outside = join(root, 'outside'); write(outside, 'keep');
  const m = manifest(backup); m.entries[1].target = outside;
  write(join(home, 'config-backups', backup + '.backup.json'), m);
  assert.ok(fail('config', 'restore', backup).error); assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');
  assert.equal(fs.readFileSync(old, 'utf8'), 'old');
  assert.ok(fail('config', 'restore', '../invalid').error);
  const legacy = randomUUID(); fs.mkdirSync(join(home, 'config-backups', legacy));
  const damaged = randomUUID(); fs.mkdirSync(join(home, 'config-backups', damaged)); write(join(home, 'config-backups', damaged + '.backup.json'), '{');
  const list = ok('config', 'backups', '--global');
  assert.equal(list.items.find(r => r.id === legacy).restorable, false);
  assert.equal(list.items.find(r => r.id === damaged).damaged, true);
  assert.equal(ok('config', 'backups', '--limit', '1', '--offset', '1').items.length, 1);
});

test('removed skill directories and MCP files restore into their original scope', t => {
  const { home, app, ok } = fixture(t);
  const local = join(app, '.pi'), skill = join(local, 'skills', 'thing'), mcp = join(local, 'mcp.json');
  write(join(skill, 'SKILL.md'), '---\nname: thing\ndescription: instructions\n---\nhello');
  write(mcp, { mcpServers: { mine: { command: 'node' } } });
  ok('skills', 'remove', 'thing', '--app', app); ok('mcp', 'remove', 'mine', '--app', app);
  write(join(skill, 'other'), 'replace');
  const list = ok('config', 'backups', '--global').items;
  for (const kind of ['mcp-remove', 'skill-remove']) {
    const item = list.find(i => i.kind === kind);
    assert.equal(item.scope.app, app);
    assert.ok(fs.existsSync(join(home, 'config-backups', item.id, '0', kind === 'mcp-remove' ? 'mcp.json' : 'thing')));
    ok('config', 'restore', item.id, '--global');
  }
  assert.ok(fs.existsSync(join(skill, 'SKILL.md'))); assert.equal(fs.existsSync(join(skill, 'other')), false);
  assert.ok(JSON.parse(fs.readFileSync(mcp)).mcpServers.mine);
});

test('custom registry survives clear, retains missing directories and merges source labels', t => {
  const { app, root, home, install, ok, fail } = fixture(t);
  assert.ok(ok('apps', 'add', app).warnings.length);
  ok('apps', 'add', app); ok('apps', 'select', app); ok('apps', 'clear');
  const list = () => ok('apps', 'list');
  assert.deepEqual(list(), [{ name: basename(app), path: app, source: 'custom', exists: true, custom: true }]);
  const discovered = join(install.users, 'user', 'apps', 'sample'); fs.mkdirSync(discovered, { recursive: true });
  assert.deepEqual(ok('apps', 'add', discovered).warnings, []);
  assert.equal(list().find(a => a.path === discovered).source, 'discovered');
  fs.rmSync(app, { recursive: true });
  assert.equal(list().find(a => a.path === app).exists, false);
  ok('apps', 'remove', app); assert.equal(list().length, 1);
  fs.symlinkSync(discovered, app, 'junction');
  for (const path of ['relative', home, root, app]) assert.ok(fail('apps', 'add', path).error);
});

test('switch log skips invalid rows, paginates newest first and status includes runtime details', t => {
  const { home, app, ok, fail } = fixture(t);
  assert.equal(ok('log').total, 0);
  assert.deepEqual(ok('config', 'log'), ok('log'));
  const row = action => JSON.stringify({ at: new Date().toISOString(), action, from: 'original', to: 'pi' });
  write(join(home, 'switch-log.jsonl'), [row('started'), '{}', 'broken', row('committed'), ''].join('\n'));
  const page = ok('log', '--limit', '1', '--offset', '0');
  assert.equal(page.skipped, 2); assert.equal(page.total, 2); assert.equal(page.entries[0].action, 'committed');
  assert.equal(ok('log', '--offset', '1').entries[0].action, 'started');
  assert.ok(fail('log', '--limit', '501').error);
  write(join(home, 'running', process.pid + '-abc.json'), { root: app, pid: process.pid, updated: Date.now(), active: 1, revision: 'old',
    harness: 'pi', mcp: { docs: { status: 'connected' } }, errors: {}, menuReconnect: true });
  const state = ok('status').applications[0];
  assert.equal(state.pid, process.pid); assert.ok(state.live && state.pending && state.menuReconnect); assert.equal(state.mcp.docs.status, 'connected');
  assert.equal(ok('apps').find(a => a.path === app).source, 'running');
});

test('failed restore rolls back earlier files, retains both backups and cleans temporary files', async t => {
  const { root, home, agent, ok } = fixture(t);
  const bundle = join(root, 'bundle'), a = join(agent, 'a'), b = join(agent, 'b');
  write(a, 'before-a'); write(b, 'before-b');
  write(bundle, { format: 'shadowbot-switch-config', version: 1, entries: ['a', 'b'].map(name => ({
    path: 'agent/' + name, data: Buffer.from('imported-' + name).toString('base64') })) });
  const id = ok('config', 'import', bundle, '--replace').backup;
  const { restoreBackup } = await import('../dist/service/config-backups.js');
  const { syncBuiltinESMExports } = await import('node:module');
  const rename = fs.renameSync;
  let injected = false;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (!injected && to === b) { injected = true; throw new Error('synthetic write failure'); }
    return rename(from, to);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => restoreBackup(home, id, { dryRun: false }), /已回滚.*原备份.*恢复前备份/);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(fs.readFileSync(a, 'utf8'), 'imported-a');
  assert.equal(fs.readFileSync(b, 'utf8'), 'imported-b');
  assert.deepEqual(fs.readdirSync(agent).sort(), ['a', 'b']);
  const items = ok('config', 'backups').items;
  assert.ok(items.some(item => item.source === id && item.restorable));
  assert.ok(items.some(item => item.id === id && item.restorable));
});
