// ShadowBot Switch UI. It talks only to the local ui.ps1 service. Skill text, MCP settings
// and command output come from third parties, so every value is shown through text nodes.
'use strict';

const ICONS = {
  'file-text': 'M56 24h99l53 53v139a16 16 0 0 1-16 16H56a16 16 0 0 1-16-16V40a16 16 0 0 1 16-16Zm0 16v176h136V88h-48V40Zm104 11v21h21ZM80 120h88v16H80Zm0 40h72v16H80Z',
  gear: 'M108 24h40l6 24 22 12 24-7 20 35-17 18v31l17 19-20 35-25-7-21 12-6 25h-40l-6-25-21-12-25 7-20-35 17-19v-31L36 88l20-35 24 7 22-12Zm12 16-5 19-32 19-20-6-8 14 14 15v43l-14 15 8 14 20-6 32 19 5 20h16l5-20 32-19 20 6 8-14-14-15v-43l14-15-8-14-20 6-32-19-5-19Zm8 42a40 40 0 1 1 0 80 40 40 0 1 1 0-80Zm0 16a24 24 0 1 0 0 48 24 24 0 1 0 0-48Z',
  harness: 'M213.66,181.66l-32,32a8,8,0,0,1-11.32-11.32L188.69,184H48a8,8,0,0,1,0-16H188.69l-18.35-18.34a8,8,0,0,1,11.32-11.32l32,32A8,8,0,0,1,213.66,181.66Zm-139.32-64a8,8,0,0,0,11.32-11.32L67.31,88H208a8,8,0,0,0,0-16H67.31L85.66,53.66A8,8,0,0,0,74.34,42.34l-32,32a8,8,0,0,0,0,11.32Z',
  puzzle: 'M220.27,158.54a8,8,0,0,0-7.7-.46,20,20,0,1,1,0-36.16A8,8,0,0,0,224,114.69V72a16,16,0,0,0-16-16H171.78a35.36,35.36,0,0,0,.22-4,36.11,36.11,0,0,0-11.36-26.24,36,36,0,0,0-60.55,23.62,36.56,36.56,0,0,0,.14,6.62H64A16,16,0,0,0,48,72v32.22a35.36,35.36,0,0,0-4-.22,36.12,36.12,0,0,0-26.24,11.36,35.7,35.7,0,0,0-9.69,27,36.08,36.08,0,0,0,33.31,33.6,35.68,35.68,0,0,0,6.62-.14V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V165.31A8,8,0,0,0,220.27,158.54ZM208,208H64V165.31a8,8,0,0,0-11.43-7.23,20,20,0,1,1,0-36.16A8,8,0,0,0,64,114.69V72h46.69a8,8,0,0,0,7.23-11.43,20,20,0,1,1,36.16,0A8,8,0,0,0,161.31,72H208v32.23a35.68,35.68,0,0,0-6.62-.14A36,36,0,0,0,204,176a35.36,35.36,0,0,0,4-.22Z',
  plug: 'M237.66,66.34a8,8,0,0,0-11.32,0L192,100.69,155.31,64l34.35-34.34a8,8,0,1,0-11.32-11.32L144,52.69,117.66,26.34a8,8,0,0,0-11.32,11.32L112.69,44l-53,53a40,40,0,0,0,0,56.57l15.71,15.71L26.34,218.34a8,8,0,0,0,11.32,11.32l49.09-49.09,15.71,15.71a40,40,0,0,0,56.57,0l53-53,6.34,6.35a8,8,0,0,0,11.32-11.32L203.31,112l34.35-34.34A8,8,0,0,0,237.66,66.34ZM147.72,185a24,24,0,0,1-33.95,0L71,142.23a24,24,0,0,1,0-33.95l53-53L200.69,132Z',
  pulse: 'M240,128a8,8,0,0,1-8,8H204.94l-37.78,75.58A8,8,0,0,1,160,216h-.4a8,8,0,0,1-7.08-5.14L95.35,60.76,63.28,131.31A8,8,0,0,1,56,136H24a8,8,0,0,1,0-16H50.85L88.72,36.69a8,8,0,0,1,14.76.46l57.51,151,31.85-63.71A8,8,0,0,1,200,120h32A8,8,0,0,1,240,128Z',
  refresh: 'M240,56v48a8,8,0,0,1-8,8H184a8,8,0,0,1,0-16H211.4L184.81,71.64l-.25-.24a80,80,0,1,0-1.67,114.78,8,8,0,0,1,11,11.63A95.44,95.44,0,0,1,128,224h-1.32A96,96,0,1,1,195.75,60L224,85.8V56a8,8,0,1,1,16,0Z',
  plus: 'M224,128a8,8,0,0,1-8,8H136v80a8,8,0,0,1-16,0V136H40a8,8,0,0,1,0-16h80V40a8,8,0,0,1,16,0v80h80A8,8,0,0,1,224,128Z',
  search: 'M229.66,218.34l-50.07-50.06a88.11,88.11,0,1,0-11.31,11.31l50.06,50.07a8,8,0,0,0,11.32-11.32ZM40,112a72,72,0,1,1,72,72A72.08,72.08,0,0,1,40,112Z',
  folder: 'M245,110.64A16,16,0,0,0,232,104H216V88a16,16,0,0,0-16-16H130.67L102.94,51.2a16.14,16.14,0,0,0-9.6-3.2H40A16,16,0,0,0,24,64V208h0a8,8,0,0,0,8,8H211.1a8,8,0,0,0,7.59-5.47l28.49-85.47A16.05,16.05,0,0,0,245,110.64ZM93.34,64,123.2,86.4A8,8,0,0,0,128,88h72v16H69.77a16,16,0,0,0-15.18,10.94L40,158.7V64Zm112,136H43.1l26.67-80H232Z',
  trash: 'M216,48H176V40a24,24,0,0,0-24-24H104A24,24,0,0,0,80,40v8H40a8,8,0,0,0,0,16h8V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V64h8a8,8,0,0,0,0-16ZM96,40a8,8,0,0,1,8-8h48a8,8,0,0,1,8,8v8H96Zm96,168H64V64H192ZM112,104v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Zm48,0v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Z',
  caret: 'M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z',
  check: 'M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z',
  x: 'M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z',
  warning: 'M236.8,188.09,149.35,36.22h0a24.76,24.76,0,0,0-42.7,0L19.2,188.09a23.51,23.51,0,0,0,0,23.72A24.35,24.35,0,0,0,40.55,224h174.9a24.35,24.35,0,0,0,21.33-12.19A23.51,23.51,0,0,0,236.8,188.09ZM222.93,203.8a8.5,8.5,0,0,1-7.48,4.2H40.55a8.5,8.5,0,0,1-7.48-4.2,7.59,7.59,0,0,1,0-7.72L120.52,44.21a8.75,8.75,0,0,1,15,0l87.45,151.87A7.59,7.59,0,0,1,222.93,203.8ZM120,144V104a8,8,0,0,1,16,0v40a8,8,0,0,1-16,0Zm20,36a12,12,0,1,1-12-12A12,12,0,0,1,140,180Z',
  clock: 'M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm64-88a8,8,0,0,1-8,8H128a8,8,0,0,1-8-8V72a8,8,0,0,1,16,0v48h48A8,8,0,0,1,192,128Z',
  circle: 'M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Z',
};

const PAGES = ['harness', 'skills', 'mcp', 'rules', 'config', 'doctor'];
const TOKEN_KEY = 'shadowbot-switch-token';
const MIN_SHADOWBOT = '6.3.39';
function belowMinimum(version) {
  if (!/^\d+(?:\.\d+)+$/.test(version)) return false;
  const parts = version.split('.').map(Number);
  const minimum = MIN_SHADOWBOT.split('.').map(Number);
  for (let i = 0; i < minimum.length; i++) {
    const value = parts[i] ?? 0;
    if (value !== minimum[i]) return value < minimum[i];
  }
  return false;
}
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MCP_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const SOURCES = { installation: '安装级', app: '应用级', official: '影刀内置', legacy: '旧目录' };
const SKILL_STATUS = {
  enabled: ['已启用', 'ok'], disabled: ['已禁用', 'muted'], shadowed: ['被同名覆盖', 'warn'],
  invalid: ['格式错误', 'bad'], warning: ['可加载但有提示', 'warn'],
};
const PERMISSIONS = [['ask', '询问'], ['allow', '允许'], ['deny', '拒绝']];
const RULES_LINE = /^(.+AGENTS\.md)：/i;

const CONFIG_TABS = [['settings', '权限与功能'], ['transfer', '导入导出'], ['backups', '备份'], ['apps', '应用']];
function editorState() {
  return {
    rules: { layers: null, active: 'application', drafts: {}, conflict: null, ticket: 0 },
    settings: { data: null, form: null, dirty: false, conflict: null, ticket: 0 },
    transfer: { stage: null, plan: null, source: 'file', text: '', replace: false, error: null },
    backups: { items: null, total: 0, expanded: null, ticket: 0 },
    runtime: { apps: null, ticket: 0 }, log: { entries: null, total: 0, skipped: 0, ticket: 0 },
  };
}

const state = {
  ...editorState(),
  tab: 'settings',
  token: takeToken(),
  mirror: readMirror(),
  fatal: null,
  offline: null,
  page: null,
  base: null,
  apps: [],
  appsError: null,
  scope: '',
  dirOverride: '',
  editingDir: false,
  skills: { rows: null, error: null, loading: false, ticket: 0, filter: 'all', query: '' },
  mcp: { rows: null, runtime: [], tests: {}, error: null, loading: false, ticket: 0 },
  doctor: { rows: null, error: null, loading: false, ticket: 0 },
  job: null,
  confirm: null,
  focusNext: null,
  busy: new Set(),
};

// ---------------------------------------------------------------- helpers

function readMirror() {
  try {
    const saved = localStorage.getItem('shadowbot-switch-mirror');
    return ['direct', 'aliyun'].includes(saved) ? saved : '';
  } catch { return ''; }
}

function takeToken() {
  const hash = location.hash.slice(1);
  if (/^[0-9a-f]{64}$/.test(hash)) {
    try { sessionStorage.setItem(TOKEN_KEY, hash); } catch { /* kept in memory only */ }
    history.replaceState(null, '', location.pathname);
    return hash;
  }
  try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  let value;
  for (const [key, item] of Object.entries(props || {})) {
    if (item === undefined || item === null || item === false) continue;
    if (key === 'class') el.className = item;
    else if (key === 'value') value = item;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), item);
    else el.setAttribute(key, item === true ? '' : String(item));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  if (value !== undefined) el.value = value;
  return el;
}

function icon(name, size = 20, label = null, tone = null) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('viewBox', '0 0 256 256');
  svg.setAttribute('fill', 'currentColor');
  if (label) { svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', label); }
  else svg.setAttribute('aria-hidden', 'true');
  if (tone) svg.setAttribute('class', tone);
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

function button(text, className, onclick, extra = {}) {
  return h('button', { type: 'button', class: `btn ${className}`, onclick, ...extra }, text);
}

const ready = () => Boolean(state.base && state.base.ready);
const jobRunning = () => Boolean(state.job && !state.job.done);
const isBusy = key => state.busy.has(key);
const scopeLabel = () => state.scope || '此安装的全部应用';
const clock = seconds => {
  const total = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

async function withBusy(key, task) {
  if (state.busy.has(key)) return undefined;
  state.busy.add(key);
  render();
  try { return await task(); }
  finally { state.busy.delete(key); render(); }
}

function toast(message, kind = 'ok') {
  const box = document.getElementById('toasts');
  const close = h('button', { type: 'button', class: 'icon-btn', 'aria-label': '关闭提示' }, icon('x', 16));
  const item = h('div', { class: 'toast', role: kind === 'ok' ? null : 'alert' },
    icon(kind === 'ok' ? 'check' : 'warning', 16, null, kind === 'ok' ? 'ok' : 'bad'),
    h('div', { class: 'toast-text' }, message), close);
  const remove = () => item.remove();
  close.addEventListener('click', remove);
  box.append(item);
  setTimeout(remove, kind === 'ok' ? 5000 : 10000);
  while (box.children.length > 4) box.firstElementChild.remove();
}

// A management result: message plus when it takes effect.
function announce(data) {
  if (!data) return;
  toast([data.message, data.next].filter(Boolean).join('\n') || '已保存。');
}

// ---------------------------------------------------------------- service calls

async function api(path, body = {}) {
  return apiText(path, JSON.stringify(body));
}

async function apiText(path, text, keepalive = false) {
  let response;
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Token': state.token },
      body: text, keepalive,
    });
  } catch {
    throw new Error('连不上界面服务，它可能已经退出。请重新运行 ui.ps1。');
  }
  let data = null;
  try { data = await response.json(); } catch { /* handled below */ }
  if (!response.ok || !data || data.error) throw new Error(data && data.error ? data.error : `界面服务没有正常响应（${response.status}）。`);
  return data;
}

// Runs one whitelisted management command and unwraps its { scope, data } result.
async function run(cmd, extra = {}, scoped = true) {
  const body = { cmd, ...extra };
  if (scoped && state.scope) body.app = state.scope;
  return unwrap(await api('/api/run', body));
}

function unwrap(result) {
  const text = (result.stdout || '').trim();
  let parsed = null;
  if (text) { try { parsed = JSON.parse(text); } catch { /* not JSON */ } }
  if (parsed && parsed.error) throw Object.assign(new Error(parsed.error), { code: parsed.code });
  if (!parsed || !Object.hasOwn(parsed, 'data')) throw new Error((result.stderr || text).trim() || `命令没有返回结果（退出码 ${result.exitCode}）。`);
  return { data: parsed.data, exitCode: result.exitCode };
}

async function refreshBase() {
  const body = state.dirOverride && !(state.base && state.base.installed) ? { shadowbotDir: state.dirOverride } : {};
  const wasReady = ready();
  state.base = await api('/api/state', body);
  if (!ready() && state.page !== 'harness') setPage('harness');
  if (ready() && !wasReady) loadApps();
  render();
}

async function loadApps() {
  try { state.apps = (await run('apps', {}, false)).data || []; state.appsError = null; }
  catch (error) { state.appsError = error.message; }
  render();
}

async function load(section, task) {
  const box = state[section];
  const ticket = ++box.ticket;
  box.loading = true;
  box.error = null;
  render();
  try {
    const value = await task();
    if (ticket === box.ticket) Object.assign(box, value);
  } catch (error) {
    if (ticket === box.ticket) box.error = error.message;
  } finally {
    if (ticket === box.ticket) { box.loading = false; render(); }
  }
}

const loadSkills = () => load('skills', async () => ({ rows: (await run('skills.list')).data || [] }));
const loadDoctor = () => load('doctor', async () => ({ rows: (await run('doctor')).data || [] }));
const loadMcp = () => load('mcp', async () => {
  const rows = (await run('mcp.list')).data || [];
  let runtime = [];
  try { runtime = (await run('mcp.status')).data || []; } catch { /* runtime state is optional */ }
  return { rows, runtime };
});

function resetData(discardDrafts = false) {
  const fresh = editorState();
  if (!discardDrafts) {
    fresh.rules.drafts = Object.fromEntries(Object.entries(state.rules.drafts).filter(([, draft]) => draft.dirty));
    if (state.settings.dirty) fresh.settings = state.settings;
  }
  discardTransfer();
  Object.assign(state, fresh);
  for (const key of ['skills', 'mcp', 'doctor']) {
    const box = state[key];
    box.ticket++;
    box.rows = null;
    box.error = null;
    box.loading = false;
  }
  state.mcp.tests = {};
  state.confirm = null;
}

async function ensureData(page) {
  if (!ready()) return;
  const needs = (box, key) => !box[key] && !box.loading && !box.error;
  if (page === 'config') {
    if (state.tab === 'settings' && needs(state.settings, 'data')) await loadSettings();
    if (state.tab === 'backups' && needs(state.backups, 'items')) await loadBackups();
    if (state.tab === 'apps') await loadApps();
    return;
  }
  if (page === 'doctor') {
    await Promise.all([needs(state.doctor, 'rows') && loadDoctor(), needs(state.runtime, 'apps') && loadRuntime(), needs(state.log, 'entries') && loadLog()]);
    return;
  }
  if (page === 'rules' && needs(state.rules, 'layers')) await loadRules();
  if (page === 'skills' && needs(state.skills, 'rows')) await loadSkills();
  if (page === 'mcp' && needs(state.mcp, 'rows')) await loadMcp();
}

// Fills the sidebar counts after the visible page has its data.
async function loadCounts() {
  if (!ready()) return;
  if (!state.skills.rows && !state.skills.loading) await loadSkills();
  if (!state.mcp.rows && !state.mcp.loading) await loadMcp();
}

// ---------------------------------------------------------------- navigation

function pageFromHash() {
  const match = /^#\/(\w+)(?:\/(\w+))?$/.exec(location.hash);
  if (!match || !PAGES.includes(match[1])) return null;
  return match[1] === 'config' && CONFIG_TABS.some(([tab]) => tab === match[2]) ? `config/${match[2]}` : match[1];
}

function setPage(page) {
  const target = page !== 'harness' && !ready() ? 'harness' : page;
  if (location.hash !== `#/${target}`) history.replaceState(null, '', `#/${target}`);
  const [name, tab = 'settings'] = target.split('/');
  if (state.page === 'config' && state.tab === 'transfer' && (name !== 'config' || tab !== 'transfer')) {
    discardTransfer();
    state.transfer = editorState().transfer;
  }
  state.page = name;
  state.tab = tab;
  state.confirm = null;
  render();
  ensureData(state.page);
}

window.addEventListener('hashchange', () => {
  const page = pageFromHash();
  if (page) setPage(page);
});

function hasDrafts() {
  return state.settings.dirty || Object.values(state.rules.drafts).some(draft => draft.dirty);
}

window.addEventListener('beforeunload', event => {
  if (hasDrafts()) { event.preventDefault(); event.returnValue = ''; }
});

function changeScope(value, confirmed = false) {
  if (state.scope === value || isBusy('config-write')) return;
  if (hasDrafts() && !confirmed) {
    render();
    confirmDialog('切换范围', '有未保存的修改，切换范围会丢弃。', '丢弃并切换', () => changeScope(value, true));
    return;
  }
  state.scope = value;
  resetData(true);
  render();
  ensureData(state.page).then(loadCounts);
}

// ---------------------------------------------------------------- actions

function reloadConfig() {
  withBusy('reload', async () => {
    try {
      const { data } = await run('reload', {}, false);
      // reload's own hints name CLI commands, so the page words the result itself.
      const running = Array.isArray(data.applications) && data.applications.length > 0;
      const menu = data.menu || {};
      const lines = ['已刷新配置。', running ? '正在运行的影刀会在下一次请求时读取。' : '下次打开 Copilot 时读取。'];
      if ((menu.added || 0) + (menu.updated || 0) + (menu.removed || 0) > 0) lines.push(data.menuHint);
      toast(lines.filter(Boolean).join('\n'));
      resetData();
      await ensureData(state.page);
      loadCounts();
    } catch (error) { toast(error.message, 'error'); }
  });
}

function toggleSkill(row) {
  const enable = row.status === 'disabled';
  withBusy(`skill:${row.name}`, async () => {
    try {
      announce((await run(enable ? 'skills.enable' : 'skills.disable', { name: row.name })).data);
      await loadSkills();
    } catch (error) { toast(error.message, 'error'); }
  });
}

function removeSkill(row) {
  state.confirm = null;
  withBusy(`skill:${row.name}`, async () => {
    try {
      announce((await run('skills.remove', { name: row.name })).data);
      await loadSkills();
    } catch (error) { toast(error.message, 'error'); }
  });
}

function toggleMcp(row) {
  const enable = row.state === '已禁用';
  withBusy(`mcp:${row.name}`, async () => {
    try {
      announce((await run(enable ? 'mcp.enable' : 'mcp.disable', { name: row.name })).data);
      delete state.mcp.tests[row.name];
      await loadMcp();
    } catch (error) { toast(error.message, 'error'); }
  });
}

function removeMcp(row) {
  state.confirm = null;
  withBusy(`mcp:${row.name}`, async () => {
    try {
      announce((await run('mcp.remove', { name: row.name })).data);
      delete state.mcp.tests[row.name];
      await loadMcp();
    } catch (error) { toast(error.message, 'error'); }
  });
}

function testMcp(row) {
  withBusy(`test:${row.name}`, async () => {
    try {
      const { data } = await run('mcp.test', { name: row.name });
      const result = (data || []).find(item => item.name === row.name);
      if (result) state.mcp.tests[row.name] = result;
      else toast('没有拿到这个 MCP 的检查结果。', 'error');
    } catch (error) { toast(error.message, 'error'); }
  });
}

function openConfig(target) {
  withBusy(`config:${target}`, async () => {
    try {
      const { data } = await run('config.open', { target });
      toast(`已用记事本打开 ${data.path}\n保存后点“刷新配置”。`);
    } catch (error) { toast(error.message, 'error'); }
  });
}

async function openPath(kind, path) {
  try { await api('/api/open', { kind, path }); } catch (error) { toast(error.message, 'error'); }
}

async function saveShadowBotDir(value) {
  const text = value.trim();
  if (!text) { toast('请填写影刀安装目录。', 'error'); return; }
  const previous = state.dirOverride;
  state.dirOverride = text;
  try {
    await refreshBase();
    state.editingDir = false;
    state.focusNext = 'shadowbot-dir-edit';
    render();
  } catch (error) {
    state.dirOverride = previous;
    toast(error.message, 'error');
  }
}

// ---------------------------------------------------------------- long tasks

function jobSteps(cmd, target, options = {}) {
  if (cmd === 'repair' || !target) return [];
  const managed = target.kind === 'managed';
  const steps = [];
  if (cmd === 'update' && target.upstreamCapable && !options.localOnly) steps.push({ label: '检查上游版本', match: /检查上游版本/ });
  if (managed && (cmd === 'update' || !target.installed)) steps.push({ label: '构建运行时', match: /准备构建工具|解析依赖版本|构建运行时|正在(安装|更新)/ });
  steps.push({ label: '等待影刀退出', match: /需要先退出影刀|正在等待影刀退出/ });
  if (managed) steps.push({ label: '检查安装', match: /检查安装/ });
  steps.push({ label: cmd === 'update' ? '启用新版本' : '切换后端', match: /切换后端|启用新版本/ });
  return steps;
}

function jobTitle(cmd, target) {
  if (cmd === 'uninstall') return '卸载 ShadowBot Switch';
  if (cmd === 'repair' || !target) return '修复安装';
  if (cmd === 'update') return `更新 ${target.name}`;
  return target.installed ? `切换到 ${target.name}` : `安装并切换到 ${target.name}`;
}

function jobVerb(cmd, target) {
  if (cmd === 'uninstall') return '卸载中';
  if (cmd === 'repair' || !target) return '修复中';
  if (cmd === 'update') return '更新中';
  return target.installed ? '切换中' : '安装中';
}

function newJob(id, cmd, harnessId, options = {}) {
  const target = state.base.harnesses.find(item => item.id === harnessId) || null;
  return {
    id, cmd, harness: harnessId || '', title: jobTitle(cmd, target), verb: jobVerb(cmd, target), steps: jobSteps(cmd, target, options),
    lines: [], cursor: 0, reached: -1, done: false, exitCode: null, stopped: false,
    startedAt: Date.now(), waiting: false, waitStartedAt: 0, waitSeconds: 0, collapsed: false, pollError: null,
  };
}

async function startJob(cmd, harnessId, options = {}) {
  if (jobRunning()) return;
  const body = { cmd };
  if (state.mirror && ['use', 'update', 'repair'].includes(cmd)) body.mirror = state.mirror;
  if (cmd === 'uninstall') body.purgeData = Boolean(options.purgeData);
  if (cmd === 'update' && options.localOnly) body.localOnly = true;
  if (harnessId) body.harness = harnessId;
  // Before installing, pass the directory shown on the page. With several ShadowBot copies the
  // background task cannot ask which one, so it must never guess on its own.
  if (!state.base.installed) {
    const directory = state.dirOverride || state.base.shadowbot.directory;
    if (directory) body.shadowbotDir = directory;
  }
  try {
    const { id } = await api('/api/jobs/start', body);
    state.job = newJob(id, cmd, harnessId, options);
    state.editingDir = false;
    setPage('harness');
    pollJob();
  } catch (error) { toast(error.message, 'error'); }
}

function absorbLine(job, line) {
  job.lines.push(line);
  const wait = /正在等待影刀退出（最多 (\d+) 秒）/.exec(line);
  if (wait) {
    job.waitStartedAt = Date.now();
    job.waitSeconds = Number(wait[1]);
  }
  job.steps.forEach((step, index) => { if (step.match.test(line)) job.reached = Math.max(job.reached, index); });
}

async function pollJob() {
  const job = state.job;
  if (!job || job.done || job.polling) return;
  job.polling = true;
  try {
    const progress = await api('/api/jobs/poll', { id: job.id, since: job.cursor });
    if (state.job !== job) return;
    if (job.cursor === 0) job.startedAt = Date.now() - progress.elapsed * 1000;
    for (const line of progress.lines) absorbLine(job, line);
    job.cursor = progress.cursor;
    job.waiting = progress.waiting;
    job.pollError = null;
    if (progress.done) {
      job.done = true;
      job.exitCode = progress.exitCode;
      job.stopped = progress.stopped;
      job.waiting = false;
      finishJob(job);
    }
    render();
  } catch (error) {
    job.pollError = error.message;
    render();
  } finally {
    job.polling = false;
    if (state.job === job && !job.done) setTimeout(pollJob, 800);
  }
}

async function finishJob(job) {
  if (job.exitCode === 0 && !job.stopped) {
    toast(`${job.title}已完成。`);
    job.collapsed = true;
  }
  try { await refreshBase(); } catch (error) { toast(error.message, 'error'); }
  resetData();
  render();
  await ensureData(state.page);
  loadCounts();
}

function stopJob() {
  const job = state.job;
  if (!job) return;
  withBusy('stop', async () => {
    try {
      const result = await api('/api/jobs/stop', { id: job.id });
      if (!result.accepted) toast('等待已结束，当前任务会继续执行。');
      await pollJob();
    } catch (error) { toast(error.message, 'error'); }
  });
}

// ---------------------------------------------------------------- shared views

function problemBlock(message, retry) {
  return h('div', { class: 'problem', role: 'alert' },
    icon('warning', 20, null, 'warn'),
    h('span', null, message),
    retry ? button('重试', 'btn-secondary', retry) : null);
}

function scopeSelect() {
  const options = [['', '此安装的全部应用'], ...state.apps.filter(app => app.exists !== false).map(app => [app.path, app.path])];
  if (state.scope && !options.some(([value]) => value === state.scope)) options.push([state.scope, state.scope]);
  return h('div', { class: 'scope' },
    h('label', { for: 'scope' }, '范围'),
    h('span', { class: 'select-field' },
      h('select', { class: 'field', id: 'scope', disabled: isBusy('config-write'), value: state.scope, onchange: event => changeScope(event.target.value) },
        options.map(([value, label]) => h('option', { value }, label))), icon('caret', 16)),
    button(icon('plus', 16), 'icon-btn', openAppDialog, { 'aria-label': '手动添加应用路径', disabled: jobRunning() || isBusy('config-write') }));
}

function toggleButton({ id, pressed, label, disabled, title, onclick }) {
  return h('button', { type: 'button', class: 'toggle', id, 'aria-pressed': String(pressed), 'aria-label': label, disabled, title, onclick },
    h('span', { class: 'track' }, h('span', { class: 'knob' })));
}

// Inline confirmation replaces the row actions; focus moves with it so keyboard users stay in place.
function askConfirm(key) {
  state.confirm = key;
  state.focusNext = `${key}-confirm`;
  render();
}

function confirmCell(key, text, label, onconfirm) {
  return h('div', { class: 'row-confirm' },
    h('span', { class: 'muted' }, text),
    button(label, 'btn-danger', onconfirm, { id: `${key}-confirm` }),
    button('取消', 'btn-text', () => { state.confirm = null; state.focusNext = `${key}-remove`; render(); }, { id: `${key}-cancel` }));
}

function skeletonRows(columns, rows = 6) {
  const widths = [112, 96, 80, 144, 176, 160];
  return h('tbody', null, Array.from({ length: rows }, (_, row) => h('tr', null, columns.map((column, index) => {
    if (column === 'toggle') return h('td', { class: 'cell-toggle' }, h('span', { class: 'sk sk-toggle' }));
    if (column === 'blank') return h('td');
    const bar = h('span', { class: 'sk' });
    bar.style.width = `${index === 1 ? widths[row % widths.length] : 48 + (row % 2) * 16}px`;
    return h('td', null, bar);
  }))));
}

function emptyState(iconName, title, text, actions) {
  return h('section', { class: 'empty', 'aria-labelledby': 'empty-title' },
    h('span', { class: 'empty-icon' }, icon(iconName)),
    h('div', { class: 'empty-text' }, h('h2', { id: 'empty-title' }, title), h('p', null, text)),
    h('div', { class: 'actions' }, actions));
}

function capability(name, supported) {
  return h('span', { class: `cap${supported ? '' : ' muted'}` },
    icon(supported ? 'check' : 'x', 16, supported ? '支持' : '不支持', supported ? 'ok' : null), name);
}

// ---------------------------------------------------------------- sidebar

function navItem(page, label, iconName, extra) {
  if (page !== 'harness' && !ready()) {
    return h('span', { class: 'nav', role: 'link', 'aria-disabled': 'true', title: '安装 harness 后可用' }, icon(iconName), h('span', null, label));
  }
  return h('a', { class: 'nav', href: `#/${page}`, 'aria-current': state.page === page ? 'page' : null }, icon(iconName), h('span', null, label), extra);
}

function sidebar() {
  const base = state.base;
  const current = base ? base.harnesses.find(item => item.selected) : null;
  const skills = state.skills.rows;
  const mcpFailures = state.mcp.rows ? state.mcp.rows.filter(row => mcpConnection(row).failed).length : 0;
  const doctorFailures = state.doctor.rows ? state.doctor.rows.filter(row => row.status !== '通过').length : 0;
  let link = null;
  if (jobRunning()) link = h('span', { class: 'current-busy' }, `${state.job.verb}…`);
  else if (base && base.installed) link = h('a', { class: 'current-link', href: '#/harness' }, '切换 harness');
  const refresh = ready()
    ? h('button', { type: 'button', class: 'nav nav-bottom', disabled: jobRunning() || isBusy('reload'), onclick: reloadConfig },
      icon('refresh'), h('span', null, isBusy('reload') ? '正在刷新…' : '刷新配置'))
    : h('span', { class: 'nav nav-bottom', role: 'button', 'aria-disabled': 'true', title: '安装 harness 后可用' }, icon('refresh'), h('span', null, '刷新配置'));
  return h('aside', { class: 'side' },
    h('div', { class: 'brand' }, 'ShadowBot Switch'),
    h('section', { class: 'current', 'aria-label': '当前后端' },
      h('div', { class: 'current-name' },
        h('span', { class: 'current-harness' }, current ? current.name : state.fatal ? '未连接' : '读取中…'),
        current && current.version ? h('span', { class: 'meta' }, current.version) : null),
      base ? h('div', { class: 'meta' }, `影刀 ${base.shadowbot.version || '未找到'}`) : null,
      link),
    h('nav', { class: 'nav-list', 'aria-label': '主导航' },
      navItem('harness', 'Harness', 'harness'),
      navItem('skills', 'Skills', 'puzzle', skills ? h('span', { class: 'nav-count quiet' }, String(skills.length)) : null),
      navItem('mcp', 'MCP', 'plug', mcpFailures ? h('span', { class: 'nav-count bad' }, `${mcpFailures} 个失败`) : null),
      navItem('rules', '规则', 'file-text'), navItem('config', '配置', 'gear'),
      navItem('doctor', '诊断', 'pulse', doctorFailures ? h('span', { class: 'nav-count bad' }, `${doctorFailures} 项未通过`) : null)),
    refresh);
}

// ---------------------------------------------------------------- harness page

function harnessColumn(spec) {
  const job = jobRunning() ? state.job : null;
  const mine = job && job.harness === spec.id;
  let badge = null;
  if (mine) badge = h('span', { class: 'harness-state accent' }, job.verb);
  else if (spec.selected) badge = h('span', { class: 'harness-state ok' }, '正在使用');
  else badge = h('span', { class: 'harness-state muted' }, spec.installed ? '未使用' : '未安装');
  const actions = [];
  if (!spec.selected) {
    const host = state.base.shadowbot;
    const needsHost = !state.base.installed && !(host.directory && host.version);
    actions.push(button(spec.installed ? '切换到此' : '安装并切换', 'btn-primary', () => startJob('use', spec.id),
      { disabled: Boolean(job) || Boolean(state.base.problem) || needsHost, title: needsHost ? '先在下方填写影刀安装目录' : null }));
  }
  const upstream = spec.upstream;
  const candidate = upstream?.candidate;
  if (spec.installed && spec.kind === 'managed') {
    const disabled = Boolean(job) || Boolean(state.base.problem) || !spec.availableVersion;
    if (candidate || spec.updateStatus !== 'current' || (spec.upstreamCapable && upstream?.status !== 'up-to-date')) {
      const label = candidate ? `更新到 ${candidate}` : (spec.updateStatus === 'different' || !spec.upstreamCapable) ? '应用本地更新' : '检查并更新';
      actions.push(button(label, 'btn-secondary', () => startJob('update', spec.id), { disabled }));
    }
    if (upstream?.status === 'error') actions.push(button('仅本地重建', 'btn-text', () => startJob('update', spec.id, { localOnly: true }), { disabled }));
  }
  const status = candidate ? [`上游有新版本 ${candidate}，可更新`, 'accent']
    : upstream?.status === 'error' && spec.updateStatus !== 'different' ? [upstream.message, 'warn'] : {
    current: [upstream?.status === 'up-to-date' ? '已是最新' : '与本地构建一致', 'ok'],
    different: ['本地源码有变化，可应用更新', 'accent'],
    unknown: ['无法判断是否需要更新', 'warn'],
    'not-installed': ['安装后即可使用', 'muted'],
    bundled: ['随影刀更新，无需单独更新', 'muted'],
  }[spec.updateStatus] || ['无法判断是否需要更新', 'warn'];
  return h('article', { class: 'harness' },
    h('div', { class: 'harness-head' },
      h('h2', null, spec.name),
      badge),
    h('div', { class: 'harness-versions' },
      h('div', null, h('span', { class: 'muted' }, spec.kind === 'bundled' ? '随影刀提供' : '已安装'), h('span', null, (spec.version || '未安装') + (spec.dependencySource === 'upstream' ? ' · 上游版本' : ''))),
      spec.kind === 'managed' ? h('div', null, h('span', { class: 'muted' }, '仓库锁定'), h('span', null, spec.pinnedVersion || '无法读取')) : null,
      spec.upstreamCapable ? h('div', null, h('span', { class: 'muted' }, '上游'), h('span', null,
        candidate || ({ 'up-to-date': '已是最新', error: '检查失败', skipped: '离线跳过' }[upstream?.status] || '未检查'))) : null),
    h('div', { class: `caps${spec.skills || spec.mcp ? '' : ' muted'}` }, capability('Skill', spec.skills), capability('MCP', spec.mcp)),
    h('div', { class: 'harness-footer' },
      h('p', { class: status[1] }, status[0]),
      upstream?.majorAvailable ? h('p', { class: 'harness-note' }, `另有新主版本 ${upstream.majorAvailable}，需手动指定版本`) : null,
      actions.length ? h('div', { class: 'actions' }, actions) : null));
}

function taskSection() {
  const job = state.job;
  const running = !job.done;
  const failed = job.done && (job.exitCode !== 0 || job.stopped);
  const reached = job.done && !failed ? job.steps.length : Math.max(job.reached, 0);
  const steps = [];
  job.steps.forEach((step, index) => {
    if (index) steps.push(h('li', { class: 'step-line', 'aria-hidden': 'true' }));
    let status = index < reached ? 'done' : index === reached ? (failed ? 'failed' : 'current') : 'todo';
    if (job.done && !failed) status = 'done';
    const marks = {
      done: ['check', '已完成', 'ok'], current: ['clock', '进行中', 'warn'], failed: ['x', '没有完成', 'bad'], todo: ['circle', '未开始', 'muted'],
    }[status];
    steps.push(h('li', { class: `step is-${status}`, 'aria-current': status === 'current' ? 'step' : null }, icon(marks[0], 16, marks[1], marks[2]), h('span', null, step.label)));
  });
  const last = [...job.lines].reverse().find(line => line.trim());
  const statusText = job.stopped ? '已停止' : failed ? '没有完成' : '已完成';
  const caret = icon('caret');
  if (!job.collapsed) caret.classList.add('flip');
  return h('section', { class: 'task', 'aria-labelledby': 'task-title' },
    h('div', { class: 'task-head' },
      h('h2', { id: 'task-title' }, job.title),
      running ? h('span', { class: 'muted', 'data-clock': 'elapsed' }, clock((Date.now() - job.startedAt) / 1000))
        : h('span', { class: failed ? 'bad' : 'ok' }, statusText),
      running && job.waiting ? button('停止等待', 'btn-secondary push', stopJob, { disabled: isBusy('stop') }) : null,
      h('button', { type: 'button', class: `icon-btn${running && job.waiting ? '' : ' push'}`, 'aria-label': job.collapsed ? '展开任务日志' : '收起任务日志', 'aria-expanded': String(!job.collapsed), onclick: () => { job.collapsed = !job.collapsed; render(); } }, caret),
      running ? null : h('button', { type: 'button', class: 'icon-btn', 'aria-label': '关闭任务', onclick: () => { state.job = null; render(); } }, icon('x'))),
    job.collapsed ? null : [
      steps.length ? h('ol', { class: 'steps' }, steps) : null,
      running && job.waiting ? h('div', { class: 'notice', role: 'status' },
        icon('warning', 20, null, 'warn'),
        h('span', { class: 'strong' }, '请保存工作，从托盘退出影刀'),
        h('span', { class: 'muted push' }, '剩余 ', h('span', { 'data-clock': 'remaining' }, clock(job.waitSeconds - (Date.now() - job.waitStartedAt) / 1000)))) : null,
      failed ? problemBlock(job.stopped ? '已停止等待，没有切换。' : (last || '任务没有完成，原因见下方日志。').trim().replace(/^ShadowBot Switch：/, '')) : null,
      job.pollError ? problemBlock(job.pollError) : null,
      h('pre', { class: 'log', id: 'job-log', tabindex: '0', 'aria-label': '任务日志' }, job.lines.slice(-400).join('\n') || '正在启动…'),
    ]);
}

function shadowbotSection() {
  const info = state.base.shadowbot;
  const editable = !state.base.installed && !jobRunning();
  let directory;
  if (state.editingDir) {
    const input = h('input', { class: 'field mono', id: 'shadowbot-dir', type: 'text', value: state.dirOverride || info.directory || '', placeholder: 'D:\\ShadowBot', spellcheck: 'false', autocomplete: 'off', 'aria-label': '影刀安装目录' });
    input.addEventListener('keydown', event => { if (event.key === 'Enter') saveShadowBotDir(input.value); if (event.key === 'Escape') { state.editingDir = false; state.focusNext = 'shadowbot-dir-edit'; render(); } });
    directory = [input, button('保存', 'btn-primary', () => saveShadowBotDir(input.value)), button('取消', 'btn-text', () => { state.editingDir = false; state.focusNext = 'shadowbot-dir-edit'; render(); })];
  } else {
    directory = [
      h('span', { class: `fact-value${info.directory ? ' mono' : ' muted'}` }, info.directory || '没有找到，点“更改”填写'),
      editable ? button('更改', 'btn-secondary', () => { state.editingDir = true; state.focusNext = 'shadowbot-dir'; render(); }, { id: 'shadowbot-dir-edit' }) : null,
    ];
  }
  let version;
  if (info.version) {
    version = [h('span', null, info.version), belowMinimum(info.version) ? h('span', { class: 'warn' }, `低于 ${MIN_SHADOWBOT}，可能不兼容`) : null];
  } else version = h('span', { class: 'muted' }, info.directory ? '这个目录里没有 ShadowBot.exe' : '—');
  return h('section', { class: 'facts', 'aria-labelledby': 'host-title' },
    h('h2', { id: 'host-title' }, '影刀'),
    h('div', null,
      h('div', { class: 'fact' }, h('span', { class: 'fact-label' }, '安装目录'), directory),
      h('div', { class: 'fact' }, h('span', { class: 'fact-label' }, '版本'), version)));
}

function confirmUninstall() {
  const purge = h('input', { type: 'checkbox' });
  const confirm = h('button', { type: 'submit', class: 'btn btn-primary' }, '确认卸载');
  purge.addEventListener('change', () => {
    confirm.className = purge.checked ? 'btn btn-danger' : 'btn btn-primary';
    confirm.textContent = purge.checked ? '确认卸载并永久删除历史会话与配置' : '确认卸载';
  });
  const dialog = openDialog('卸载 ShadowBot Switch？', 'uninstall-title',
    h('div', { class: 'form-row' }, h('p', null, '恢复影刀原版，删除运行时、工具链和构建产物。'),
      h('label', null, purge, ' 同时删除历史会话与配置（.shadowbot-switch）')),
    h('div', { class: 'dialog-foot' }, button('取消', 'btn-secondary', () => dialog.close()),
      confirm),
    () => { dialog.close(); startJob('uninstall', null, { purgeData: purge.checked }); });
}

async function checkUpdates() {
  await withBusy('check-updates', async () => {
    try {
      const report = await api('/api/updates/check', state.mirror ? { mirror: state.mirror } : {});
      await refreshBase();
      const failed = Object.values(report.items).some(item => item.status === 'error');
      toast(failed ? '部分 harness 检查失败，详情见卡片。' : '检查完成。', failed ? 'error' : 'ok');
    } catch (error) { toast(error.message, 'error'); }
  });
}

function harnessPage() {
  const base = state.base;
  const parts = [h('h1', null, 'Harness')];
  if (base.problem) parts.push(problemBlock(base.problem));
  else if (base.recoveryPending && !state.job) {
    parts.push(h('div', { class: 'problem', role: 'alert' },
      icon('warning', 20, null, 'warn'),
      h('span', null, '上次切换没有完成。保存工作并退出影刀后，点“修复”继续。'),
      button('修复', 'btn-secondary', () => startJob('repair'))));
  }
  parts.push(h('div', { class: 'harness-cols' }, base.harnesses.map(harnessColumn)));
  if (state.job) parts.push(taskSection());
  parts.push(shadowbotSection());
  parts.push(h('div', { class: 'install-settings' },
    segmented('mirror-label', '安装下载源', [['', '默认（跟随环境）'], ['direct', '直连官方'], ['aliyun', '阿里云镜像']], state.mirror, value => {
      state.mirror = value;
      try { localStorage.setItem('shadowbot-switch-mirror', value); } catch { /* kept in memory only */ }
    }, jobRunning()),
    button(isBusy('check-updates') ? '检查中…' : '检查更新', 'btn-secondary', checkUpdates,
      { disabled: jobRunning() || isBusy('check-updates') || !base.harnesses.some(spec => spec.installed && spec.upstreamCapable) }),
    base.upstreamCheckedAt && h('span', { class: 'harness-note' }, '上次检查 ' + new Date(base.upstreamCheckedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
    base.canUninstall && button('卸载 ShadowBot Switch', 'btn-secondary', confirmUninstall, { disabled: jobRunning() })));
  return parts;
}

// ---------------------------------------------------------------- skills page

function skillRow(row) {
  const official = row.source === 'official';
  const busy = isBusy(`skill:${row.name}`) || jobRunning();
  const key = `skill-${row.source}-${row.name}`;
  const [label, tone] = SKILL_STATUS[row.status] || [row.status, 'muted'];
  let actions = null;
  if (state.confirm === key) actions = confirmCell(key, '移除并备份？', '移除', () => removeSkill(row));
  else if (!official) {
    actions = h('div', { class: 'row-actions' },
      h('button', { type: 'button', class: 'icon-btn', id: `${key}-open`, 'aria-label': `打开 ${row.name} 所在目录`, title: '打开所在目录', onclick: () => openPath('folder', row.path) }, icon('folder', 16)),
      h('button', { type: 'button', class: 'icon-btn', id: `${key}-remove`, 'aria-label': `移除 ${row.name}`, title: '移除', disabled: busy, onclick: () => askConfirm(key) }, icon('trash', 16)));
  }
  return h('tr', null,
    h('td', { class: 'cell-toggle' }, toggleButton({
      id: `${key}-toggle`,
      pressed: row.status !== 'disabled' && row.status !== 'invalid',
      label: official ? `${row.name} 由影刀管理` : `${row.status === 'disabled' ? '启用' : '停用'} ${row.name}`,
      disabled: official || row.status === 'invalid' || busy,
      title: official ? '影刀内置 Skill 在影刀的权限设置里调整' : null,
      onclick: () => toggleSkill(row),
    })),
    h('td', { class: 'name', title: row.description || null }, row.name),
    h('td', { class: 'muted' }, SOURCES[row.source] || row.source),
    h('td', { class: tone, title: row.reason || null }, label),
    h('td', { class: 'cell-actions' }, actions));
}

function skillsPage() {
  const box = state.skills;
  const rows = box.rows || [];
  const custom = rows.filter(row => row.source !== 'official');
  const counts = { all: rows.length, custom: custom.length, official: rows.length - custom.length };
  const query = box.query.trim().toLowerCase();
  const visible = rows.filter(row => (box.filter === 'all' || (box.filter === 'official') === (row.source === 'official'))
    && (!query || row.name.toLowerCase().includes(query) || String(row.description || '').toLowerCase().includes(query)));
  const head = h('header', { class: 'page-head' },
    h('h1', { class: 'page-title' }, 'Skills'),
    scopeSelect(),
    h('button', { type: 'button', class: 'btn btn-primary', disabled: jobRunning(), onclick: openSkillDialog }, icon('plus', 16), h('span', null, '添加 Skill')));
  const search = h('input', { type: 'search', id: 'skill-search', placeholder: '搜索 Skill', value: box.query, autocomplete: 'off' });
  // A re-render replaces the input, so wait until an IME finishes composing Chinese text.
  const applySearch = () => { box.query = search.value; render(); };
  search.addEventListener('input', event => { if (!event.isComposing) applySearch(); });
  search.addEventListener('compositionend', applySearch);
  const filters = [['all', '全部'], ['custom', '自定义'], ['official', '影刀内置']];
  const toolbar = h('div', { class: 'toolbar' },
    h('label', { class: 'field search' }, icon('search', 16), h('span', { class: 'sr-only' }, '搜索 Skill'), search),
    h('div', { class: 'seg', role: 'group', 'aria-label': '按来源筛选' }, filters.map(([value, label]) =>
      h('button', { type: 'button', id: `filter-${value}`, 'aria-pressed': String(box.filter === value), onclick: () => { box.filter = value; render(); } },
        box.rows ? `${label} ${counts[value]}` : label))));
  let body;
  if (box.error) body = problemBlock(box.error, loadSkills);
  else if (box.rows && !rows.length) {
    body = emptyState('puzzle', '还没有 Skill', '添加一个包含 SKILL.md 的文件夹，下一轮对话就能用。',
      [h('button', { type: 'button', class: 'btn btn-primary', disabled: jobRunning(), onclick: openSkillDialog }, icon('plus', 16), h('span', null, '添加 Skill'))]);
  } else {
    const columns = ['toggle', 'name', 'source', 'status', 'blank'];
    body = h('div', { class: 'table-wrap', 'aria-busy': String(!box.rows) },
      box.rows ? null : h('span', { class: 'sr-only', role: 'status' }, '正在读取 Skills'),
      h('table', { class: 'list' },
        h('thead', null, h('tr', null,
          h('th', { scope: 'col' }, '启用'), h('th', { scope: 'col' }, '名称'), h('th', { scope: 'col' }, '来源'),
          h('th', { scope: 'col' }, '状态'), h('th', { scope: 'col', class: 'cell-actions' }, '操作'))),
        box.rows ? h('tbody', null, visible.length ? visible.map(skillRow)
          : h('tr', null, h('td', { colspan: '5', class: 'table-note' }, '没有匹配的 Skill。'))) : skeletonRows(columns)));
  }
  return [head, toolbar, body];
}

// ---------------------------------------------------------------- MCP page

function runtimeStatus(name) {
  const found = (state.mcp.runtime || []).map(item => item && item.mcp && item.mcp[name]).filter(Boolean);
  return found.find(item => item.status === 'failed') || found[0] || null;
}

function mcpConnection(row) {
  if (row.state === '配置错误') return { text: '配置错误', tone: 'bad', title: row.error, failed: true };
  if (row.state === '已禁用') return { text: '已禁用', tone: 'muted' };
  const live = state.mcp.tests[row.name] || runtimeStatus(row.name);
  if (!live) return { text: '未检查', tone: 'muted', title: '点“测试”检查连接' };
  if (live.status === 'connected') return { text: '已连接', tone: 'ok' };
  if (live.status === 'disabled') return { text: '已禁用', tone: 'muted' };
  if (live.status === 'failed') return { text: `失败：${live.error || '原因未知'}`, tone: 'bad', title: live.error, failed: true };
  return { text: String(live.status || '未知'), tone: 'muted' };
}

function mcpSource(path) {
  if (!path) return '';
  const normal = value => String(value).replace(/\//g, '\\').toLowerCase();
  return normal(path).startsWith(`${normal(state.base.home)}\\`) ? '安装级' : '应用级';
}

function mcpRow(row) {
  const key = `mcp-${row.name}`;
  const busy = isBusy(`mcp:${row.name}`) || jobRunning();
  const testing = isBusy(`test:${row.name}`);
  const broken = row.state === '配置错误';
  const connection = mcpConnection(row);
  const actions = state.confirm === key ? confirmCell(key, '删除并备份？', '删除', () => removeMcp(row))
    : h('div', { class: 'row-actions' },
      button(testing ? '测试中…' : '测试', 'btn-text', () => testMcp(row), { id: `${key}-test`, disabled: testing || broken || row.state === '已禁用' || jobRunning() }),
      h('button', { type: 'button', class: 'icon-btn', id: `${key}-remove`, 'aria-label': `删除 ${row.name}`, title: '删除', disabled: busy, onclick: () => askConfirm(key) }, icon('trash', 16)));
  return h('tr', null,
    h('td', { class: 'cell-toggle' }, toggleButton({
      id: `${key}-toggle`, pressed: row.state !== '已禁用' && !broken,
      label: `${row.state === '已禁用' ? '启用' : '停用'} ${row.name}`,
      disabled: broken || busy, title: broken ? row.error : null, onclick: () => toggleMcp(row),
    })),
    h('td', { class: 'name' }, row.name),
    h('td', { class: 'muted' }, row.transport || '—'),
    h('td', { class: 'muted', title: row.source || null }, mcpSource(row.source)),
    h('td', { class: connection.tone }, h('span', { class: 'conn', title: connection.title || null }, connection.text)),
    h('td', { class: 'cell-actions' }, actions));
}

function mcpPage() {
  const box = state.mcp;
  const head = h('header', { class: 'page-head' },
    h('h1', { class: 'page-title' }, 'MCP'),
    scopeSelect(),
    box.rows && !box.rows.length ? null : [
      button('编辑 mcp.json', 'btn-secondary', () => openConfig('mcp'), { disabled: jobRunning() || isBusy('config:mcp') }),
      h('button', { type: 'button', class: 'btn btn-primary', disabled: jobRunning(), onclick: openMcpDialog }, icon('plus', 16), h('span', null, '添加 MCP')),
    ]);
  let body;
  if (box.error) body = problemBlock(box.error, loadMcp);
  else if (box.rows && !box.rows.length) {
    body = emptyState('plug', '还没有配置 MCP', '添加后，支持 MCP 的 Harness 就能调用它提供的工具。', [
      h('button', { type: 'button', class: 'btn btn-primary', disabled: jobRunning(), onclick: openMcpDialog }, icon('plus', 16), h('span', null, '添加 MCP')),
      button('编辑 mcp.json', 'btn-secondary', () => openConfig('mcp'), { disabled: jobRunning() || isBusy('config:mcp') }),
    ]);
  } else {
    body = h('div', { class: 'table-wrap', 'aria-busy': String(!box.rows) },
      box.rows ? null : h('span', { class: 'sr-only', role: 'status' }, '正在读取 MCP'),
      h('table', { class: 'list' },
        h('thead', null, h('tr', null,
          h('th', { scope: 'col' }, '启用'), h('th', { scope: 'col' }, '名称'), h('th', { scope: 'col' }, '类型'),
          h('th', { scope: 'col' }, '来源'), h('th', { scope: 'col' }, '连接'), h('th', { scope: 'col', class: 'cell-actions' }, '操作'))),
        box.rows ? h('tbody', null, box.rows.map(mcpRow)) : skeletonRows(['toggle', 'name', 'type', 'source', 'state', 'blank'], 3)));
  }
  return [head, body];
}

// ---------------------------------------------------------------- doctor page

function checkRow(row) {
  const passed = row.status === '通过';
  const lines = String(row.detail || '').split('\n').filter(line => line.trim());
  // Passed checks keep their detail as a tooltip, so only problems take up room.
  return h('li', { title: passed && lines.length ? lines.join('\n') : null },
    icon(passed ? 'check' : 'x', 16, passed ? '通过' : '未通过', passed ? 'ok' : 'bad'),
    h('span', { class: passed ? null : 'strong' }, row.check),
    !passed && lines.length ? h('div', { class: 'detail' }, lines.map(line => {
      const rules = RULES_LINE.exec(line);
      return h('div', { class: 'detail-line' },
        h('span', null, line),
        rules ? [button('打开文件', 'btn-secondary', () => openPath('rules', rules[1])), h('a', { href: '#/rules' }, '在界面中编辑')] : null);
    })) : null);
}

function doctorPage() {
  const box = state.doctor;
  const failures = box.rows ? box.rows.filter(row => row.status !== '通过').length : 0;
  const head = h('header', { class: 'page-head' },
    h('div', { class: 'page-title' },
      h('h1', null, '诊断'),
      box.rows ? h('span', { class: failures ? 'bad' : 'ok' }, failures ? `${failures} 项未通过` : '全部通过') : null),
    scopeSelect(),
    button('修复', 'btn-secondary', () => startJob('repair'), { disabled: jobRunning(), title: '重新定位安装并完成中断的切换' }),
    h('button', { type: 'button', class: 'btn btn-primary', disabled: box.loading, onclick: () => Promise.all([loadDoctor(), loadRuntime(), loadLog()]) }, icon('refresh', 16), h('span', null, box.loading ? '正在检查…' : '重新检查')));
  let body;
  if (box.error) body = problemBlock(box.error, loadDoctor);
  else if (!box.rows) {
    body = h('ul', { class: 'checks', 'aria-busy': 'true', 'aria-label': '正在检查' }, Array.from({ length: 9 }, (_, index) => {
      const bar = h('span', { class: 'sk' });
      bar.style.width = `${80 + (index % 3) * 24}px`;
      return h('li', null, h('span', { class: 'sk sk-toggle' }), bar);
    }));
  } else body = h('ul', { class: 'checks', 'aria-label': '检查结果' }, box.rows.map(checkRow));
  return [head, body, runtimeSection(), logSection()];
}

// ---------------------------------------------------------------- dialogs

function setHint(target, tone, text) {
  target.replaceChildren(icon(tone === 'ok' ? 'check' : 'warning', 16, null, tone), h('span', { class: tone }, text));
}

function openDialog(title, id, body, footer, onsubmit) {
  const close = h('button', { type: 'button', class: 'icon-btn', 'aria-label': '关闭' }, icon('x'));
  const form = h('form', { class: 'dialog', novalidate: true },
    h('div', { class: 'dialog-head' }, h('h2', { id }, title), close), body, footer);
  const dialog = h('dialog', { 'aria-labelledby': id }, form);
  close.addEventListener('click', () => dialog.close());
  form.addEventListener('submit', event => { event.preventDefault(); onsubmit(); });
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

function openSkillDialog() {
  const input = h('input', { class: 'field mono', id: 'skill-folder', type: 'text', placeholder: 'D:\\Skills\\report-export', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'skill-folder-hint' });
  const hint = h('div', { class: 'hint', id: 'skill-folder-hint', role: 'status' });
  const submit = h('button', { type: 'submit', class: 'btn btn-primary', disabled: true }, '添加');
  const pick = h('button', { type: 'button', class: 'btn btn-secondary' }, icon('folder', 16), h('span', null, '选择文件夹'));
  let ticket = 0;
  let timer = 0;
  const preview = async () => {
    const path = input.value.trim();
    const mine = ++ticket;
    input.removeAttribute('aria-invalid');
    if (!path) { hint.replaceChildren(); return; }
    try {
      const { name } = await api('/api/skill-preview', { path });
      if (mine !== ticket) return;
      if (SKILL_NAME.test(name)) setHint(hint, 'ok', `找到 ${name}`);
      else setHint(hint, 'warn', `找到 ${name}，但名称只能用小写字母、数字和连字符。`);
    } catch (error) {
      if (mine === ticket) setHint(hint, 'bad', error.message);
    }
  };
  input.addEventListener('input', () => {
    submit.disabled = !input.value.trim();
    clearTimeout(timer);
    timer = setTimeout(preview, 400);
  });
  pick.addEventListener('click', async () => {
    pick.disabled = true;
    try {
      const { path } = await api('/api/pick-folder');
      if (path) { input.value = path; submit.disabled = false; preview(); }
    } catch (error) { setHint(hint, 'bad', error.message); }
    finally { pick.disabled = false; }
  });
  const cancel = button('取消', 'btn-secondary', () => dialog.close());
  const dialog = openDialog('添加 Skill', 'skill-add-title',
    h('div', { class: 'form-row' }, h('label', { for: 'skill-folder' }, 'Skill 文件夹'), h('div', { class: 'inline' }, input, pick), hint),
    h('div', { class: 'dialog-foot' }, h('span', { class: 'scope-note' }, `保存到：${scopeLabel()}`), cancel, submit),
    async () => {
      const path = input.value.trim();
      if (!path) return;
      submit.disabled = true;
      submit.textContent = '正在添加…';
      try {
        const { data } = await run('skills.add', { path });
        dialog.close();
        announce(data);
        loadSkills();
      } catch (error) {
        input.setAttribute('aria-invalid', 'true');
        setHint(hint, 'bad', error.message);
        input.focus();
      } finally {
        submit.disabled = !input.value.trim();
        submit.textContent = '添加';
      }
    });
  input.focus();
}

function segmented(id, label, options, selected, onchange, disabled = false) {
  const group = h('div', { class: 'seg', role: 'group', 'aria-labelledby': id });
  const buttons = options.map(([value, text]) => h('button', { type: 'button', disabled, 'aria-pressed': String(value === selected) }, text));
  buttons.forEach((item, index) => item.addEventListener('click', () => {
    buttons.forEach(other => other.setAttribute('aria-pressed', String(other === item)));
    onchange(options[index][0]);
  }));
  group.append(...buttons);
  return h('div', { class: 'form-row' }, h('span', { class: 'form-label', id }, label), group);
}

function openMcpDialog() {
  let transport = 'stdio';
  let permission = 'ask';
  const field = (id, label, control) => {
    const error = h('div', { class: 'hint', id: `${id}-error`, role: 'alert' });
    control.setAttribute('aria-describedby', `${id}-error`);
    return { row: h('div', { class: 'form-row' }, h('label', { for: id }, label), control, error), control, error };
  };
  const name = field('mcp-name', '名称', h('input', { class: 'field', id: 'mcp-name', type: 'text', placeholder: 'local-tools', autocomplete: 'off', spellcheck: 'false' }));
  const command = field('mcp-command', '命令', h('input', { class: 'field mono', id: 'mcp-command', type: 'text', placeholder: 'node', autocomplete: 'off', spellcheck: 'false' }));
  const args = field('mcp-args', '参数（每行一个）', h('textarea', { class: 'field mono', id: 'mcp-args', rows: '3', spellcheck: 'false' }));
  const cwd = field('mcp-cwd', '工作目录', h('input', { class: 'field mono', id: 'mcp-cwd', type: 'text', placeholder: '可选', autocomplete: 'off', spellcheck: 'false' }));
  const url = field('mcp-url', '地址', h('input', { class: 'field mono', id: 'mcp-url', type: 'url', placeholder: 'https://example.com/mcp', autocomplete: 'off', spellcheck: 'false' }));
  url.row.hidden = true;
  const general = h('div', { class: 'hint', role: 'alert' });
  const all = [name, command, args, cwd, url];
  const clear = () => {
    for (const item of all) { item.error.replaceChildren(); item.control.removeAttribute('aria-invalid'); }
    general.replaceChildren();
  };
  const fail = (target, message) => {
    if (target) { target.control.setAttribute('aria-invalid', 'true'); setHint(target.error, 'bad', message); target.control.focus(); }
    else setHint(general, 'bad', message);
  };
  const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, '保存');
  const dialog = openDialog('添加 MCP', 'mcp-add-title',
    h('div', { class: 'form' },
      name.row,
      segmented('mcp-type-label', '类型', [['stdio', 'stdio'], ['http', 'http']], transport, value => {
        transport = value;
        for (const item of [command, args, cwd]) item.row.hidden = value !== 'stdio';
        url.row.hidden = value !== 'http';
        clear();
      }),
      command.row, args.row, cwd.row, url.row,
      segmented('mcp-permission-label', '工具授权', PERMISSIONS, permission, value => { permission = value; }),
      general),
    h('div', { class: 'dialog-foot' }, h('span', { class: 'scope-note' }, `保存到：${scopeLabel()}`), button('取消', 'btn-secondary', () => dialog.close()), submit),
    async () => {
      clear();
      const body = { name: name.control.value.trim(), transport, permission };
      if (!MCP_NAME.test(body.name)) { fail(name, '名称只能包含英文字母、数字、下划线和连字符，最长 64 个字符。'); return; }
      if (transport === 'stdio') {
        body.command = command.control.value.trim();
        body.args = args.control.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        body.cwd = cwd.control.value.trim();
        if (!body.command) { fail(command, '请填写启动 MCP 的命令，例如 node 或 npx。'); return; }
      } else {
        body.url = url.control.value.trim();
        if (!/^https?:\/\/\S+$/.test(body.url)) { fail(url, '请填写以 http:// 或 https:// 开头的地址。'); return; }
      }
      submit.disabled = true;
      submit.textContent = '正在保存…';
      try {
        const { data } = await run('mcp.add', body);
        dialog.close();
        announce(data);
        loadMcp();
      } catch (error) {
        const message = error.message;
        if (/当前范围已配置/.test(message)) fail(name, `当前范围已配置 ${body.name}，换一个名称或点“编辑 mcp.json”修改。`);
        else if (/名称/.test(message)) fail(name, message);
        else if (/地址|url/i.test(message) && transport === 'http') fail(url, message);
        else if (/命令|command/i.test(message) && transport === 'stdio') fail(command, message);
        else fail(null, message);
      } finally {
        submit.disabled = false;
        submit.textContent = '保存';
      }
    });
  name.control.focus();
}

// ---------------------------------------------------------------- render loop

function mainView() {
  if (!state.base) {
    return h('main', { class: 'main', id: 'main' }, state.fatal ? problemBlock(state.fatal) : h('span', { class: 'muted' }, '正在读取安装状态…'));
  }
  const pages = { harness: harnessPage, skills: skillsPage, mcp: mcpPage, rules: rulesPage, config: configPage, doctor: doctorPage };
  const content = (pages[state.page] || harnessPage)();
  return h('main', { class: `main${state.page === 'harness' ? ' roomy' : ''}`, id: 'main' },
    state.offline ? problemBlock(state.offline) : null,
    content);
}

function captureView() {
  const active = document.activeElement;
  const focus = active && active.id && document.getElementById('app').contains(active)
    ? { id: active.id, start: active.selectionStart, end: active.selectionEnd } : null;
  const log = document.getElementById('job-log');
  return {
    focus, scroll: [...document.querySelectorAll('[data-keep-scroll][id]')].map(el => [el.id, el.scrollTop]),
    log: log ? { bottom: log.scrollHeight - log.scrollTop - log.clientHeight < 8, top: log.scrollTop } : null,
  };
}

function restoreView(saved) {
  for (const [id, top] of saved.scroll) { const el = document.getElementById(id); if (el) el.scrollTop = top; }
  if (state.focusNext) {
    const target = document.getElementById(state.focusNext);
    state.focusNext = null;
    if (target) target.focus({ preventScroll: true });
  } else if (saved.focus) {
    const target = document.getElementById(saved.focus.id);
    if (target && !target.disabled) {
      target.focus({ preventScroll: true });
      if (typeof saved.focus.start === 'number' && target.setSelectionRange) {
        try { target.setSelectionRange(saved.focus.start, saved.focus.end); } catch { /* not a text field */ }
      }
    }
  }
  const log = document.getElementById('job-log');
  if (log) log.scrollTop = !saved.log || saved.log.bottom ? log.scrollHeight : saved.log.top;
}

// Batched in a microtask rather than a frame, so a minimized window still keeps its DOM current.
let queued = false;
function render() {
  if (queued) return;
  queued = true;
  queueMicrotask(() => {
    queued = false;
    const root = document.getElementById('app');
    const saved = captureView();
    root.replaceChildren(sidebar(), mainView());
    root.setAttribute('aria-busy', state.base ? 'false' : 'true');
    restoreView(saved);
  });
}

function updateClocks() {
  const job = state.job;
  if (!job || job.done) return;
  for (const el of document.querySelectorAll('[data-clock="elapsed"]')) el.textContent = clock((Date.now() - job.startedAt) / 1000);
  for (const el of document.querySelectorAll('[data-clock="remaining"]')) el.textContent = clock(job.waitSeconds - (Date.now() - job.waitStartedAt) / 1000);
}

function heartbeat() {
  setInterval(async () => {
    try {
      await api('/api/ping');
      if (state.offline) { state.offline = null; render(); }
    } catch (error) {
      if (state.offline !== error.message) { state.offline = error.message; render(); }
    }
  }, 10000);
  setInterval(updateClocks, 1000);
  window.addEventListener('pagehide', () => {
    const stage = state.transfer.stage;
    if (stage) {
      state.transfer.stage = null; state.transfer.plan = null;
      apiText('/api/config/discard', JSON.stringify({ stage }), true).catch(() => {});
    }
    try { navigator.sendBeacon('/api/bye', state.token); } catch { /* the idle timeout still applies */ }
  });
}

async function boot() {
  if (!state.token) {
    state.fatal = '缺少访问凭证。请重新运行 ui.ps1 打开界面。';
    render();
    return;
  }
  render();
  try {
    state.base = await api('/api/state');
  } catch (error) {
    state.fatal = error.message;
    render();
    return;
  }
  heartbeat();
  state.scope = state.base.app || '';
  if (state.base.job) {
    state.job = newJob(state.base.job.id, state.base.job.cmd, state.base.job.harness, state.base.job);
    pollJob();
  }
  setPage(pageFromHash() || (ready() ? 'skills' : 'harness'));
  if (ready()) {
    await loadApps();
    await ensureData(state.page);
    loadCounts();
  }
}

// ---------------------------------------------------------------- daily configuration

function normalizeEol(text, eol) {
  return text.replace(/\r\n|\r|\n/g, eol === 'crlf' ? '\r\n' : '\n');
}

function ruleBytes(text, eol) {
  return new TextEncoder().encode(normalizeEol(text, eol)).length;
}

function ruleStatus(bytes) {
  return bytes > 32768 ? 'bad' : bytes >= 32768 * 0.9 ? 'warn' : 'ok';
}

function permissionRows(list) {
  const rows = list.map(row => ({ ...row }));
  const defaultAction = rows[0]?.pattern === '*' ? rows.shift().action : '';
  return { defaultAction, rows };
}

function permissionPayload(form) {
  return [...(form.defaultAction ? [{ pattern: '*', action: form.defaultAction }] : []), ...form.rows.map(({ pattern, action }) => ({ pattern, action }))];
}

function importSummary(plan, replace) {
  const overwrites = plan.files.filter(row => row.action === 'overwrite').length;
  return { creates: plan.files.length - overwrites, overwrites, blocked: !replace && overwrites > 0 };
}

const LOG_ACTIONS = { started: '开始切换', committed: '切换完成', recovered: '已恢复中断的切换', discarded: '已丢弃中断的切换', 'rolled-back': '已回滚' };
function logLabel(action) {
  return Object.hasOwn(LOG_ACTIONS, action) ? LOG_ACTIONS[action] : action;
}

const BACKUP_KINDS = { import: '导入配置', 'skill-remove': '移除 Skill', 'mcp-remove': '移除 MCP', 'rules-save': '保存规则',
  'rules-remove': '删除规则', 'settings-save': '保存设置', 'pre-restore': '恢复前自动备份', legacy: '旧备份（无记录）' };
const ACTIONS = { create: '新建', overwrite: '覆盖', delete: '删除', 'replace-directory': '替换目录' };
const writeDisabled = () => jobRunning() || isBusy('config-write');
const scopedBody = () => state.scope ? { app: state.scope } : {};
const loadRules = () => load('rules', async () => ({ layers: (await run('rules.show')).data.layers }));
const loadSettings = () => load('settings', async () => ({ data: (await run('settings.show')).data }));
const loadRuntime = () => load('runtime', async () => ({ apps: (await run('status', {}, false)).data.applications }));
function loadBackups(more = false) {
  const old = more === true ? state.backups.items || [] : [];
  return load('backups', async () => {
    const { data } = await run('config.backups', { limit: 20, offset: old.length }, false);
    return { items: [...old, ...data.items], total: data.total };
  });
}

function loadLog(more = false) {
  const old = more === true ? state.log.entries || [] : [];
  return load('log', async () => {
    const { data } = await run('log', { limit: 20, offset: old.length }, false);
    return { entries: [...old, ...data.entries], total: data.total, skipped: data.skipped };
  });
}

function confirmDialog(title, body, label, action) {
  const dialog = openDialog(title, 'confirmation-title', h('div', { class: 'facts' }, body),
    h('div', { class: 'dialog-foot' }, button('取消', 'btn-secondary', () => dialog.close()),
      h('button', { type: 'submit', class: 'btn btn-danger' }, label)), () => { dialog.close(); action(); });
}

function configWrite(fn) {
  if (writeDisabled()) return;
  return withBusy('config-write', async () => {
    try { await fn(); } catch (error) { toast(error.message, 'error'); }
  });
}

function pageHeading(title) {
  return h('header', { class: 'page-head' }, h('h1', { class: 'page-title' }, title), scopeSelect());
}

function dataTable(labels, rows) {
  return h('div', { class: 'table-wrap' }, h('table', { class: 'list' },
    h('thead', null, h('tr', null, labels.map(label => h('th', { scope: 'col' }, label)))),
    h('tbody', null, rows.map(cells => h('tr', null, cells.map(content => h('td', null, content)))))));
}

function loadingBlock() {
  return h('div', { class: 'table-wrap', role: 'status', 'aria-label': '读取中' },
    h('table', { class: 'list' }, skeletonRows(['text', 'text'], 3)));
}

function ruleMessage(bytes) {
  const tone = ruleStatus(bytes);
  return `${bytes.toLocaleString()} / 32,768 字节${tone === 'warn' ? ' · 接近上限' : tone === 'bad' ? ' · 超过 32 KiB，运行时会整份跳过' : ''}`;
}

function updateRuleDraft(event, draft, layer) {
  draft.text = event.target.value;
  draft.dirty = draft.unlocked || !layer.exists || draft.text !== normalizeEol(layer.content, 'lf') || draft.eol !== (layer.eol === 'crlf' ? 'crlf' : 'lf');
  const bytes = ruleBytes(draft.text, draft.eol);
  const label = document.getElementById('rules-bytes');
  label.textContent = ruleMessage(bytes);
  label.className = ruleStatus(bytes);
  document.getElementById('rules-meter').value = bytes;
  document.getElementById('rules-save').disabled = !draft.dirty || bytes > 32768 || writeDisabled();
  document.getElementById('rules-discard').disabled = !draft.dirty || writeDisabled();
}

function rulesPage() {
  const box = state.rules;
  const head = pageHeading('规则');
  if (box.error || !box.layers) return [head, box.error ? problemBlock(box.error, loadRules) : loadingBlock()];
  const layer = box.layers.find(l => l.scope === box.active) || box.layers[0];
  const key = layer.path;
  const reset = async () => { delete box.drafts[key]; box.conflict = null; await loadRules(); };
  const create = (text, unlocked = false) => {
    box.drafts[key] = { text: normalizeEol(text, 'lf'), eol: layer.eol === 'crlf' ? 'crlf' : 'lf',
      baseSha: layer.sha256, dirty: unlocked, unlocked };
  };
  const intro = [head, state.scope ? segmented('rules-layer', '规则范围', [['application', '应用级'], ['installation', '安装级']],
    layer.scope, value => { box.active = value; render(); }, writeDisabled()) : h('p', { class: 'muted' }, '选择应用后可编辑应用级规则。'),
    h('div', { class: 'editor-bar' }, h('code', null, key), layer.effective ? '生效中' : '未生效',
      state.base.windows && layer.exists ? button('用记事本打开', 'btn-secondary', () => openPath('rules', key)) : null),
    layer.shadowed ? h('p', { class: 'muted' }, layer.shadowed.path, ' 未生效：被根目录 AGENTS.md 覆盖。') : null,
    layer.warning ? problemBlock(layer.warning) : null];
  if (layer.readonlyReason || (!layer.editable && !box.drafts[key]?.unlocked)) {
    const reason = { link: '请直接编辑链接目标。', 'not-file': '路径不是普通文件。', unreadable: '无法读取文件。' }[layer.readonlyReason];
    return [...intro, h('p', null, reason || (layer.tooLarge ? '文件超限，只显示前 64 KiB。' : '部分字符无法显示。')),
      h('pre', { class: 'log preview' }, layer.preview || layer.content),
      !reason ? button('用新内容替换', 'btn-danger', () => confirmDialog('替换规则文件', '原文件会先备份到 config-backups，再被替换。', '开始替换',
        () => { create(layer.preview, true); render(); }), { disabled: writeDisabled() }) : null];
  }
  if (!box.drafts[key]) {
    if (!layer.exists) return [...intro, emptyState('file-text', '还没有规则文件', `将创建：${key}`,
      button('创建', 'btn-primary', () => { create(''); state.focusNext = 'rules-editor'; render(); }, { disabled: writeDisabled() }))];
    create(layer.content);
  }
  const draft = box.drafts[key], bytes = ruleBytes(draft.text, draft.eol);
  const submit = (remove, force = false) => configWrite(async () => {
    try {
      let expect = draft.baseSha;
      if (force) {
        const latest = (await run('rules.show')).data.layers.find(l => l.scope === layer.scope);
        if (latest.path !== key || latest.readonlyReason) throw new Error('规则路径已变化，请重新加载。');
        expect = latest.sha256;
      }
      const body = { ...scopedBody(), scope: layer.scope, expect };
      const { data } = remove ? await run('rules.remove', body) :
        unwrap(await api('/api/rules/save', { ...body, content: normalizeEol(draft.text, draft.eol) }));
      announce(data); state.confirm = null; state.backups.items = null; await reset();
    } catch (error) {
      if (error.code !== 'conflict') throw error;
      box.conflict = { key, remove };
    }
  });
  const save = () => draft.text.trim() ? submit(false) : confirmDialog('保存空规则',
    '空文件会让这一层规则失效，且应用根目录的空文件会阻止回退文件生效。', '保存空文件', () => submit(false));
  return [...intro, box.conflict?.key === key ? [problemBlock('文件已被其他程序修改。'), h('div', { class: 'actions' },
    button('重新加载（丢弃我的修改）', 'btn-secondary', reset),
    !box.conflict.remove && button('仍然保存', 'btn-danger', () => submit(false, true), { disabled: writeDisabled() || bytes > 32768 }))] : null,
    h('textarea', { class: 'field mono editor', id: 'rules-editor', 'aria-label': 'AGENTS.md 内容', 'data-keep-scroll': true,
      spellcheck: 'false', value: draft.text, disabled: isBusy('config-write'), oninput: event => updateRuleDraft(event, draft, layer) }),
    h('div', { class: 'editor-bar', role: 'status' },
      h('span', { id: 'rules-bytes', class: ruleStatus(bytes) }, ruleMessage(bytes)),
      h('meter', { id: 'rules-meter', min: 0, max: 32768, low: 29491, high: 32768, optimum: 0, value: bytes, 'aria-label': '规则字节数' }),
      'UTF-8', segmented('rules-eol', '换行', [['lf', 'LF'], ['crlf', 'CRLF']], draft.eol, value => {
        draft.eol = value; updateRuleDraft({ target: { value: draft.text } }, draft, layer);
      }), layer.eol === 'mixed' && '保存会统一换行'),
    h('div', { class: 'editor-bar' }, h('span', { class: 'muted' }, `保存到：${key}`),
      layer.exists && (state.confirm === 'rule' ? confirmCell('rule', '先备份再删除？', '删除', () => submit(true)) :
        button('删除文件', 'btn-text', () => askConfirm('rule'), { id: 'rule-remove', disabled: writeDisabled() })),
      button('放弃修改', 'btn-secondary', reset, { id: 'rules-discard', disabled: !draft.dirty || writeDisabled() }),
      button('保存', 'btn-primary', save, { id: 'rules-save', disabled: !draft.dirty || bytes > 32768 || writeDisabled() }))];
}

function configPage() {
  const views = { settings: settingsView, transfer: transferView, backups: backupsView, apps: appsView };
  return [pageHeading('配置'), h('nav', { class: 'subtabs seg', 'aria-label': '配置分类' },
    CONFIG_TABS.map(([key, label]) => h('button', { type: 'button', 'aria-pressed': String(key === state.tab),
      onclick: () => setPage('config/' + key) }, label))), views[state.tab]()];
}

function invalidPermissions(form) {
  const patterns = permissionPayload(form).map(row => row.pattern);
  return form.rows.map(({ pattern }) => !/^[^\s\x00-\x1f\x7f-\x9f]{1,128}$/u.test(pattern) || patterns.indexOf(pattern) !== patterns.lastIndexOf(pattern));
}

function settingsView() {
  const box = state.settings, data = box.data;
  if (box.error || !data) return box.error ? problemBlock(box.error, loadSettings) : loadingBlock();
  const info = h('div', { class: 'editor-bar' }, h('code', null, data.path), data.error ? '配置有错' : data.exists ? '有效' : '文件不存在',
    state.base.windows && button('用记事本打开', 'btn-secondary', () => openConfig('skills'), { disabled: writeDisabled() }));
  if (data.error) return [info, problemBlock(data.error, loadSettings)];
  const form = box.form ??= { ...permissionRows(data.file.mcpPermission), thinkingCommand: data.file.thinkingCommand };
  const dirty = () => { box.dirty = true; render(); };
  const reset = async () => { box.form = null; box.dirty = false; box.conflict = null; await loadSettings(); box.form = null; render(); };
  const setAction = (row, value) => { row.action = value; dirty(); };
  const invalid = invalidPermissions(form);
  const overflow = permissionPayload(form).length > 200;
  const actionLabel = value => PERMISSIONS.find(([key]) => key === value)?.[1] || '询问';
  const move = (i, d) => { [form.rows[i], form.rows[i + d]] = [form.rows[i + d], form.rows[i]]; dirty(); };
  const save = force => configWrite(async () => {
    try {
      const expect = force ? (await run('settings.show')).data.sha256 : data.sha256;
      const body = { ...scopedBody(), expect, mcpPermission: permissionPayload(form) };
      if (!state.scope && form.thinkingCommand !== data.file.thinkingCommand) body.thinkingCommand = form.thinkingCommand;
      announce(unwrap(await api('/api/settings/save', body)).data);
      state.backups.items = null; await reset();
    } catch (error) { if (error.code === 'conflict') box.conflict = true; else throw error; }
  });
  const rows = form.rows.map((row, i) => [
    h('input', { id: `pattern-${i}`, class: 'field mono', list: 'mcp-patterns', 'aria-label': `第 ${i + 1} 条规则`,
      'aria-invalid': String(invalid[i]), value: row.pattern, disabled: writeDisabled(), oninput: event => {
        row.pattern = event.target.value; box.dirty = true;
        const invalid = invalidPermissions(form);
        invalid.forEach((bad, n) => document.getElementById(`pattern-${n}`).setAttribute('aria-invalid', String(bad)));
        document.getElementById('settings-save').disabled = invalid.includes(true) || permissionPayload(form).length > 200 || writeDisabled();
        document.getElementById('settings-discard').disabled = false;
        document.getElementById('pattern-hint').hidden = !invalid.includes(true);
      } }),
    segmented(`action-${i}`, '授权', PERMISSIONS, row.action, value => setAction(row, value), writeDisabled()),
    h('div', { class: 'actions' }, button('上移', 'btn-text', () => move(i, -1), { disabled: !i || writeDisabled() }),
      button('下移', 'btn-text', () => move(i, 1), { disabled: i + 1 === form.rows.length || writeDisabled() }),
      button('删除', 'btn-text', () => { form.rows.splice(i, 1); dirty(); }, { disabled: writeDisabled() }))]);
  const effective = data.effective.mcpPermission;
  return [info, data.warnings.map(w => problemBlock(w)), box.conflict && [problemBlock('文件已被其他程序修改。'),
    h('div', { class: 'actions' }, button('重新加载（丢弃我的修改）', 'btn-secondary', reset),
      button('仍然保存', 'btn-danger', () => save(true), { disabled: writeDisabled() || invalid.includes(true) || overflow }))],
    segmented('default-permission', '默认工具授权', [['', state.scope ? '未设置（继承）' : '未设置（询问）'], ...PERMISSIONS], form.defaultAction,
      value => { form.defaultAction = value; dirty(); }, writeDisabled()),
    data.inherited && h('span', { class: 'muted' }, '当前继承安装级：' + actionLabel(data.inherited.mcpPermission.find(r => r.pattern === '*')?.action)),
    h('p', null, '工具名格式为 <服务名>_<工具名>，* 匹配任意字符；后面的规则优先。'),
    h('datalist', { id: 'mcp-patterns' }, (state.mcp.rows || []).map(row => h('option', { value: row.name + '_*' }))),
    dataTable(['通配', '授权', '操作'], rows),
    h('p', { id: 'pattern-hint', class: 'bad', hidden: !invalid.includes(true) }, '通配不能重复、为空、包含空白或控制字符，最长 128 个字符。'),
    overflow && problemBlock('最多 200 条授权规则。'),
    h('div', { class: 'actions' }, button('添加规则', 'btn-secondary', () => { state.focusNext = 'pattern-' + form.rows.length; form.rows.push({ pattern: '', action: 'ask' }); dirty(); },
      { disabled: writeDisabled() || permissionPayload(form).length >= 200 })),
    h('details', null, h('summary', null, '当前生效的授权规则'), dataTable(['通配', '授权', '来源'], effective.map(r => [r.pattern, actionLabel(r.action),
      state.scope && data.applicationPatterns.includes(r.pattern) ? '应用级' : '安装级'])),
      effective.findIndex(r => r.pattern === '*') > 0 && h('p', { class: 'warn' }, '通配规则会覆盖前面的具体规则。')),
    h('div', { class: 'editor-bar' }, h('strong', null, '/thinking 命令'), state.scope ? `由安装级设置决定：${data.effective.thinkingCommand ? '开启' : '关闭'}` :
      toggleButton({ pressed: form.thinkingCommand !== false, label: '/thinking 命令', disabled: writeDisabled() || !data.thinking.supported || data.thinking.hostOverride,
        onclick: () => { form.thinkingCommand = form.thinkingCommand === false; dirty(); } }),
      data.thinking.hostOverride ? '宿主已自定义 thinking 命令，开关不生效。' : !data.thinking.supported && '当前 harness 不支持 /thinking。'),
    data.file.otherKeys.length > 0 && h('p', { class: 'muted' }, `还包含 ${data.file.otherKeys[0]} 等 ${data.file.otherKeys.length} 个字段，保存时会原样保留。Skill 启用状态在 Skills 页管理。`),
    h('div', { class: 'actions' }, button('放弃修改', 'btn-secondary', reset, { id: 'settings-discard', disabled: !box.dirty || writeDisabled() }),
      button('保存', 'btn-primary', () => save(false), { id: 'settings-save', disabled: !box.dirty || writeDisabled() || invalid.includes(true) || overflow }))];
}

function discardTransfer(box = state.transfer) {
  const stage = box.stage;
  box.stage = null;
  box.plan = null;
  if (stage) return api('/api/config/discard', { stage }).catch(error => toast(error.message, 'error'));
}

function transferView() {
  const box = state.transfer;
  const preview = () => configWrite(async () => {
    try {
      box.error = null; box.plan = null;
      if (!box.stage) {
        if (!box.text) throw new Error('请选择配置包或粘贴 JSON。');
        const bundle = JSON.parse(box.text.replace(/^\uFEFF/, ''));
        if (bundle?.format !== 'shadowbot-switch-config' || bundle.version !== 1 || !Array.isArray(bundle.entries)) throw new Error('不是支持的 ShadowBot Switch 配置包。');
        const { id } = await apiText('/api/config/stage', box.text);
        box.stage = id;
        if (state.transfer !== box) { await discardTransfer(box); return; }
      }
      box.plan = unwrap(await api('/api/config/import', { ...scopedBody(), stage: box.stage, replace: box.replace, dryRun: true })).data;
    } catch (error) { box.error = error.message; }
  });
  const summary = box.plan && importSummary(box.plan, box.replace);
  const apply = () => configWrite(async () => {
    const { data } = unwrap(await api('/api/config/import', { ...scopedBody(), stage: box.stage, replace: box.replace, dryRun: false }));
    box.stage = null; announce(data);
    resetData();
    state.transfer.receipt = data.backup;
    await ensureData(state.page); loadCounts();
  });
  const requestImport = () => {
    const warning = hasDrafts() ? '未保存的编辑将保留，保存时会重新检查文件版本。' : '';
    if (box.replace) confirmDialog('覆盖导入', `将覆盖 ${summary.overwrites} 个文件、新建 ${summary.creates} 个文件。覆盖前会备份到 config-backups。${warning}`, '确认导入', apply);
    else apply();
  };
  const exportFile = () => configWrite(async () => {
    const result = await api('/api/config/export', scopedBody());
    const { data } = unwrap(result);
    const url = URL.createObjectURL(new Blob([result.content], { type: 'application/json' }));
    const link = h('a', { href: url, download: result.fileName });
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    if (data.warnings?.length) toast('已导出，但跳过了以下规则文件：\n' + data.warnings.join('\n'), 'warn');
    else toast('已导出 ' + result.fileName);
  });
  const kinds = { rules: '规则', settings: '设置', mcp: 'MCP', skill: 'Skill', other: '其它' };
  return [h('section', { class: 'facts' }, h('h2', null, '导出配置'), h('p', null, '导出范围：' + scopeLabel()),
    h('div', { class: 'actions' }, button('导出并下载', 'btn-secondary', exportFile, { disabled: writeDisabled() }))),
    h('section', { class: 'facts' }, h('h2', null, '导入配置'),
      segmented('import-source', '来源', [['file', '选择文件'], ['paste', '粘贴 JSON']], box.source, value => {
        if (value !== box.source) { discardTransfer(box); box.source = value; box.text = ''; box.error = null; box.file = ''; render(); }
      }, writeDisabled()),
      box.source === 'paste' ? h('textarea', { class: 'field mono', id: 'import-paste', 'aria-label': '配置包 JSON', value: box.text,
        disabled: writeDisabled(), oninput: event => { const expired = !!box.stage || !!box.error; discardTransfer(box); box.text = event.target.value; box.error = null; if (expired) render(); } }) :
        h('div', { class: 'editor-bar' }, h('input', { type: 'file', accept: '.json,application/json', 'aria-label': '选择配置包', disabled: writeDisabled(),
          onchange: event => {
            const file = event.target.files[0];
            if (!file) return;
            configWrite(async () => {
              await discardTransfer(box); box.error = null; box.text = ''; box.file = file.name;
              if (file.size > 32 * 1024 * 1024) { box.error = '配置包超过 32 MiB。'; return; }
              box.text = await file.text();
            });
          } }), box.file),
      segmented('import-mode', '导入模式', [['new', '仅新增（遇到同名文件整体停止）'], ['replace', '覆盖（先备份）']], box.replace ? 'replace' : 'new', value => {
        box.replace = value === 'replace'; if (box.stage) preview(); else render();
      }, writeDisabled()),
      h('div', { class: 'actions' }, button('预览导入', 'btn-secondary', preview, { disabled: writeDisabled() }),
        box.stage && button('取消导入', 'btn-text', () => { discardTransfer(box); state.transfer = editorState().transfer; render(); }, { disabled: writeDisabled() })),
      box.error && problemBlock(box.error), box.plan && [dataTable(['目标路径', '类型', '动作'], box.plan.files.map(f => [
        h('code', null, f.path), kinds[f.kind], h('span', { class: f.action === 'overwrite' ? 'warn' : 'ok' }, ACTIONS[f.action])])),
        box.plan.warnings.map(w => problemBlock(w)),
        summary.blocked && h('p', { class: 'warn' }, `有 ${summary.overwrites} 个同名文件，选择覆盖或先处理这些文件。`),
        h('div', { class: 'actions' }, button('导入', 'btn-primary', requestImport, { disabled: writeDisabled() || summary.blocked }))],
      box.receipt && h('p', null, '备份编号：', h('code', null, box.receipt), ' ', h('a', { href: '#/config/backups' }, '查看备份')))];
}

function backupsView() {
  const box = state.backups;
  if (box.error || !box.items) return box.error ? problemBlock(box.error, loadBackups) : loadingBlock();
  if (!box.items.length) return emptyState('folder', '还没有备份', '导入配置、移除 Skill/MCP、保存规则或设置时会自动备份。');
  const restore = item => configWrite(async () => {
    const { data } = await run('config.restore', { id: item.id, dryRun: true }, false);
    confirmDialog('恢复备份', [h('p', null, '恢复前会先把当前文件自动备份，可以再次恢复撤销。'),
      h('div', { class: 'preview' }, dataTable(['目标路径', '动作'], data.files.map(f => [h('code', null, f.target), ACTIONS[f.action]])))],
    '确认恢复', () => configWrite(async () => {
      const { data } = await run('config.restore', { id: item.id, dryRun: false }, false);
      toast([data.message, '恢复前备份：' + data.backup, data.next].join('\n'));
      resetData(); await ensureData(state.page); loadCounts();
    }));
  });
  const list = box.items.map(item => {
    const expanded = box.expanded === item.id;
    return [new Date(item.createdAt).toLocaleString(), item.damaged ? '清单损坏' : BACKUP_KINDS[item.kind], item.scope?.app || (item.scope ? '安装级' : '未知'),
      item.restorable ? item.fileCount : '—', h('div', { class: 'facts' },
        h('div', { class: 'actions' }, item.restorable && button(expanded ? '收起' : '展开', 'btn-text', () => { box.expanded = expanded ? null : item.id; render(); }),
          item.restorable && button('恢复', 'btn-secondary', () => restore(item), { disabled: writeDisabled() }),
          state.base.windows && button('打开文件夹', 'btn-text', () => openPath('folder', state.base.home + '/config-backups/' + item.id))),
        expanded && h('div', { class: 'preview' }, item.files.map(f => h('div', null, h('code', null, f.target), ' · ', ACTIONS[f.action])),
          item.truncated && '仅显示前 50 项。'))];
  });
  return [dataTable(['时间', '来源', '范围', '文件数', '操作'], list),
    box.items.length < box.total && button('加载更多', 'btn-secondary', () => loadBackups(true), { disabled: box.loading })];
}

function openAppDialog() {
  const input = h('input', { id: 'app-path', class: 'field mono', autocomplete: 'off', spellcheck: 'false' });
  const hint = h('div', { class: 'hint', role: 'status' });
  const pick = button('选择文件夹', 'btn-secondary', async () => {
    try { const { path } = await api('/api/pick-folder', { purpose: 'app' }); if (path) input.value = path; }
    catch (error) { setHint(hint, 'bad', error.message); }
  });
  let registered = false;
  const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, '添加');
  const dialog = openDialog('手动添加应用路径', 'add-app-title',
    h('div', { class: 'form-row' }, h('label', { for: 'app-path' }, '应用根目录'), h('div', { class: 'inline' }, input, state.base.windows && pick), hint),
    h('div', { class: 'dialog-foot' }, button('关闭', 'btn-secondary', () => dialog.close()), submit), async () => {
      if (registered) { dialog.close(); return; }
      if (!input.value.trim() || writeDisabled() || submit.disabled) return;
      submit.disabled = true;
      try {
        const { data } = await run('apps.add', { path: input.value.trim() }, false);
        await loadApps();
        if (data.warnings.length) {
          registered = true; input.disabled = true; pick.disabled = true; submit.textContent = '完成';
          setHint(hint, 'warn', data.warnings.join('\n'));
        } else dialog.close();
        changeScope(data.path);
      } catch (error) { setHint(hint, 'bad', error.message); }
      finally { submit.disabled = false; }
    });
  input.focus();
}

function appsView() {
  const sources = { running: '运行中', discovered: '自动发现', custom: '手动添加' };
  return [h('div', { class: 'actions' }, button('添加应用路径', 'btn-primary', openAppDialog, { disabled: writeDisabled() })),
    state.appsError ? problemBlock(state.appsError, loadApps) : state.apps.length ? dataTable(['名称', '路径', '来源', '状态', '操作'], state.apps.map((app, i) => {
      const key = 'custom-app-' + i;
      return [app.name, h('code', null, app.path), sources[app.source], app.exists ? '可用' : h('span', { class: 'bad' }, '目录不存在'),
        app.custom && (state.confirm === key ? confirmCell(key, '移除手动登记？', '移除', () => configWrite(async () => {
          announce((await run('apps.remove', { path: app.path }, false)).data); state.confirm = null; await loadApps();
        })) : button('移除', 'btn-text', () => askConfirm(key), { id: key + '-remove', disabled: writeDisabled() }))];
    })) : h('p', { class: 'muted' }, '还没有应用。')];
}

function runtimeSection() {
  const box = state.runtime;
  return h('section', { class: 'facts' }, h('h2', null, '运行中的 Copilot'),
    box.error ? problemBlock(box.error, loadRuntime) : !box.apps ? loadingBlock() : !box.apps.length ?
      h('p', { class: 'muted' }, '没有运行中的 Copilot。打开影刀 Copilot 后点重新检查。') : box.apps.map(app => {
        const names = new Set([...Object.keys(app.mcp || {}), ...Object.keys(app.errors || {})]);
        return h('article', { class: 'facts' }, h('strong', null, app.app),
          h('div', null, `PID ${app.pid} · ${app.harness || 'Copilot'} · ${app.configuration} · ${app.active} 个请求 · ${Math.max(0, Math.floor((Date.now() - app.updated) / 1000))} 秒前更新`),
          app.configurationError && problemBlock(app.configurationError), app.menuReconnect && h('p', { class: 'warn' }, '请重新连接 Copilot 以刷新菜单。'),
          names.size > 0 && dataTable(['MCP', '状态', '错误'], [...names].map(name => [name, app.mcp?.[name]?.status || '—', app.errors?.[name] || app.mcp?.[name]?.error || '—'])));
      }));
}

function logSection() {
  const box = state.log;
  return h('section', { class: 'facts' }, h('h2', null, '最近切换'),
    box.error ? problemBlock(box.error, loadLog) : !box.entries ? loadingBlock() :
      box.entries.length ? dataTable(['时间', '动作', '后端'], box.entries.map(e => [new Date(e.at).toLocaleString(), logLabel(e.action), e.from + ' → ' + e.to])) : '还没有切换记录。',
    box.skipped > 0 && h('p', { class: 'muted' }, `${box.skipped} 行记录无法解析，已跳过。`),
    box.entries && box.total > box.entries.length && button('加载更多', 'btn-secondary', () => loadLog(true), { disabled: box.loading }));
}

boot();
