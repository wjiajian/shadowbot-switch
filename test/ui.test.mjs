import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const script = read('ui/app.js');
const styles = read('ui/app.css');
const page = read('ui/index.html');
const server = read('scripts/ui-server.ps1');

test('job requests follow the environment until the user selects a download source', async () => {
  const readMirror = /function readMirror\(\) \{[\s\S]+?\n}/.exec(script)[0];
  const startJob = /async function startJob\([^)]*\) \{[\s\S]+?\n}/.exec(script)[0];
  for (const saved of [null, '', 'invalid', 'direct', 'aliyun']) {
    const requests = [];
    const context = vm.createContext({
      localStorage: { getItem: () => saved }, state: { base: { installed: true } },
      jobRunning: () => false, api: async (_, body) => { requests.push(body); return { id: 1 }; },
      newJob() {}, setPage() {}, pollJob() {},
    });
    vm.runInContext(`${readMirror}\n${startJob}\nstate.mirror = readMirror()`, context);
    for (const cmd of ['use', 'update', 'repair']) {
      await vm.runInContext(`startJob('${cmd}')`, context);
      const body = requests.pop();
      if (saved === 'direct' || saved === 'aliyun') assert.equal(body.mirror, saved);
      else assert.ok(!Object.hasOwn(body, 'mirror'));
    }
  }
});

test('completed tasks keep logs in the task panel and show only a short success notice', async () => {
  const finish = /async function finishJob\(job\) \{[\s\S]+?\n}/.exec(script)[0];
  const section = /function taskSection\(\) \{[\s\S]+?\n}/.exec(script)[0];
  for (const outcome of [{ exitCode: 0, stopped: false }, { exitCode: 1, stopped: false }, { exitCode: 1, stopped: true }]) {
    const job = { ...outcome, title: '更新 Test Harness', lines: ['<Objs>' + 'log'.repeat(10000) + '</Objs>'], steps: [], done: true, collapsed: false };
    const notices = [];
    const state = { job, page: 'harness' };
    const context = vm.createContext({ state, job, toast: message => notices.push(message), refreshBase: async () => {}, resetData() {}, render() {}, ensureData: async () => {}, loadCounts() {},
      h: (tag, props, ...children) => ({ tag, props, children: children.flat(Infinity).filter(Boolean) }), icon: () => ({ classList: { add() {} } }),
    });
    await vm.runInContext(`${finish}\nfinishJob(job)`, context);
    assert.equal(state.job, job, 'logs must remain available in the task panel');
    if (outcome.exitCode === 0) {
      assert.deepEqual(notices, ['更新 Test Harness已完成。']);
      assert.equal(job.collapsed, true);
      const nodes = tree => [tree, ...(tree.children || []).flatMap(nodes)];
      const panel = vm.runInContext(`${section}\ntaskSection()`, context);
      nodes(panel).find(node => node.props?.['aria-label'] === '展开任务日志').props.onclick();
      assert.equal(job.collapsed, false, 'completed logs must still be expandable');
      const expanded = vm.runInContext('taskSection()', context);
      assert.deepEqual(nodes(expanded).find(node => node.tag === 'pre').children, job.lines);
      nodes(expanded).find(node => node.props?.['aria-label'] === '关闭任务').props.onclick();
      assert.equal(state.job, null, 'completed task can be dismissed');
    } else {
      assert.deepEqual(notices, [], 'failed or cancelled tasks must not announce success');
      assert.equal(job.collapsed, false);
    }
  }
});

test('page code renders third-party text only through DOM text nodes', () => {
  for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', "setAttribute('style'", 'style:']) {
    assert.ok(!script.includes(sink), `app.js must not use ${sink}`);
  }
  assert.ok(!/<script>|\son\w+=|style=/.test(page), 'index.html must not carry inline script, handlers or styles');
});

test('page loads nothing from the network', () => {
  for (const [name, text] of [['app.js', script], ['app.css', styles], ['index.html', page]]) {
    // The SVG namespace and the MCP address placeholder are text, not requests.
    const urls = (text.match(/https?:\/\/[^\s'")]+/g) || []).filter(url => !['http://www.w3.org/2000/svg', 'https://example.com/mcp'].includes(url));
    assert.deepEqual(urls, [], `${name} must stay offline`);
  }
  assert.ok(!/@import|url\(/.test(styles), 'app.css must not pull in fonts or images');
});

test('server policy keeps scripts and styles same-origin', () => {
  const policy = /\$script:UiPolicy = "([^"]+)"/.exec(server)[1];
  for (const part of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'self'", "frame-ancestors 'none'"]) assert.ok(policy.includes(part), part);
  assert.ok(!policy.includes('unsafe'), 'policy must not allow unsafe sources');
  for (const [, file] of server.matchAll(/'\/[\w.]*' = @\('([\w.]+)'/g)) assert.ok(fs.existsSync(new URL(`../ui/${file}`, import.meta.url)), `ui/${file} is served but missing`);
});

test('every endpoint and command the page uses is handled by the server', () => {
  const endpoints = new Set([...server.matchAll(/'(\/api\/[\w/-]+)' \{/g)].map(match => match[1]));
  endpoints.add('/api/bye');
  const used = new Set([...script.matchAll(/'(\/api\/[\w/-]+)'/g)].map(match => match[1]));
  assert.ok(used.size >= 8);
  for (const path of used) assert.ok(endpoints.has(path), `${path} has no server handler`);

  const whitelist = /function ConvertTo-UiCommand[\s\S]+?\n}\n/.exec(server)[0];
  const commands = new Set([...whitelist.matchAll(/'([a-z]+(?:\.[a-z]+)?)'/g)].map(match => match[1]));
  const runs = [...script.matchAll(/run\('([a-z.]+)'/g), ...script.matchAll(/run\(enable \? '([a-z.]+)' : '([a-z.]+)'/g)].flatMap(match => match.slice(1));
  assert.ok(runs.length >= 10);
  for (const command of runs) assert.ok(commands.has(command), `${command} is not whitelisted`);

  const jobs = /function ConvertTo-UiJobArguments[\s\S]+?\n}\n/.exec(server)[0];
  for (const [, job] of script.matchAll(/startJob\('(\w+)'/g)) assert.ok(jobs.includes(`'${job}' {`), `${job} is not a server task`);
});

test('page checks names with the same rules as the CLI', () => {
  const skill = /const SKILL_NAME = (\/.+\/);/.exec(script)[1];
  const mcp = /const MCP_NAME = (\/.+\/);/.exec(script)[1];
  assert.equal(skill, `/${/\$script:UiSkillPattern = '([^']+)'/.exec(server)[1]}/`);
  assert.equal(mcp, `/${/\$script:UiMcpPattern = '([^']+)'/.exec(server)[1]}/`);
  assert.ok(read('src/management.ts').includes(skill), 'skill rule drifted from management.ts');
});

test('npm name validation matches PowerShell registration', async () => {
  const { NPM_PACKAGE_NAME } = await import('../dist/service/harnesses.js');
  const [, pattern] = /\$script:NpmPackagePattern = '([^']+)'/.exec(read('scripts/harnesses.ps1'));
  assert.equal(NPM_PACKAGE_NAME.source, new RegExp(pattern).source);
});

test('checks, local rebuilds and uninstall send their requested options', async () => {
  const functions = ['startJob', 'checkUpdates', 'jobSteps', 'harnessColumn'].map(name =>
    new RegExp('(?:async )?function ' + name + '\\([^)]*\\) \\{[\\s\\S]+?\\n}').exec(script)[0]).join('\n');
  const calls = [];
  const spec = { kind: 'managed', installed: true, selected: true, upstreamCapable: true, version: '1.6.0',
    pinnedVersion: '1.5.2', availableVersion: '1.6.0', dependencySource: 'upstream', updateStatus: 'current' };
  const context = vm.createContext({ spec, state: { base: { installed: true } }, jobRunning: () => false,
    withBusy: (_, fn) => fn(), refreshBase() {}, toast() {}, newJob() {}, setPage() {}, pollJob() {},
    h: (_, props, ...children) => children.flat(Infinity).filter(Boolean).join(' '), capability() {}, button: label => label,
    api: async (path, body) => { calls.push([path, JSON.parse(JSON.stringify(body))]); return { id: 1, items: {} }; } });
  vm.runInContext(functions, context);
  const run = code => vm.runInContext(code, context);
  await run('checkUpdates()');
  await run("state.mirror = 'aliyun'; checkUpdates()");
  await run("startJob('update','fixture',{localOnly:true})");
  await run("startJob('uninstall',null,{purgeData:true})");
  assert.deepEqual(calls, [
    ['/api/updates/check', {}], ['/api/updates/check', { mirror: 'aliyun' }],
    ['/api/jobs/start', { cmd: 'update', mirror: 'aliyun', harness: 'fixture', localOnly: true }],
    ['/api/jobs/start', { cmd: 'uninstall', purgeData: true }],
  ]);
  assert.equal(run("jobSteps('update',spec)[0].label"), '检查上游版本');
  assert.equal(run("jobSteps('update',spec,{localOnly:true})[0].label"), '构建运行时');
  assert.equal(run("jobSteps('update',{...spec,upstreamCapable:false})[0].label"), '构建运行时');
  assert.match(run('harnessColumn(spec)'), /1.6.0 · 上游版本.*仓库锁定 1.5.2.*与本地构建一致/);
  assert.match(run("harnessColumn({...spec,upstream:{candidate:'1.6.3'}})"), /更新到 1.6.3/);
  assert.match(run("harnessColumn({...spec,upstream:{status:'error'}})"), /仅本地重建/);
});

test('only versions below the minimum trigger the host version warning', () => {
  const comparison = /const MIN_SHADOWBOT = [\s\S]+?\n}/.exec(script)[0];
  for (const [version, expected] of [['6.4.0', false], ['6.3.39', false], ['6.3.0', true]]) {
    assert.equal(vm.runInNewContext(comparison + '\nbelowMinimum(version)', { version }), expected);
  }
});
