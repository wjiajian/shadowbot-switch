import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { skillInventory } from '../dist/service/shadowbot.js';
import { skillSources } from '../dist/service/host-skills.js';
import { configurationRevision, publishRuntimeState, runtimeStates } from '../dist/service/runtime-state.js';
import { loadAgentRules, maxRuleBytes } from '../dist/service/agent-rules.js';

const control = resolve('dist/service/control.js');
const put = (path, data) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data)); };
const skill = (path, name, body = 'Instructions') => put(join(path, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} instructions.\n---\n${body}\n`);

test('rule migration diagnoses skipped exports and validates imports before writing', { timeout: 30_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'shadowbot-rule-migration-'));
  const home = join(root, 'state'), app = join(root, 'app');
  const install = { runtimeRelease: 'a'.repeat(64), piVersion: '1.5.2', resources: join(root, 'resources'), users: join(root, 'users') };
  put(join(home, 'install.json'), install);
  put(join(home, 'backend.json'), { mode: 'pi' });
  const settings = join(app, '.shadowbot-switch', 'shadowbot.json');
  put(settings, { disabledSkills: ['original'] });
  const env = { ...process.env, SHADOWBOT_PI_HOME: home, OPENCODE_CONFIG_CONTENT: '{}', OPENCODE_CONFIG: '', OPENCODE_CONFIG_DIR: '', XDG_CONFIG_HOME: '' };
  const run = (expected, ...args) => {
    const result = spawnSync(process.execPath, [control, ...args, '--json'], { env, cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, expected, result.stderr + result.stdout);
    return JSON.parse(result.stdout);
  };
  const bundle = join(root, 'bundle.json');
  const rulePath = join(app, 'AGENTS.md');
  const writeBundle = (name, data) => put(bundle, { format: 'shadowbot-switch-config', version: 1, entries: [
    { path: 'agent/shadowbot.json', data: Buffer.from('{"disabledSkills":["changed"]}').toString('base64') },
    { path: `agent/${name}`, data: data.toString('base64') },
  ] });
  try {
    put(join(home, 'agent', 'shadowbot.json'), { disabledSkills: [] });
    for (const [scope, file] of [
      [['--app', app], rulePath],
      [['--app', app], join(app, '.shadowbot-switch', 'AGENTS.md')],
      [['--global'], join(home, 'agent', 'AGENTS.md')],
    ]) {
      for (const bad of [Buffer.from([0xff]), Buffer.alloc(maxRuleBytes + 1, 97)]) {
        writeFileSync(file, bad);
        const result = run(0, 'config', 'export', bundle, ...scope, '--replace').data;
        assert.match(result.warnings.join(''), /未导出.*其余配置已导出/);
        assert.doesNotMatch(result.warnings.join(''), /本轮/);
        const entries = JSON.parse(readFileSync(bundle, 'utf8')).entries;
        assert.ok(entries.some(e => e.path === 'agent/shadowbot.json'));
        assert.ok(!entries.some(e => e.path.toLowerCase() === 'agent/agents.md'));
      }
      unlinkSync(file);
    }
    writeFileSync(rulePath, 'existing-root-rule');
    for (const bad of [Buffer.from([0xff]), Buffer.alloc(maxRuleBytes + 1, 97)]) {
      writeBundle('agents.md', bad);
      for (const scope of [['--app', app], ['--global']]) {
        const before = readFileSync(settings, 'utf8');
        const globalBefore = readFileSync(join(home, 'agent', 'shadowbot.json'), 'utf8');
        run(1, 'config', 'import', bundle, ...scope, '--replace');
        assert.equal(readFileSync(settings, 'utf8'), before);
        assert.equal(readFileSync(join(home, 'agent', 'shadowbot.json'), 'utf8'), globalBefore);
        assert.equal(readFileSync(rulePath, 'utf8'), 'existing-root-rule');
      }
    }
    // Import lower-case names into an app with existing root rules.
    put(bundle, { format: 'shadowbot-switch-config', version: 1,
      entries: [{ path: 'agent/agents.md', data: Buffer.from('imported-rule').toString('base64') }] });
    assert.match(JSON.stringify(run(1, 'config', 'import', bundle, '--app', app)), /文件已存在/);
    run(0, 'config', 'import', bundle, '--app', app, '--replace');
    assert.equal(readFileSync(rulePath, 'utf8'), 'imported-rule');
    assert.equal(existsSync(join(app, '.shadowbot-switch', 'AGENTS.md')), false);
    unlinkSync(rulePath);
    const missing = join(app, 'missing-target');
    mkdirSync(missing);
    symlinkSync(missing, rulePath, 'junction');
    rmdirSync(missing);
    assert.match(JSON.stringify(run(1, 'config', 'check', '--app', app)), /断链/);
    assert.match(JSON.stringify(run(1, 'doctor', '--app', app)), /断链/);
    assert.match(JSON.stringify(run(1, 'config', 'import', bundle, '--app', app, '--replace')), /目标文件是链接/);
    assert.equal(existsSync(join(app, '.shadowbot-switch', 'AGENTS.md')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('management CLI scopes resources, records choices, edits config, and exports/imports without running MCP', { timeout: 45_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'shadowbot-management-'));
  const home = join(root, 'state');
  const app = join(root, 'app');
  mkdirSync(app);
  const install = { runtimeRelease: 'a'.repeat(64), piVersion: '1.5.2', resources: join(root, 'Resources'), users: join(root, 'users') };
  put(join(home, 'install.json'), install);
  put(join(home, 'backend.json'), { mode: 'pi' });
  const env = { ...process.env, SHADOWBOT_PI_HOME: home, OPENCODE_CONFIG_CONTENT: '{}', OPENCODE_CONFIG: '', OPENCODE_CONFIG_DIR: '', XDG_CONFIG_HOME: '' };
  const run = (...args) => {
    const result = spawnSync(process.execPath, [control, ...args, '--json'], { env, cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return JSON.parse(result.stdout).data;
  };
  const failure = (...args) => {
    const result = spawnSync(process.execPath, [control, ...args, '--json'], { env, cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 1, result.stderr + result.stdout);
    return result;
  };
  try {
    const source = join(root, 'source');
    skill(source, 'fixture');
    assert.match(run('skills', 'add', source).message, /fixture/);
    assert.ok(run('skills').some(row => row.name === 'fixture' && row.status === 'enabled'));
    assert.equal(existsSync(join(install.resources, 'Copilot', 'commands', 'skill-fixture.md')), true);
    run('skills', 'disable', 'fixture');
    assert.equal(run('skills').find(row => row.name === 'fixture').status, 'disabled');
    assert.equal(existsSync(join(install.resources, 'Copilot', 'commands', 'skill-fixture.md')), false);
    run('skills', 'enable', 'fixture');
    skill(join(app, '.pi', 'skills', 'fixture'), 'fixture', 'app override');
    assert.equal(run('skills', '--app', app).find(row => row.status === 'enabled' && row.name === 'fixture').source, 'app');
    assert.equal(run('skills').find(row => row.status === 'enabled' && row.name === 'fixture').source, 'installation');
    run('apps', 'select', app);
    assert.equal(run('skills').find(row => row.status === 'enabled' && row.name === 'fixture').source, 'app');
    assert.equal(run('skills', '--global').find(row => row.status === 'enabled' && row.name === 'fixture').source, 'installation');
    run('apps', 'clear');

    const marker = join(root, 'must-not-start');
    run('mcp', 'add', 'offline', '--command', process.execPath, '--arg', '-e', '--arg', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`);
    assert.equal(run('mcp')[0].name, 'offline');
    assert.equal(existsSync(marker), false, 'mcp list must not start the configured process');
    run('mcp', 'disable', 'offline', '--app', app);
    assert.ok(existsSync(join(app, '.shadowbot-switch', 'mcp.json')), 'new application configuration must use the neutral directory');
    assert.equal(run('mcp', '--app', app)[0].state, '已禁用');
    assert.equal(run('mcp')[0].state, '已配置');
    failure('mcp', 'add', 'studio-mcp', '--url', 'http://127.0.0.1/mcp');
    assert.deepEqual(run('mcp', 'status'), []);
    const bundle = join(root, 'config.json');
    const appBundle = join(root, 'app-config.json');
    run('config', 'export', appBundle, '--app', app);
    assert.ok(JSON.parse(readFileSync(appBundle, 'utf8')).entries.some(entry => entry.path === 'agent/skills/fixture/SKILL.md'), 'exports must include existing legacy application skills');
    run('config', 'export', bundle);
    run('skills', 'remove', 'fixture');
    run('mcp', 'remove', 'offline');
    failure('config', 'import', bundle);
    run('config', 'import', bundle, '--replace');
    assert.ok(run('skills').some(row => row.name === 'fixture' && row.status === 'enabled'));
    assert.equal(run('mcp')[0].name, 'offline');
    const bad = join(root, 'bad.json');
    put(bad, { format: 'shadowbot-switch-config', version: 1, entries: [{ path: 'agent/../../escape', data: 'dGVzdA==' }] });
    failure('config', 'import', bad);
    assert.equal(existsSync(join(root, 'escape')), false);
    const checks = failure('doctor');
    const diagnostics = JSON.parse(checks.stdout).data;
    assert.ok(diagnostics.filter(row => row.status === '失败').length >= 3, 'doctor must collect independent failures');
    put(join(home, 'agent', 'AGENTS.md'), 'global-migration-rule');
    put(join(app, 'AGENTS.md'), 'app-migration-rule');
    const ruleBundle = join(root, 'rules.json');
    run('config', 'export', ruleBundle, '--app', app);
    const copiedApp = join(root, 'copied-app');
    mkdirSync(copiedApp);
    run('config', 'import', ruleBundle, '--app', copiedApp);
    assert.match(loadAgentRules(undefined, copiedApp).instructions, /app-migration-rule/);
    assert.ok(existsSync(join(copiedApp, '.shadowbot-switch', 'AGENTS.md')));
    const copiedBundle = join(root, 'copied-rules.json');
    run('config', 'export', copiedBundle, '--app', copiedApp);
    assert.ok(JSON.parse(readFileSync(copiedBundle, 'utf8')).entries.some(entry => entry.path === 'agent/AGENTS.md'));
    const globalRules = join(root, 'global-rules.json');
    run('config', 'export', globalRules, '--global');
    run('config', 'import', globalRules, '--app', copiedApp, '--replace');
    assert.match(loadAgentRules(undefined, copiedApp).instructions, /global-migration-rule/);
    failure('config', 'import', globalRules, '--app', app);
    run('config', 'import', globalRules, '--app', app, '--replace');
    assert.equal(readFileSync(join(app, 'AGENTS.md'), 'utf8'), 'global-migration-rule');
    writeFileSync(join(app, 'AGENTS.md'), Buffer.from([0xff]));
    const badRules = JSON.parse(failure('config', 'check', '--app', app).stdout).data;
    assert.ok(badRules.warnings.some(warning => /AGENTS.md.*UTF-8/.test(warning)));
    const ruleDiagnostics = JSON.parse(failure('doctor', '--app', app).stdout).data;
    assert.equal(ruleDiagnostics.find(row => row.check === 'AGENTS.md 规则').status, '失败');
    const reload = run('reload');
    assert.equal(reload.menu.added + reload.menu.updated + reload.menu.removed, 0);
    assert.equal(existsSync(join(home, 'reload.request')), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('skill inventory preserves official names, prefers app custom skills and explains disabled/invalid entries', () => {
  const root = mkdtempSync(join(tmpdir(), 'shadowbot-inventory-'));
  const home = join(root, 'state'), app = join(root, 'app'), agent = join(home, 'agent');
  const sources = skillSources(home, { runtimeRelease: 'b'.repeat(64), piVersion: '1.5.2', resources: join(root, 'resources') });
  try {
    skill(join(sources.bridge, 'official'), 'official');
    skill(join(home, 'skills', 'official'), 'official');
    skill(join(home, 'skills', 'overridden'), 'overridden');
    skill(join(app, '.pi', 'skills', 'overridden'), 'overridden');
    skill(join(agent, 'skills', 'legacy'), 'legacy');
    put(join(app, '.pi', 'skills', 'broken', 'SKILL.md'), '---\nname: broken\n---\nMissing description');
    const rows = skillInventory(agent, app, sources, { permission: { skill: { official: 'deny' } } });
    assert.equal(rows.find(r => r.name === 'official' && r.source === 'installation').status, 'shadowed');
    assert.equal(rows.find(r => r.name === 'overridden' && r.source === 'installation').status, 'shadowed');
    assert.equal(rows.find(r => r.name === 'overridden' && r.source === 'app').status, 'enabled');
    assert.equal(rows.find(r => r.name === 'legacy').status, 'disabled');
    assert.ok(rows.some(r => r.status === 'invalid' && r.path.includes('broken')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('runtime state distinguishes pending configuration and ignores stale process reports', () => {
  const root = mkdtempSync(join(tmpdir(), 'shadowbot-state-'));
  try {
    const revision = configurationRevision(root, root);
    publishRuntimeState(root, { root, active: 0, revision, mcp: {}, errors: {} });
    assert.equal(runtimeStates(root)[0].pending, false);
    put(join(root, 'agent', 'mcp.json'), { mcpServers: {} });
    assert.equal(runtimeStates(root)[0].pending, true);
    put(join(root, 'running', '99999999-aaa.json'), { pid: 99999999, root, updated: Date.now(), revision });
    assert.equal(runtimeStates(root).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('root help and status work from another directory before installation or with damaged metadata', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'shadowbot-root-cli-'));
  const script = join(root, 'switch.ps1');
  try {
    cpSync(resolve('switch.ps1'), script);
    const help = execFileSync('pwsh', ['-NoProfile', '-File', script, 'help'], { cwd: tmpdir(), encoding: 'utf8', windowsHide: true });
    assert.match(help, /use pi/);
    const status = () => JSON.parse(execFileSync('pwsh', ['-NoProfile', '-File', script, 'status', '--json'], { cwd: tmpdir(), encoding: 'utf8', windowsHide: true }));
    assert.equal(status().installed, false);
    put(join(root, '.shadowbot-switch', 'install.json'), '{');
    assert.match(status().next, /安装记录无法读取/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
