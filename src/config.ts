import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Auth, Config, Provider } from '@opencode-ai/sdk/v2';
import { readJson } from './installation.js';

type ObjectMap = Record<string, unknown>;
export const emptyTokens = () => ({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });
export const copilot = 'shadowbot-copilot';
export const explorer = 'shadowbot-explorer';

export function modelSelection(value?: string) {
  if (typeof value !== 'string') return undefined;
  const sep = value.indexOf('/');
  if (sep < 1 || sep === value.length - 1) return undefined;
  return { providerID: value.slice(0, sep), modelID: value.slice(sep + 1) };
}

function merge(base: ObjectMap, patch: ObjectMap): ObjectMap {
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
    const previous = result[key];
    result[key] = object(value) && object(previous) ? merge(previous, value) : value;
  }
  return result;
}

export function object(value: unknown): value is ObjectMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function initialConfig(): Config {
  const baseDir = process.env.OPENCODE_CONFIG_DIR;
  const dataConfig = process.env.XDG_CONFIG_HOME;
  const paths = [dataConfig && join(dataConfig, 'opencode', 'opencode.json'), baseDir && join(baseDir, 'opencode.json')];
  let base: ObjectMap = {};
  for (const path of paths) if (path && existsSync(path)) base = merge(base, readJson<ObjectMap>(path));
  const file = process.env.OPENCODE_CONFIG;
  if (file) base = merge(base, readJson<ObjectMap>(file));
  const content = process.env.OPENCODE_CONFIG_CONTENT;
  return (content ? merge(base, JSON.parse(content)) : base) as Config;
}

export class HostConfig {
  value = initialConfig();
  protected auth = new Map<string, Auth>();

  constructor() {
    const data = process.env.XDG_DATA_HOME;
    const path = data && join(data, 'opencode', 'auth.json');
    if (path && existsSync(path)) this.auth = new Map(Object.entries(readJson<Record<string, Auth>>(path)));
  }

  patch(value: ObjectMap) {
    const updated = merge(this.value as ObjectMap, value);
    for (const name of ['provider', 'agent', 'command', 'mcp']) {
      if (updated[name] !== undefined && !object(updated[name])) throw new Error(`Invalid configuration field ${name}`);
    }
    if (object(updated.provider) && Object.values(updated.provider).some(provider => !object(provider) ||
      (provider.models !== undefined && !object(provider.models)))) throw new Error('Invalid provider configuration');
    this.value = updated as Config;
    return this.publicConfig();
  }

  setAuth(id: string, auth: Auth) {
    if (auth.type !== 'api' || typeof auth.key !== 'string' || !auth.key) throw new Error('Only API credentials are supported by this bridge');
    this.auth.set(id, auth);
  }

  removeAuth(id: string) { this.auth.delete(id); }

  publicConfig() {
    const config = structuredClone(this.value);
    for (const provider of Object.values(config.provider ?? {})) {
      if (provider.options) {
        delete provider.options.apiKey;
        delete provider.options.headers;
      }
      for (const model of Object.values(provider.models ?? {})) delete model.headers;
    }
    for (const server of Object.values(config.mcp ?? {})) {
      if ('headers' in server) delete server.headers;
      if ('environment' in server) delete server.environment;
    }
    return config;
  }

  async listProviders(): Promise<{ providers: Provider[]; default: Record<string, string>; connected: string[] }> {
    return { providers: [], default: {}, connected: [] };
  }
}

export function commandTemplate(path: string) {
  return readFileSync(path, 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
}
