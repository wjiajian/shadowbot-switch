import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import type { Api, Model as PiModel } from '@earendil-works/pi-ai';
import type { Model, Provider, ProviderConfig } from '@opencode-ai/sdk/v2';
import { HostConfig as BaseHostConfig, copilot, modelSelection, object } from '../../config.js';
import { UserError } from '../../errors.js';
export { copilot, explorer, emptyTokens, object } from '../../config.js';
type ConfiguredModel = NonNullable<ProviderConfig['models']>[string];
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
  throw new UserError('模型协议未受支持。请检查影刀模型配置中的 provider.npm 或 options.api。');
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

export class HostConfig extends BaseHostConfig {
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
    if (!selection) throw new UserError('尚未选择模型。请在影刀 Copilot 的模型设置中选择一个模型。');
    const { providerID, modelID } = selection;
    const provider = config.provider?.[providerID] ?? {};
    const configuredModel = provider.models?.[modelID];
    const model = configuredModel ?? {};
    const actualID = model.id ?? modelID;
    const runtime = await catalogRuntime();
    const catalog = runtime.getModel(providerID, actualID);
    if (!configuredModel && !catalog) throw new UserError(`模型 ${providerID}/${modelID} 不在宿主配置或当前 Pi 目录中。请重新选择模型，或补充模型配置。`);
    const api = protocol(provider, model, catalog?.api);
    // OpenAI's Responses and Chat Completions use the same reasoning-effort
    // values. Keep model restrictions when the host selects a compatible relay.
    const openaiEffort = ['openai-responses', 'openai-completions'];
    const thinkingLevelMap = catalog && (catalog.api === api ||
      (openaiEffort.includes(catalog.api) && openaiEffort.includes(api)))
      ? catalog.thinkingLevelMap : undefined;
    const configuredBase = model.provider?.api ?? provider.options?.baseURL ?? provider.api;
    const base = configuredBase ?? catalog?.baseUrl;
    if (typeof base !== 'string') throw new UserError(`模型 ${providerID}/${modelID} 未配置 API 地址。请检查影刀模型设置。`);
    let url: URL;
    try { url = new URL(envValue(base)); } catch { throw new UserError('模型 API 地址无效。请填写完整的 http 或 https 地址。'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new UserError('模型 API 地址必须使用 http 或 https，凭据请放入认证设置。');
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
          thinkingLevelMap,
        }],
      });
    }
    const noKeyRelay = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (!key && !explicitAuth && !noKeyRelay) throw new UserError(`模型 ${providerID}/${modelID} 缺少 API 凭据。请在影刀模型设置中填写凭据或配置对应环境变量。`);
    await runtime.setRuntimeApiKey(providerID, key || 'shadowbot-local-relay');
    const resolved = runtime.getModel(providerID, actualID);
    if (!resolved) throw new Error('Pi could not register the selected model');
    return { runtime, resolved, selection };
  }
}
