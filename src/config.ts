import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import type { Api, Model as PiModel } from '@earendil-works/pi-ai';
import type { Auth, Config, Model, Provider, ProviderConfig } from '@opencode-ai/sdk/v2';
import { readJson } from './installation.js';

type ObjectMap = Record<string, unknown>;
type ConfiguredModel = NonNullable<ProviderConfig['models']>[string];
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

function envValue(value: string) {
  return value.replace(/\{env:([A-Z_][A-Z0-9_]*)\}/gi, (_, name: string) => process.env[name] ?? '');
}

function headers(value: unknown) {
  if (!object(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([key, value]) => [key, envValue(value)]));
}

const modules = new Map<string, Api>([
  ['@ai-sdk/openai-compatible', 'openai-completions'],
  ['@ai-sdk/openai', 'openai-responses'],
  ['@ai-sdk/anthropic', 'anthropic-messages'],
  ['@ai-sdk/google', 'google-generative-ai'],
  ['@openrouter/ai-sdk-provider', 'openai-completions'],
]);
const apiNames = new Set<Api>(modules.values()).add('openai-completions');

function protocol(provider: ProviderConfig, model: ConfiguredModel, catalogAPI?: Api) {
  const npm = model.provider?.npm ?? provider.npm;
  if (npm && modules.has(npm)) return modules.get(npm)!;
  const explicit = provider.options?.api;
  if (typeof explicit === 'string' && apiNames.has(explicit as Api)) return explicit as Api;
  if (!npm && explicit === undefined && catalogAPI) return catalogAPI;
  throw new Error('Unsupported model provider protocol');
}

function catalogRuntime() {
  return ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
}

function modelMetadata(providerID: string, modelID: string, provider: ProviderConfig, model: ConfiguredModel, catalog?: PiModel<Api>): Model {
  const input = model.modalities?.input ?? (model.attachment !== undefined ? model.attachment ? ['text', 'image'] : ['text'] : catalog?.input ?? ['text']);
  const output = model.modalities?.output ?? ['text'];
  const capabilities = (kinds: readonly string[]) => ({ text: kinds.includes('text'), audio: kinds.includes('audio'), image: kinds.includes('image'),
    video: kinds.includes('video'), pdf: kinds.includes('pdf') });
  return {
    id: modelID, providerID, name: model.name ?? catalog?.name ?? modelID, family: model.family,
    api: { id: model.id ?? modelID, url: model.provider?.api ?? provider.options?.baseURL ?? provider.api ?? catalog?.baseUrl ?? '',
      npm: model.provider?.npm ?? provider.npm ?? [...modules].find(([, api]) => api === catalog?.api)?.[0] ?? '' },
    capabilities: { temperature: model.temperature ?? true, reasoning: model.reasoning ?? catalog?.reasoning ?? false,
      attachment: model.attachment ?? input.includes('image'), toolcall: model.tool_call ?? true,
      input: capabilities(input), output: capabilities(output),
      interleaved: typeof model.interleaved === 'string' ? { field: model.interleaved } : model.interleaved ?? false },
    cost: { input: model.cost?.input ?? catalog?.cost.input ?? 0, output: model.cost?.output ?? catalog?.cost.output ?? 0,
      cache: { read: model.cost?.cache_read ?? catalog?.cost.cacheRead ?? 0, write: model.cost?.cache_write ?? catalog?.cost.cacheWrite ?? 0 } },
    limit: model.limit ?? { context: catalog?.contextWindow ?? 32_768, output: catalog?.maxTokens ?? 4096 },
    status: model.status ?? 'active', options: model.options ?? {}, headers: {}, release_date: model.release_date ?? '', variants: model.variants,
  };
}

export class HostConfig {
  value = initialConfig();
  private auth = new Map<string, Auth>();

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

  async listProviders() {
    const runtime = await catalogRuntime();
    const config = this.publicConfig();
    const selected = modelSelection(config.agent?.[copilot]?.model ?? config.model);
    const providers = Object.entries(config.provider ?? {}).map(([id, provider]): Provider => {
      const declared = Object.keys(provider.models ?? {});
      const candidates = declared.length ? declared : runtime.getModels(id).map(model => model.id);
      const visible = candidates.filter(modelID => (!provider.whitelist || provider.whitelist.includes(modelID)) && !provider.blacklist?.includes(modelID));
      const models = Object.fromEntries(visible.map(key => {
        const model = provider.models?.[key] ?? {};
        return [key, modelMetadata(id, key, provider, model, runtime.getModel(id, model.id ?? key))];
      }));
      return { id, name: provider.name ?? id, env: provider.env ?? [], source: 'config', options: provider.options ?? {}, models };
    });
    const defaults = Object.fromEntries(providers.flatMap(provider => {
      const model = selected?.providerID === provider.id && provider.models[selected.modelID] ? selected.modelID : Object.keys(provider.models)[0];
      return model ? [[provider.id, model]] : [];
    }));
    return { providers, default: defaults, connected: providers.filter(provider => Object.keys(provider.models).length > 0).map(provider => provider.id) };
  }

  async model(request?: { providerID: string; modelID: string }, agent = copilot) {
    const config = this.value;
    const selection = request ?? modelSelection(config.agent?.[agent]?.model ?? config.model);
    if (!selection) throw new Error('No ShadowBot model selected');
    const { providerID, modelID } = selection;
    const provider = config.provider?.[providerID] ?? {};
    const configuredModel = provider.models?.[modelID];
    const model = configuredModel ?? {};
    const actualID = model.id ?? modelID;
    const runtime = await catalogRuntime();
    const catalog = runtime.getModel(providerID, actualID);
    if (!configuredModel && !catalog) throw new Error('Selected ShadowBot model is missing from the host configuration and Pi catalog');
    const api = protocol(provider, model, catalog?.api);
    const configuredBase = model.provider?.api ?? provider.options?.baseURL ?? provider.api;
    const base = configuredBase ?? catalog?.baseUrl;
    if (typeof base !== 'string') throw new Error('Selected model has no endpoint');
    const url = new URL(envValue(base));
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid model endpoint');
    const saved = this.auth.get(providerID);
    const options = provider.options ?? {};
    const key = (saved?.type === 'api' && saved.key) || (typeof options.apiKey === 'string' && envValue(options.apiKey)) ||
      provider.env?.map(variable => process.env[variable]).find(Boolean);
    const configuredHeaders = { ...headers(options.headers), ...headers(model.headers) };
    const explicitAuth = Object.keys(configuredHeaders).some(name => /^(authorization|x-api-key|api-key|x-goog-api-key)$/i.test(name));
    if (!catalog || configuredModel || configuredBase || catalog.api !== api || Object.keys(configuredHeaders).length) {
      runtime.registerProvider(providerID, {
        name: provider.name ?? providerID, api, baseUrl: url.href.replace(/\/$/, ''), headers: configuredHeaders,
        models: [{
          id: actualID, name: model.name ?? catalog?.name ?? modelID, reasoning: model.reasoning ?? catalog?.reasoning ?? false,
          input: model.modalities?.input || model.attachment !== undefined
            ? model.modalities?.input?.includes('image') || model.attachment ? ['text', 'image'] : ['text']
            : catalog?.input.filter(input => input === 'text' || input === 'image') ?? ['text'],
          contextWindow: model.limit?.context ?? catalog?.contextWindow ?? 32_768,
          maxTokens: model.limit?.output ?? catalog?.maxTokens ?? 4096,
          cost: { input: model.cost?.input ?? catalog?.cost.input ?? 0, output: model.cost?.output ?? catalog?.cost.output ?? 0,
            cacheRead: model.cost?.cache_read ?? catalog?.cost.cacheRead ?? 0, cacheWrite: model.cost?.cache_write ?? catalog?.cost.cacheWrite ?? 0 },
          compat: catalog?.api === api ? catalog.compat : undefined,
        }],
      });
    }
    const noKeyRelay = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (!key && !explicitAuth && !noKeyRelay) throw new Error('Selected model has no API credential');
    await runtime.setRuntimeApiKey(providerID, key || 'shadowbot-local-relay');
    const resolved = runtime.getModel(providerID, actualID);
    if (!resolved) throw new Error('Pi could not register the selected model');
    return { runtime, resolved, selection };
  }
}

export function commandTemplate(path: string) {
  return readFileSync(path, 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
}
