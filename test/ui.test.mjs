import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const script = read('ui/app.js');
const styles = read('ui/app.css');
const page = read('ui/index.html');
const server = read('scripts/ui-server.ps1');

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
