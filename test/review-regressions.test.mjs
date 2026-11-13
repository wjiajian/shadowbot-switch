import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { customMcp } from '../dist/service/mcp-config.js';
import { userSettings } from '../dist/service/shadowbot.js';

const control = resolve('dist/service/control.js');
const put = (path, data) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data)); };
function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'shadowbot-review-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'state'), app = join(root, 'app');
  mkdirSync(app);
  put(join(home, 'install.json'), { runtime: { harness: 'pi', release: 'a'.repeat(64) }, harnesses: { pi: { release: 'a'.repeat(64), version: '1.5.2', adapter: 'missing.js', capabilities: { skills: true, mcp: true } } }, resources: join(root, 'resources'), users: join(root, 'users'), database: join(root, 'missing.db'), agentPath: join(root, 'missing.exe') });
  put(join(home, 'backend.json'), { mode: 'original' });
  const run = (...args) => spawnSync(process.execPath, [control, ...args, '--json'], { env: { ...process.env, SHADOWBOT_SWITCH_HOME: home, OPENCODE_CONFIG_CONTENT: '{}', OPENCODE_CONFIG: '', OPENCODE_CONFIG_DIR: '', XDG_CONFIG_HOME: '' }, encoding: 'utf8', windowsHide: true });
  const ok = (...args) => { const r = run(...args); assert.equal(r.status, 0, r.stdout + r.stderr); return JSON.parse(r.stdout).data; };
  return { root, home, app, run, ok };
}

test('offline config and resource management work with original selected or an unloadable adapter', t => {
  const { root, home, ok } = setup(t);
  ok('mcp', 'add', 'offline', '--url', 'https://example.com/mcp');
  assert.equal(ok('config', 'check').valid, true);
  const bundle = join(root, 'backup.json');
  ok('config', 'export', bundle);
  ok('mcp', 'remove', 'offline');
  ok('config', 'import', bundle, '--replace');
  const source = join(root, 'source');
  put(join(source, 'SKILL.md'), '---\nname: review-skill\ndescription: Test management without a running harness.\n---\nInstructions');
  ok('skills', 'add', source);
  assert.ok(ok('skills').some(r => r.name === 'review-skill'));
  ok('skills', 'remove', 'review-skill');
  put(join(home, 'backend.json'), { mode: 'pi' });
  ok('config', 'export', bundle, '--replace');
  assert.equal(ok('config', 'check').valid, true);
});

test('app export preserves merged legacy MCP and settings; legacy resources can be removed', t => {
  const { root, home, app, ok } = setup(t);
  put(join(home, 'agent', 'mcp.json'), { mcpServers: { inherited: { command: 'node' } } });
  put(join(app, '.pi', 'mcp.json'), { mcpServers: { legacy: { command: 'node', args: ['old'] }, inherited: { enabled: false } } });
  put(join(app, '.shadowbot-switch', 'mcp.json'), { mcpServers: { legacy: { enabled: false }, modern: { url: 'https://example.com/mcp' } } });
  put(join(app, '.pi', 'shadowbot.json'), { enabledSkills: ['one'], disabledSkills: ['two'], mcpPermission: { 'legacy_*': 'deny' } });
  put(join(app, '.shadowbot-switch', 'shadowbot.json'), { enabledSkills: ['two'], disabledSkills: ['three'], mcpPermission: { 'modern_*': 'ask' } });
  const source = ok('mcp', '--app', app).find(r => r.name === 'inherited').source;
  assert.match(source, /\.pi/);
  const bundle = join(root, 'app.json');
  ok('config', 'export', bundle, '--app', app);
  const other = join(root, 'other'); mkdirSync(other);
  ok('config', 'import', bundle, '--app', other);
  assert.deepEqual([...customMcp(join(home, 'agent'), other)], [...customMcp(join(home, 'agent'), app)]);
  assert.deepEqual(userSettings(join(home, 'agent'), other), userSettings(join(home, 'agent'), app));
  ok('mcp', 'remove', 'legacy', '--app', app);
  assert.equal(customMcp(join(home, 'agent'), app).has('legacy'), false);
  const oldSkill = join(app, '.pi', 'skills', 'legacy-skill');
  put(join(oldSkill, 'SKILL.md'), '---\nname: legacy-skill\ndescription: Legacy test skill.\n---\nInstructions');
  ok('skills', 'remove', 'legacy-skill', '--app', app);
  assert.equal(existsSync(oldSkill), false);
});

test('doctor reports missing, malformed and unknown backend selections alongside independent checks', t => {
  const { home, run } = setup(t);
  for (const selection of [undefined, '{', { mode: 'missing' }]) {
    const path = join(home, 'backend.json');
    if (selection === undefined) rmSync(path); else put(path, selection);
    const result = run('doctor');
    assert.equal(result.status, 1);
    const rows = JSON.parse(result.stdout).data;
    assert.ok(rows.some(r => r.check === '后端选择' && r.status === '失败'));
    assert.ok(rows.some(r => r.check === '会话数据库'));
    assert.ok(rows.some(r => r.check === 'MCP 配置'));
  }
});

test('Pi initializes its private agent directory before the first SDK import', t => {
  const { home } = setup(t);
  const code = `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    const expected = ${JSON.stringify(join(home, 'harnesses', 'pi', 'agent'))};
    let imports = 0;
    registerHooks({ resolve(specifier, context, next) {
      if (specifier === '@earendil-works/pi-coding-agent') {
        imports++;
        assert.equal(process.env.PI_CODING_AGENT_DIR, expected);
      }
      return next(specifier, context);
    } });
    const { initialize } = await import(${JSON.stringify(pathToFileURL(resolve('dist/service/adapters/pi/index.js')).href)});
    const adapter = await initialize(${JSON.stringify(home)});
    await adapter.verify('1.5.2');
    assert.ok(imports > 0);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, PI_CODING_AGENT_DIR: join(home, 'wrong') }, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
