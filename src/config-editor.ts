import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, unlinkSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { decodeRuleContent, inspectRuleFile, loadAgentRules, maxRuleBytes, ruleCandidates } from './agent-rules.js';
import { object } from './config.js';
import { backupScope, createBackup } from './config-backups.js';
import { appConfigDirectory, appConfigFiles, within } from './config-paths.js';
import { UserError } from './errors.js';
import { atomicWrite, readJson } from './installation.js';
import { mergeUserSettings, settingsFromFiles, validateUserSettings } from './shadowbot.js';
import type { UserSettings } from './shadowbot.js';

const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
function checkExpected(current: string, expected: string | undefined) {
  if (!expected || !/^(?:absent|[0-9a-f]{64})$/.test(expected)) throw new UserError('请提供有效的 --expect。', 'invalid');
  if (current !== expected) throw new UserError('文件已在别处修改，请重新加载后再保存。', 'conflict');
}
function writable(root: string, path: string) {
  try { return within(root, relative(root, path).split(sep).join('/')); }
  catch (error) { throw new UserError((error as Error).message, 'readonly'); }
}
function rulePathPresent(path: string) {
  try { return !!lstatSync(path, { throwIfNoEntry: false }); }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOTDIR'; }
}
export function ruleLayers(home: string, app?: string) {
  const runtime = loadAgentRules(join(home, 'agent'), app);
  return ruleCandidates(join(home, 'agent'), app).map(candidate => {
    const installation = candidate.scope === 'Installation';
    const scope = installation ? 'installation' : 'application';
    const [first, fallback] = candidate.paths;
    const rootExists = rulePathPresent(first);
    const path = fallback && !rootExists ? fallback : first;
    const location = installation ? 'installation' : path === first ? 'root' : 'fallback';
    const info = inspectRuleFile(path, candidate.root);
    return { ...info, scope, location, root: candidate.root, path, maxBytes: maxRuleBytes,
      editable: !info.readonlyReason && !info.tooLarge && info.utf8Valid,
      effective: runtime.files.some(f => f.path === path && !!f.content),
      warning: runtime.warnings.find(w => w.startsWith(path + '：')) ?? null,
      shadowed: fallback && path === first && rulePathPresent(fallback) ? { path: fallback } : null };
  });
}

export function editRules(home: string, app: string | undefined, scope: string | undefined, from: string | undefined, expect: string | undefined, remove: boolean) {
  if (scope !== 'installation' && !(scope === 'application' && app)) throw new UserError('请指定规则范围，应用级需要先选择应用。', 'invalid');
  let data: Buffer | undefined;
  if (!remove) {
    if (!from) throw new UserError('请提供 --from 规则文件。');
    data = readFileSync(from);
    try { decodeRuleContent(data); } catch (error) { throw new UserError((error as Error).message, 'invalid'); }
  }
  const root = scope === 'application' ? app : undefined;
  const layer = () => ruleLayers(home, root).find(l => l.scope === scope)!;
  const current = layer();
  const path = writable(root ?? home, current.path);
  if (current.readonlyReason) throw new UserError('规则路径只读，请直接编辑原文件。', 'readonly');
  checkExpected(current.sha256, expect);
  if (remove && !current.exists) throw new UserError('规则文件不存在。', 'conflict');
  const backup = current.exists ? createBackup(home, { kind: remove ? 'rules-remove' : 'rules-save', scope: backupScope(root),
    entries: [{ target: path, stored: 'AGENTS.md', type: 'file' }] }).id : null;
  const latest = layer();
  if (latest.path !== path) throw new UserError('规则路径已变化，请重新加载。', 'conflict');
  writable(root ?? home, path);
  if (latest.readonlyReason) throw new UserError('规则路径只读，请重新加载。', 'readonly');
  checkExpected(latest.sha256, expect);
  const next = '下一轮对话生效';
  if (data !== undefined) {
    atomicWrite(path, data);
    return { message: '已保存规则。', path, bytes: data.length, sha256: digest(data), backup, next };
  }
  unlinkSync(path);
  const after = layer();
  return { message: '已删除规则。', path, backup, fallbackActive: after.location === 'fallback' && after.effective, next };
}

const permissionList = (settings: UserSettings) => Object.entries(settings.mcpPermission ?? {}).map(([pattern, action]) => ({ pattern, action }));
export function appThinkingWarnings(app?: string) {
  return appConfigFiles(app, 'shadowbot.json').filter(path => existsSync(path) && Object.hasOwn(readJson<object>(path), 'thinkingCommand'))
    .map(path => `${path}：thinkingCommand 只在安装级生效。`);
}
function settingsBytes(path: string) {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info) return null;
  if (!info.isFile()) throw new UserError(`设置不是普通文件：${path}`, 'readonly');
  return readFileSync(path);
}

function parseSettings(path: string, data: Buffer | null) {
  if (!data) return {};
  try {
    return validateUserSettings(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)), path);
  } catch (error) {
    const reason = error instanceof UserError ? error.message : '需要有效的 UTF-8 JSON。';
    throw new UserError(`${path} 格式有误，请先用记事本修复。\n${reason}`, 'invalid');
  }
}
export function showSettings(home: string, app: string | undefined, supported: boolean, hostOverride: boolean) {
  const agent = join(home, 'agent'), path = join(app ? appConfigDirectory(app) : agent, 'shadowbot.json');
  const base = { scope: app ? 'application' : 'installation', path, exists: existsSync(path),
    thinking: { supported, hostOverride, menuEnabled: false } };
  let sha256: string | null = base.exists ? null : 'absent';
  try {
    writable(app ?? home, path);
    const bytes = settingsBytes(path);
    sha256 = bytes ? digest(bytes) : 'absent';
    const value: UserSettings = parseSettings(path, bytes);
    const installation = app ? settingsFromFiles([join(agent, 'shadowbot.json')]) : value;
    const localFiles = appConfigFiles(app, 'shadowbot.json');
    const local = app ? mergeUserSettings(settingsFromFiles(localFiles.slice(0, -1)), value) : {};
    const effective = mergeUserSettings(installation, local);
    const enabled = installation.thinkingCommand !== false;
    return { ...base, sha256, error: null, thinking: { supported, hostOverride, menuEnabled: enabled && supported && !hostOverride },
      applicationPatterns: Object.keys(local.mcpPermission ?? {}),
      file: { mcpPermission: permissionList(value), thinkingCommand: value.thinkingCommand ?? null,
        otherKeys: Object.keys(value).filter(k => k !== 'thinkingCommand' && k !== 'mcpPermission') },
      inherited: app ? { mcpPermission: permissionList(installation), thinkingCommand: installation.thinkingCommand ?? null } : null,
      effective: { mcpPermission: permissionList(effective), thinkingCommand: enabled }, warnings: appThinkingWarnings(app) };
  } catch (error) { return { ...base, sha256, file: null, inherited: null, effective: null, error: (error as Error).message, warnings: [] }; }
}

export function saveSettings(home: string, app: string | undefined, from: string, expect: string | undefined) {
  const path = writable(app ?? home, join(app ? appConfigDirectory(app) : join(home, 'agent'), 'shadowbot.json'));
  const previous = settingsBytes(path);
  const current = parseSettings(path, previous);
  checkExpected(previous ? digest(previous) : 'absent', expect);
  let patch: unknown;
  try { patch = readJson(from); } catch (error) { throw new UserError((error as Error).message, 'invalid'); }
  if (!object(patch) || patch.version !== 1 || Object.keys(patch).some(k => !['version','mcpPermission','thinkingCommand'].includes(k))) throw new UserError('设置补丁格式无效。', 'invalid');
  const next: UserSettings = { ...current };
  if (Object.hasOwn(patch, 'mcpPermission')) {
    const rows = patch.mcpPermission;
    if (!Array.isArray(rows) || rows.length > 200) throw new UserError('授权规则最多 200 条。', 'invalid');
    const seen = new Set<string>();
    for (const row of rows) {
      if (!object(row) || typeof row.pattern !== 'string' || !/^[^\s\x00-\x1f\x7f-\x9f]{1,128}$/u.test(row.pattern) ||
        seen.has(row.pattern) || typeof row.action !== 'string' || !['allow', 'ask', 'deny'].includes(row.action)) throw new UserError('授权通配或操作无效，规则不能重复。', 'invalid');
      seen.add(row.pattern);
    }
    if (rows.length) next.mcpPermission = Object.fromEntries(rows.map(row => [row.pattern, row.action]));
    else delete next.mcpPermission;
  }
  if (Object.hasOwn(patch, 'thinkingCommand')) {
    if (patch.thinkingCommand === null) delete next.thinkingCommand;
    else if (!app && typeof patch.thinkingCommand === 'boolean') next.thinkingCommand = patch.thinkingCommand;
    else throw new UserError('thinkingCommand 必须是布尔值，只在安装级生效。', 'invalid');
  }
  validateUserSettings(next, path);
  const backup = previous ? createBackup(home, { kind: 'settings-save', scope: backupScope(app),
    entries: [{ target: path, stored: 'shadowbot.json', type: 'file' }] }).id : null;
  writable(app ?? home, path);
  checkExpected(existsSync(path) ? digest(readFileSync(path)) : 'absent', expect);
  const bytes = Buffer.from(JSON.stringify(next, null, 2) + '\n');
  atomicWrite(path, bytes);
  return { path, sha256: digest(bytes), backup };
}
