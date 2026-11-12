import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { loadSkillsFromDir } from '@earendil-works/pi-coding-agent';
import type { Skill } from '@earendil-works/pi-coding-agent';
import type { Config } from '@opencode-ai/sdk/v2';
import { atomicWrite, readJson } from './installation.js';
import { decision } from './interactions.js';
import { copilot, object } from './config.js';
import { officialSkillDirectories } from './host-skills.js';
import type { SkillSources } from './host-skills.js';

export type UserSettings = { enabledSkills?: string[]; mcpPermission?: Record<string, 'allow' | 'ask' | 'deny'> };

export function userSettings(agentDir: string, root: string): UserSettings {
  let current: UserSettings = {};
  for (const path of [join(agentDir, 'shadowbot.json'), join(root, '.pi', 'shadowbot.json')]) {
    if (!existsSync(path)) continue;
    const file = readJson<UserSettings>(path);
    if (file.enabledSkills && (!Array.isArray(file.enabledSkills) || file.enabledSkills.some(name => typeof name !== 'string'))) {
      throw new Error('enabledSkills must be a list of skill names');
    }
    current = { enabledSkills: [...(current.enabledSkills ?? []), ...(file.enabledSkills ?? [])],
      mcpPermission: { ...current.mcpPermission, ...file.mcpPermission } };
  }
  return current;
}

export function skills(agentDir: string, root: string, sources: SkillSources, config: Config, agent = copilot) {
  const enabled = new Set(userSettings(agentDir, root).enabledSkills ?? []);
  const result = new Map<string, Skill>();
  const stock = process.env.SHADOWBOT_OPENCODE_SKILLS_DIR;
  const builtin = [sources.bridge, ...officialSkillDirectories(sources), ...(stock ? [stock] : []), ...(config.skills?.paths ?? [])];
  for (const path of builtin) {
    if (!existsSync(path) || !isAbsolute(path)) continue;
    for (const skill of loadSkillsFromDir({ dir: path, source: 'ShadowBot' }).skills) {
      if (decision('skill', skill.name, 'allow', config.permission, config.agent?.[agent]?.permission) !== 'deny') result.set(skill.name, skill);
    }
  }
  for (const path of [join(agentDir, 'skills'), join(root, '.pi', 'skills')]) {
    if (!existsSync(path)) continue;
    for (const skill of loadSkillsFromDir({ dir: path, source: 'custom' }).skills) {
      if (enabled.has(skill.name) && !result.has(skill.name)) result.set(skill.name, skill);
    }
  }
  return [...result.values()];
}

export function workspace(requestDirectory?: string) {
  const configured = process.env.SHADOWBOT_OPENCODE_WORKSPACE_ROOT;
  const root = configured || requestDirectory;
  if (!root || !isAbsolute(root) || !existsSync(root)) throw new Error('ShadowBot workspace root was not supplied');
  const normalized = realpathSync.native(root);
  if (/[\\/]opencode[\\/]runtime(?:[\\/]|$)/i.test(normalized)) throw new Error('The temporary OpenCode directory is not a project root');
  if (!statSync(normalized).isDirectory()) throw new Error('ShadowBot workspace root must be a directory');
  return normalized;
}

function loopback(value?: string) {
  if (!value) return undefined;
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) {
    throw new Error('ShadowBot local service URL is invalid');
  }
  return url;
}

function endpoint(base: URL | undefined, name: string) {
  if (!base) return undefined;
  const url = new URL(base);
  url.pathname = url.pathname.replace(/\/[^/]*$/, `/${name}`);
  return url;
}

function browserList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter(object).map(browser => ({
    name: browser.display_name ?? browser.product_name,
    mode: browser.mode ?? browser.web_type,
    tab_id: browser.tab_id ?? browser.browser_id,
  }));
}

function browserReminder(value: unknown) {
  if (!object(value)) return '';
  const preferred = browserList(value.available_browsers);
  const common = browserList(value.common_browsers);
  return [
    '[SHADOWBOT_BROWSER_PREFERENCE]',
    `宿主浏览器偏好（来源 ${String(value.preference_source ?? 'unresolved')}）\n${JSON.stringify(preferred).slice(0, 4000)}`,
    `常见浏览器映射\n${JSON.stringify(common).slice(0, 4000)}`,
    '使用 xbot API 的 mode 参数选择浏览器。用户指定产品时按映射选择 mode，未指定时优先使用首选列表中的第一项。新任务默认创建页面，操作已有页面时从当次证据确认页面标识。浏览器偏好仅提供产品和页面参考。通过实际页面确认登录状态。',
  ].join('\n');
}

export class ShadowBotContext {
  private evidence = loopback(process.env.SHADOWBOT_OPENCODE_EVIDENCE_URL);
  private runtime = loopback(process.env.SHADOWBOT_OPENCODE_RUNTIME_CONTEXT_URL);
  private preferences = endpoint(this.evidence, 'browser-preferences');
  private overlayUrl = endpoint(this.evidence, 'explorer-overlay');
  private trace = process.env.SHADOWBOT_OPENCODE_TRACE_ID ?? '';

  private async get(url: URL | undefined, init?: RequestInit) {
    if (!url) return undefined;
    const signal = init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000);
    const headers = { ...init?.headers, 'X-ShadowBot-Trace-Id': this.trace };
    const response = await fetch(url, { ...init, signal, headers, redirect: 'error' });
    if (!response.ok) throw new Error(`ShadowBot local service returned HTTP ${response.status}`);
    return await response.json();
  }

  async instructions(includeBrowser: boolean, signal: AbortSignal, requireRuntime = false) {
    const [runtime, browser] = await Promise.all([
      this.get(this.runtime, { signal }), includeBrowser ? this.get(this.preferences, { signal }) : undefined,
    ]);
    const context = runtime?.data ?? runtime?.Data;
    const snapshot = typeof context === 'string' ? context : context == null ? '' : JSON.stringify(context);
    if (requireRuntime && this.runtime && !snapshot.trim()) throw new Error('ShadowBot runtime context is unavailable');
    const preference = browser?.data ?? browser?.Data ?? browser;
    return [snapshot && `ShadowBot runtime context\n${snapshot.slice(0, 60_000)}`, browserReminder(preference)].filter(Boolean).join('\n\n');
  }

  async finalizedEvidence() {
    const envelope = await this.get(this.evidence);
    const id = String(envelope?.latest_finalized_task_id ?? '').trim();
    if (envelope?.finalized !== true || !object(envelope.snapshot) || !id || id !== String(envelope.task_id ?? '').trim()) return undefined;
    const snapshot = object(envelope.latest_finalized_snapshot) ? envelope.latest_finalized_snapshot : envelope.snapshot;
    return { snapshot: { ...snapshot, evidence_role: 'authoritative' }, id };
  }

  async overlay(phase: 'start' | 'end', sessionID: string, callID: string) {
    if (!this.overlayUrl) throw new Error('ShadowBot Explorer overlay endpoint is unavailable');
    const result = await this.get(this.overlayUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Phase: phase, SessionId: sessionID, CallId: callID }) });
    if (Number(result?.code ?? result?.Code) !== 0) throw new Error('ShadowBot Explorer overlay rejected the lifecycle event');
    const data = result.data ?? result.Data;
    return { recycled: data?.runtimeRecycled === true || data?.RuntimeRecycled === true };
  }

  async reportHealth(root: string) {
    const artifacts = process.env.SHADOWBOT_OPENCODE_REWRITE_DIR;
    if (!artifacts) return;
    await Promise.all([this.get(this.runtime), this.get(this.evidence), this.get(this.preferences)]);
    atomicWrite(join(artifacts, 'plugin-health.json'), JSON.stringify({
      plugin_loaded: true, plugin: 'shadowbot-context-rewrite', hook_contract_version: 6,
      exploration_evidence_handoff: Boolean(this.evidence), explorer_overlay_lifecycle: Boolean(this.overlayUrl),
      browser_preference_reminder: Boolean(this.preferences), system_environment_sanitization: true,
      session_id: process.env.SHADOWBOT_OPENCODE_REWRITE_SESSION_ID ?? '', trace_id: this.trace,
      artifact_dir: artifacts, workspace_root: root, mode: 'tool-output-limit-and-snapshot-lifecycle',
      evidence_url: this.evidence?.href ?? '', explorer_overlay_url: this.overlayUrl?.href ?? '', browser_preferences_url: this.preferences?.href ?? '',
    }));
  }
}

export function agentPrompt(config: Config, root: string, agent: string) {
  const prompt = config.agent?.[agent]?.prompt;
  if (!prompt) return '';
  return prompt.replace(/\{file:([^}]+)\}/g, (_, reference: string) => {
    const location = process.env.OPENCODE_CONFIG;
    const path = resolve(location ? dirname(location) : root, reference);
    return readFileSync(path, 'utf8');
  });
}
