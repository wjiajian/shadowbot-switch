import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { loadSkillsFromDir, VERSION as piVersion } from '@earendil-works/pi-coding-agent';
import { HostConfig, object } from './config.js';
import { UserError, userMessage } from './errors.js';
import { skillSources } from './host-skills.js';
import { atomicWrite, mode, originalHash, protocolVersion, readJson, runtimeDirectory, sha256 } from './installation.js';
import type { Installation } from './installation.js';
import { customMcp, McpHub, validateCustomMcp } from './mcp.js';
import { runtimeStates } from './runtime-state.js';
import { skillInventory, userSettings, validateUserSettings } from './shadowbot.js';
import { syncSkillCommands } from './skill-commands.js';
import { verifySchema } from './switch.js';

const help = `ShadowBot Switch
  use pi | use original       安装或切换后端
  status / doctor             状态摘要 / 完整诊断
  reload                      同步菜单并安排配置刷新
  skills [list]               列出所有 Skill、来源和未启用原因
  skills add <目录>            安装一个 Skill 文件夹
  skills enable|disable|remove <名称>
  mcp [list]                  查看配置（不启动服务）
  mcp test [名称]             在当前终端环境中检查连接
  mcp status                  查看运行中的 Copilot MCP 状态
  mcp add <名称> --url <URL>
  mcp add <名称> --command <程序> --arg <参数> [--arg <参数>]
  mcp enable|disable|remove <名称>
  config open [mcp|skills]     创建并打开配置文件
  config check                检查配置及路径
  config export <文件>        导出安装级或所选应用配置
  config import <文件> [--replace]
  apps [list|select|clear]     选择并记住应用；clear 恢复安装级范围
  update                      应用当前源码及其锁定的 Pi 版本
  repair                      修复本项目搬迁后的定位，再完成待恢复操作
  help                        此帮助不要求已安装

默认范围为安装级；apps select 后记住所选应用。
--global 忽略记忆选择；--app <路径> 指定应用；--json 输出机器可读结果。
Skill 内容和权限下一轮生效，MCP 在应用空闲后的下一轮自动刷新。
影刀原生 / 菜单更新后需要重新连接 Copilot。`;

type Options = { args: string[]; flags: Set<string>; values: Map<string, string[]> };
function options(input: string[]): Options {
  const result: Options = { args: [], flags: new Set(), values: new Map() };
  for (let i = 0; i < input.length; i++) {
    const token = input[i];
    if (!token.startsWith('--')) { result.args.push(token); continue; }
    const [key, inline] = token.slice(2).split(/=(.*)/s, 2);
    if (['json', 'global', 'replace'].includes(key)) { result.flags.add(key); continue; }
    if (!['app', 'url', 'command', 'arg', 'cwd', 'permission'].includes(key)) throw new UserError(`未知选项 ${token}。运行 help 查看用法。`);
    const value = inline ?? input[++i];
    if (value === undefined) throw new UserError(`${token} 需要一个值。`);
    result.values.set(key, [...(result.values.get(key) ?? []), value]);
  }
  if (result.flags.has('global') && result.values.has('app')) throw new UserError('--global 与 --app 不能同时使用。');
  return result;
}

function writeJson(path: string, value: unknown) { atomicWrite(path, JSON.stringify(value, null, 2) + '\n'); }
const labels: Record<string, string> = { name: '名称', status: '状态', state: '状态', source: '来源', path: '路径', reason: '说明', description: '描述',
  backend: '当前后端', recoveryPending: '需要恢复', applications: '应用', app: '应用目录', active: '运行中的任务', configuration: '配置状态',
  errors: '配置问题', error: '错误', next: '下一步', message: '结果', menu: '菜单同步', menuHint: '菜单提示', added: '新增', updated: '更新', removed: '删除',
  unchanged: '未变化', conflicts: '同名冲突', check: '检查项', detail: '说明', files: '文件数', valid: '配置有效', warnings: '路径问题', transport: '传输',
  enabled: '已启用', disabled: '已禁用', shadowed: '同名来源覆盖', invalid: '格式错误', warning: '可加载但有提示', installation: '安装级', official: '影刀内置', legacy: '旧目录',
  connected: '已连接', failed: '失败' };
function human(value: unknown, prefix = ''): void {
  if (Array.isArray(value)) {
    if (!value.length) { console.log(`${prefix}无`); return; }
    if (value.every(item => object(item) && Object.values(item).every(v => v === null || typeof v !== 'object'))) {
      console.table(value.map(item => Object.fromEntries(Object.entries(item).map(([key, val]) => [labels[key] ?? key, typeof val === 'string' ? labels[val] ?? val : val]))));
    } else for (const item of value) human(item, prefix + '  ');
  } else if (object(value)) {
    for (const [key, val] of Object.entries(value)) {
      if (val === undefined) continue;
      const label = labels[key] ?? key;
      if (val !== null && typeof val === 'object') { console.log(`${prefix}${label}：`); human(val, prefix + '  '); }
      else console.log(`${prefix}${label}：${typeof val === 'boolean' ? val ? '是' : '否' : String(val)}`);
    }
  } else console.log(prefix + String(value));
}
function required(value: string | undefined, label: string): string {
  if (!value) throw new UserError(`请提供${label}。运行 help 查看用法。`);
  return value;
}
function selectedApp(home: string, opts: Options) {
  if (opts.flags.has('global')) return undefined;
  const pref = join(home, 'preferences.json');
  const input = opts.values.get('app')?.at(-1) ?? (existsSync(pref) ? readJson<{ app?: string }>(pref).app : undefined);
  if (!input) return undefined;
  const path = resolve(input);
  if (!existsSync(path) || !lstatSync(path).isDirectory()) throw new UserError(`应用目录不存在：${path}。使用 --app 指定目录，或 apps clear 清除记忆。`);
  return realpathSync.native(path);
}
function skillRows(home: string, install: Installation, app?: string) {
  return skillInventory(join(home, 'agent'), app, skillSources(home, install), new HostConfig().value);
}
function menuSync(home: string, install: Installation) {
  return syncSkillCommands(install.resources, mode(home) === 'pi'
    ? skillRows(home, install).filter(row => row.source !== 'official' && row.status === 'enabled').map(row => row.skill!) : undefined);
}

export function applicationList(home: string, install: Installation) {
  const paths = new Set(runtimeStates(home, true).map(state => state.root));
  const directories = (path: string) => existsSync(path) ? readdirSync(path, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).map(entry => join(path, entry.name)) : [];
  for (const user of directories(install.users)) for (const app of directories(join(user, 'apps'))) paths.add(app);
  return [...paths].filter(existsSync).sort().map(path => ({ name: basename(path), path }));
}

function safeTree(root: string): { path: string; data: string }[] {
  if (!existsSync(root)) return [];
  if (lstatSync(root).isSymbolicLink()) throw new UserError(`配置目录包含链接，不能复制：${root}`);
  const entries: { path: string; data: string }[] = [];
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const file = join(folder, entry.name);
      if (entry.isSymbolicLink()) throw new UserError(`配置目录包含链接，不能复制：${file}`);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) entries.push({ path: relative(root, file).split(sep).join('/'), data: readFileSync(file).toString('base64') });
    }
  };
  walk(root);
  return entries;
}

function within(root: string, name: string) {
  if (!name || name.includes('\\') || name.split('/').some(p => !p || p === '.' || p === '..' || /[:\x00-\x1f]/.test(p))) throw new UserError(`无效配置路径：${name}`);
  const path = resolve(root, name);
  if (!path.startsWith(resolve(root) + sep)) throw new UserError('配置路径越出了目标目录。');
  let cursor = root;
  for (const part of name.split('/')) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new UserError(`目标目录包含链接：${cursor}`);
    cursor = join(cursor, part);
  }
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new UserError(`目标文件是链接：${path}`);
  return path;
}

function pathWarnings(value: unknown, path = ''): string[] {
  if (typeof value === 'string' && (isAbsolute(value) || /^[A-Z]:[\\/]/i.test(value)) && !existsSync(value)) return [`${path}：路径不存在 ${value}`];
  if (Array.isArray(value)) return value.flatMap((item, i) => pathWarnings(item, `${path}[${i}]`));
  return object(value) ? Object.entries(value).flatMap(([key, item]) => pathWarnings(item, `${path}.${key}`)) : [];
}

export async function manage(home: string, install: Installation, input: string[]) {
  const opts = options(input);
  const [command, action = 'list', target] = opts.args;
  const app = ['skills', 'mcp', 'config', 'doctor'].includes(command) ? selectedApp(home, opts) : undefined;
  const directory = app ? join(app, '.pi') : join(home, 'agent');
  const scope = app ? `应用：${app}` : '此安装下的所有应用';
  const emit = (value: unknown, title = scope) => {
    if (opts.flags.has('json')) console.log(JSON.stringify({ scope, data: value }, null, 2));
    else {
      console.log(title);
      human(value);
    }
  };
  const settingsFile = join(directory, 'shadowbot.json');
  const mcpFile = join(directory, 'mcp.json');
  const changed = (message: string) => {
    const menu = menuSync(home, install);
    emit({ message, menu, next: menu.added + menu.updated + menu.removed ? '下一轮读取最新配置；重新连接 Copilot 刷新 / 菜单。' : '应用空闲后的下一轮自动生效。' });
  };
  if (command === 'help') { console.log(help); return; }
  if (command === 'status') {
    const states = runtimeStates(home);
    emit({ backend: mode(home) === 'pi' ? `Pi ${install.piVersion ?? piVersion}` : `影刀原版 OpenCode ${protocolVersion}`,
      recoveryPending: ['activation.pending.json', 'switch.pending.json'].some(file => existsSync(join(home, file))),
      applications: states.map(s => ({ app: s.root, active: s.active, configuration: s.configurationError || Object.keys(s.errors).length ? '失败（原可用连接已保留）' : s.pending ? '待应用' : '已应用', errors: s.errors })),
      next: '运行 doctor 查看完整诊断；use pi / use original 切换后端。' }, 'ShadowBot Switch 状态');
    return;
  }
  if (command === 'apps') {
    if (action === 'clear') { writeJson(join(home, 'preferences.json'), {}); emit('已恢复安装级默认范围。'); return; }
    const apps = applicationList(home, install);
    if (action === 'list') { emit(apps); return; }
    if (action !== 'select') throw new UserError('apps 支持 list、select、clear。');
    let chosen = target;
    if (!chosen) {
      if (!process.stdin.isTTY) throw new UserError('请使用 apps select <应用路径>，或在交互终端中选择。');
      console.table(apps.map((item, i) => ({ number: i + 1, ...item })));
      const reader = createInterface({ input: process.stdin, output: process.stdout });
      try { chosen = await reader.question('输入编号或应用完整路径：'); } finally { reader.close(); }
    }
    const path = /^\d+$/.test(chosen) ? apps[Number(chosen) - 1]?.path : resolve(chosen);
    if (!path || !existsSync(path) || !lstatSync(path).isDirectory()) throw new UserError('请选择存在的应用目录。');
    writeJson(join(home, 'preferences.json'), { app: realpathSync.native(path) });
    emit(`已记住应用：${path}。使用 --global 可临时查看安装级配置。`);
    return;
  }
  if (command === 'reload') {
    const menu = menuSync(home, install);
    const request = randomUUID();
    atomicWrite(join(home, 'reload.request'), request + '\n');
    const states = runtimeStates(home);
    emit({ menu, applications: states.map(s => ({ app: s.root, state: s.active ? '运行中，下一次空闲请求应用' : '等待下一次请求应用' })),
      next: states.length ? '运行 status 或 mcp status 查看实际生效结果。' : '当前没有已登记的运行实例；下次打开 Copilot 时读取配置。',
      menuHint: menu.added + menu.updated + menu.removed ? '菜单已同步，重新连接 Copilot 后显示。' : '菜单没有变化，无需为菜单重连。' });
    return;
  }
  if (command === 'skills') {
    if (action === 'list') {
      emit(skillRows(home, install, app).map(({ name, description, path, source, status, reason }) => ({ name, status, source, path, reason: reason ?? '', description })));
      return;
    }
    const name = required(target, action === 'add' ? 'Skill 目录' : 'Skill 名称');
    if (action === 'add') {
      const source = resolve(name);
      if (!existsSync(source) || !lstatSync(source).isDirectory()) throw new UserError(`Skill 目录不存在：${source}`);
      const loaded = loadSkillsFromDir({ dir: source, source: 'custom' });
      if (loaded.skills.length !== 1 || !existsSync(join(source, 'SKILL.md'))) throw new UserError('请指定包含单个 SKILL.md 的 Skill 文件夹。');
      const skill = loaded.skills[0];
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name) || loaded.diagnostics.some(d => d.type === 'error')) throw new UserError('Skill 名称或内容无效。请检查 SKILL.md 的 name、description。');
      if (skillRows(home, install, app).some(row => row.source === 'official' && row.name === skill.name)) throw new UserError(`Skill 名称 ${skill.name} 由影刀内置 Skill 使用。请修改自定义 Skill 的 name。`);
      safeTree(source);
      const destination = join(app ? directory : home, 'skills', skill.name);
      if (existsSync(destination)) throw new UserError(`Skill 已存在：${destination}。直接编辑原文件，或先运行 skills remove。`);
      cpSync(source, destination, { recursive: true, errorOnExist: true, force: false });
      changed(`已添加 ${skill.name}`);
      return;
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new UserError('无效 Skill 名称。');
    if (action === 'remove') {
      const source = join(app ? directory : home, 'skills', name);
      if (!existsSync(source)) throw new UserError(`当前范围没有此 Skill：${name}。旧目录 Skill 可使用 disable。`);
      const destination = join(home, 'config-backups', randomUUID(), name);
      mkdirSync(dirname(destination), { recursive: true });
      renameSync(source, destination);
      changed(`已移除 ${name}，备份保留在 ${destination}`);
      return;
    }
    if (!['enable', 'disable'].includes(action)) throw new UserError('skills 支持 list、add、enable、disable、remove。');
    const matches = skillRows(home, install, app).filter(row => row.name === name);
    if (!matches.length) throw new UserError(`找不到 Skill ${name}。运行 skills 查看名称和范围。`);
    if (matches.some(row => row.source === 'official')) throw new UserError(`Skill ${name} 由影刀权限设置管理，请在宿主中调整。`);
    const settings = existsSync(settingsFile) ? readJson<Record<string, unknown>>(settingsFile) : {};
    userSettings(join(home, 'agent'), app);
    for (const key of ['enabledSkills', 'disabledSkills']) settings[key] = (settings[key] as string[] | undefined ?? []).filter(item => item !== name);
    (settings[action === 'enable' ? 'enabledSkills' : 'disabledSkills'] as string[]).push(name);
    writeJson(settingsFile, settings);
    changed(`已${action === 'enable' ? '启用' : '禁用'} ${name}`);
    return;
  }
  if (command === 'mcp') {
    if (action === 'status') {
      emit(runtimeStates(home).filter(s => !app || s.root.toLowerCase() === app.toLowerCase()).map(s => ({ app: s.root, pid: s.pid, configuration: s.configurationError ?? (Object.keys(s.errors).length ? '部分配置失败，保留原连接' : s.pending ? '待应用' : '已应用'), mcp: s.mcp, errors: s.errors })), '正在运行的 Copilot 状态（最多延迟 2 秒）');
      return;
    }
    const entries = customMcp(join(home, 'agent'), app);
    if (action === 'list') {
      const local = existsSync(mcpFile) ? readJson<{ mcpServers: Record<string, unknown> }>(mcpFile).mcpServers : {};
      emit([...entries].map(([name, raw]) => {
        try { const c = validateCustomMcp(name, raw); return { name, state: c.enabled === false ? '已禁用' : '已配置', transport: 'command' in c ? 'stdio' : 'http', source: app && Object.hasOwn(local, name) ? mcpFile : join(home, 'agent', 'mcp.json') }; }
        catch (error) { return { name, state: '配置错误', error: userMessage(error) }; }
      }));
      return;
    }
    if (action === 'test') {
      if (target && !entries.has(target)) throw new UserError(`MCP ${target} 未配置。运行 mcp list 查看名称。`);
      const hub = new McpHub(app ?? dirname(home));
      try {
        await hub.reloadCustom(target ? new Map([[target, entries.get(target)]]) : entries);
        emit(Object.entries(hub.status()).map(([name, state]) => ({ name, ...state })), '独立连接检查：使用当前终端环境，不代表 Copilot 的现有连接');
        if (Object.values(hub.status()).some(s => s.status === 'failed')) process.exitCode = 1;
      } finally { await hub.close(); }
      return;
    }
    const name = required(target, 'MCP 名称');
    const content = existsSync(mcpFile) ? readJson<{ mcpServers: Record<string, unknown> }>(mcpFile) : { mcpServers: {} };
    if (!object(content.mcpServers)) throw new UserError(`${mcpFile} 必须包含 mcpServers 对象。`);
    if (action === 'add') {
      if (Object.hasOwn(content.mcpServers, name)) throw new UserError(`当前范围已配置 ${name}。使用 config open mcp 编辑。`);
      const url = opts.values.get('url')?.at(-1), executable = opts.values.get('command')?.at(-1);
      if (Boolean(url) === Boolean(executable)) throw new UserError('请提供 --url 或 --command 中的一个。');
      const raw = url ? { type: 'http', url } : { type: 'stdio', command: executable, args: opts.values.get('arg') ?? [], cwd: opts.values.get('cwd')?.at(-1) };
      content.mcpServers[name] = validateCustomMcp(name, raw);
      const permission = opts.values.get('permission')?.at(-1);
      if (permission) {
        if (!['allow', 'ask', 'deny'].includes(permission)) throw new UserError('--permission 只能是 allow、ask 或 deny。');
        userSettings(join(home, 'agent'), app);
        const settings = existsSync(settingsFile) ? readJson<Record<string, unknown>>(settingsFile) : {};
        settings.mcpPermission = { ...(object(settings.mcpPermission) ? settings.mcpPermission : {}), [`${name}_*`]: permission };
        writeJson(settingsFile, settings);
      }
    } else if (action === 'enable' || action === 'disable') {
      const raw = entries.get(name);
      if (!raw) throw new UserError(`MCP ${name} 未配置。`);
      validateCustomMcp(name, raw);
      content.mcpServers[name] = { ...(object(content.mcpServers[name]) ? content.mcpServers[name] : {}), enabled: action === 'enable' };
    } else if (action === 'remove') {
      if (!Object.hasOwn(content.mcpServers, name)) throw new UserError(`当前范围没有 ${name}；若继承自安装级，可使用 disable。`);
      delete content.mcpServers[name];
    } else throw new UserError('mcp 支持 list、test、status、add、enable、disable、remove。');
    writeJson(mcpFile, content);
    changed(`已保存 MCP ${name}`);
    return;
  }
  if (command === 'config') {
    if (action === 'open') {
      if (target && !['mcp', 'skills'].includes(target)) throw new UserError('config open 支持 mcp 或 skills。');
      const path = target === 'skills' ? settingsFile : mcpFile;
      if (!existsSync(path)) writeJson(path, target === 'skills' ? { disabledSkills: [], mcpPermission: {} } : { mcpServers: {} });
      const child = spawn('notepad.exe', [path], { detached: true, stdio: 'ignore', windowsHide: false });
      child.on('error', () => console.error(`无法打开编辑器，请手动打开 ${path}`));
      child.unref();
      emit({ path });
      return;
    }
    if (action === 'check') {
      userSettings(join(home, 'agent'), app);
      const entries = customMcp(join(home, 'agent'), app);
      for (const [name, value] of entries) validateCustomMcp(name, value);
      const warnings = [...entries].flatMap(([name, raw]) => pathWarnings(raw, name));
      const errors = skillRows(home, install, app).filter(row => row.status === 'invalid').map(({ path, reason }) => ({ path, reason }));
      emit({ valid: !errors.length && !warnings.length, warnings, skills: errors });
      if (warnings.length || errors.length) process.exitCode = 1;
      return;
    }
    if (action === 'export') {
      const path = resolve(required(target, '导出文件路径'));
      if (existsSync(path) && !opts.flags.has('replace')) throw new UserError('导出文件已存在。换一个路径或使用 --replace。');
      const entries = app ? safeTree(directory).map(e => ({ ...e, path: `agent/${e.path}` })) : [
        ...safeTree(join(home, 'skills')).map(e => ({ ...e, path: `skills/${e.path}` })),
        ...safeTree(join(home, 'agent')).map(e => ({ ...e, path: `agent/${e.path}` })),
      ];
      writeJson(path, { format: 'shadowbot-switch-config', version: 1, entries });
      emit({ path, files: entries.length });
      return;
    }
    if (action === 'import') {
      const bundle = readJson<{ format: string; version: number; entries: { path: string; data: string }[] }>(resolve(required(target, '导入文件路径')));
      if (bundle.format !== 'shadowbot-switch-config' || bundle.version !== 1 || !Array.isArray(bundle.entries)) throw new UserError('不是支持的 ShadowBot Switch 配置包。');
      const seen = new Set<string>();
      const importedWarnings: string[] = [];
      const prepared = bundle.entries.map(entry => {
        if (typeof entry.path !== 'string' || typeof entry.data !== 'string' || !/^(skills|agent)\//.test(entry.path)) throw new UserError('配置包中存在无效文件。');
        const name = app ? entry.path.replace(/^agent\//, '') : entry.path;
        const path = within(app ? directory : home, name);
        if (seen.has(path.toLowerCase())) throw new UserError(`配置包中存在重复文件：${name}`);
        seen.add(path.toLowerCase());
        if (existsSync(path) && !opts.flags.has('replace')) throw new UserError(`文件已存在：${path}。使用 --replace 时会先备份。`);
        const data = Buffer.from(entry.data, 'base64');
        if (name.endsWith('.json')) {
          let parsed: unknown;
          try { parsed = JSON.parse(data.toString('utf8').replace(/^\uFEFF/, '')); } catch { throw new UserError(`导入文件 JSON 无效：${name}`); }
          if (basename(name) === 'shadowbot.json') validateUserSettings(parsed, name);
          if (basename(name) === 'mcp.json') {
            if (!object(parsed) || !object(parsed.mcpServers)) throw new UserError(`${name} 必须包含 mcpServers 对象。`);
            const inherited = app ? customMcp(join(home, 'agent')) : new Map();
            for (const [server, raw] of Object.entries(parsed.mcpServers)) {
              const base = inherited.get(server);
              validateCustomMcp(server, object(raw) && object(base) && !('url' in raw) && !('command' in raw) ? { ...base, ...raw } : raw);
            }
          }
          importedWarnings.push(...pathWarnings(parsed, name));
        }
        return { path, name, data, previous: existsSync(path) ? readFileSync(path) : undefined };
      });
      const backup = join(home, 'config-backups', randomUUID());
      for (const entry of prepared) if (entry.previous) atomicWrite(join(backup, entry.name), entry.previous);
      const applied: typeof prepared = [];
      try {
        for (const entry of prepared) { atomicWrite(entry.path, entry.data); applied.push(entry); }
      } catch {
        for (const entry of applied.reverse()) {
          if (entry.previous) atomicWrite(entry.path, entry.previous); else unlinkSync(entry.path);
        }
        throw new UserError(`导入写入失败，已恢复原配置。检查目录权限。备份：${backup}`);
      }
      changed(`已导入 ${prepared.length} 个文件。覆盖前备份：${backup}。${importedWarnings.length ? importedWarnings.join('\n') : '绝对路径检查通过。'}`);
      return;
    }
    throw new UserError('config 支持 open、check、export、import。');
  }
  if (command === 'doctor') {
    const checks: { check: string; status: string; detail: string }[] = [];
    const check = async (name: string, fn: () => unknown | Promise<unknown>, hint: string) => {
      try { await fn(); checks.push({ check: name, status: '通过', detail: '' }); }
      catch (error) { checks.push({ check: name, status: '失败', detail: userMessage(error, hint) }); }
    };
    await check('原程序备份', () => { if (sha256(join(home, 'original', 'opencode.exe')) !== originalHash) throw new Error(); }, '原程序备份缺失或校验不符。恢复正确安装包后运行 use pi。');
    await check('运行时', async () => { if (process.version !== 'v24.22.3' || (install.piVersion && install.piVersion !== piVersion)) throw new Error(); await import('./runner.js'); }, '运行时版本或依赖不匹配。运行 update 从当前源码重建。');
    await check('活动程序', () => { const expected = mode(home) === 'pi' ? install.launcherHash.toLowerCase() : originalHash; if (sha256(install.agentPath) !== expected) throw new Error(); }, '活动程序与当前后端不匹配。关闭影刀后运行 repair。');
    await check('会话数据库', () => verifySchema(install.database, readFileSync(join(runtimeDirectory(home, install), 'schema.sql'), 'utf8')), '会话库结构或完整性不匹配。确认影刀版本为 6.3.39，并保留数据进行恢复。');
    await check('Skills 配置', () => { const errors = skillRows(home, install, app).filter(r => r.status === 'invalid'); if (errors.length) throw new UserError(errors.map(r => `${r.path}：${r.reason}`).join('\n')); }, '运行 skills 查看配置问题。');
    await check('MCP 配置', () => { for (const [name, raw] of customMcp(join(home, 'agent'), app)) validateCustomMcp(name, raw); }, '运行 config open mcp 修复配置。');
    await check('恢复状态', () => { if (['activation.pending.json', 'switch.pending.json'].some(file => existsSync(join(home, file)))) throw new UserError('上次操作尚未完成。关闭影刀后运行 repair。'); }, '运行 repair。');
    emit(checks, `安装诊断 · ${scope}`);
    if (checks.some(c => c.status === '失败')) process.exitCode = 1;
    return;
  }
  throw new UserError(`未知命令 ${command ?? ''}。运行 .\\switch.ps1 help 查看用法。`);
}

export const managementHelp = help;
