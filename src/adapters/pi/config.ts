import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import type { Api, Model as PiModel } from '@earendil-works/pi-ai';
import type { Model, Provider, ProviderConfig } from '@opencode-ai/sdk/v2';
import { HostConfig as BaseHostConfig, copilot, modelSelection } from '../../config.js';
import { configuredHeaders, defaultModels, hasExplicitAuth, isLoopbackRelay, resolveBaseUrl, resolveCredential,
  selectModel, visibleModelIDs } from '../../host/model-config.js';
import { UserError } from '../../errors.js';
export { copilot, explorer, emptyTokens, object } from '../../config.js';
type ConfiguredModel = NonNullable<ProviderConfig['models']>[string];

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
      const visible = visibleModelIDs(provider, candidates);
      const models = Object.fromEntries(visible.map(key => {
        const model = provider.models?.[key] ?? {};
        return [key, modelMetadata(id, key, provider, model, runtime.getModel(id, model.id ?? key))];
      }));
      return { id, name: provider.name ?? id, env: provider.env ?? [], source: 'config', options: provider.options ?? {}, models };
    });
    const defaults = defaultModels(providers, selected);
    return { providers, default: defaults, connected: providers.filter(provider => Object.keys(provider.models).length > 0).map(provider => provider.id) };
  }

  async model(request?: { providerID: string; modelID: string }, agent = copilot) {
    const config = this.value;
    const selection = selectModel(config, request, agent);
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
    const url = resolveBaseUrl(base, providerID, modelID);
    const key = resolveCredential(this.auth, providerID, provider);
    const headers = { ...configuredHeaders(provider.options?.headers), ...configuredHeaders(model.headers) };
    const explicitAuth = hasExplicitAuth(headers);
    if (!catalog || configuredModel || configuredBase || catalog.api !== api || Object.keys(headers).length) {
      runtime.registerProvider(providerID, {
        name: provider.name ?? providerID, api, baseUrl: url.href.replace(/\/$/, ''), headers,
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
    const noKeyRelay = isLoopbackRelay(url);
    if (!key && !explicitAuth && !noKeyRelay) throw new UserError(`模型 ${providerID}/${modelID} 缺少 API 凭据。请在影刀模型设置中填写凭据或配置对应环境变量。`);
    await runtime.setRuntimeApiKey(providerID, key || 'shadowbot-local-relay');
    const resolved = runtime.getModel(providerID, actualID);
    if (!resolved) throw new Error('Pi could not register the selected model');
    return { runtime, resolved, selection };
  }
}
