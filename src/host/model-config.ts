import type { Auth, Config, Provider, ProviderConfig } from '@opencode-ai/sdk/v2';
import { modelSelection, object } from '../config.js';
import { UserError } from '../errors.js';

export function envValue(value: string) {
  return value.replace(/\{env:([A-Z_][A-Z0-9_]*)\}/gi, (_, name: string) => process.env[name] ?? '');
}

export function configuredHeaders(value: unknown) {
  if (!object(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([key, value]) => [key, envValue(value)]));
}

type Selection = { providerID: string; modelID: string };

export function selectModel(config: Config, request: Selection | undefined, agent: string) {
  const selection = request ?? modelSelection(config.agent?.[agent]?.model ?? config.model);
  if (!selection) throw new UserError('尚未选择模型。请在影刀 Copilot 的模型设置中选择一个模型。');
  return selection;
}

export function resolveBaseUrl(base: unknown, providerID: string, modelID: string) {
  if (typeof base !== 'string') throw new UserError(`模型 ${providerID}/${modelID} 未配置 API 地址。请检查影刀模型设置。`);
  let url: URL;
  try { url = new URL(envValue(base)); } catch { throw new UserError('模型 API 地址无效。请填写完整的 http 或 https 地址。'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new UserError('模型 API 地址必须使用 http 或 https，凭据请放入认证设置。');
  return url;
}

export function resolveCredential(auth: ReadonlyMap<string, Auth>, providerID: string, provider: ProviderConfig) {
  const saved = auth.get(providerID);
  const options = provider.options ?? {};
  return (saved?.type === 'api' && saved.key) || (typeof options.apiKey === 'string' && envValue(options.apiKey)) ||
    provider.env?.map(variable => process.env[variable]).find(Boolean);
}

export function hasExplicitAuth(headers: Record<string, string>) {
  return Object.keys(headers).some(name => /^(authorization|x-api-key|api-key|x-goog-api-key)$/i.test(name));
}

export function isLoopbackRelay(url: URL) {
  return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

export function visibleModelIDs(provider: ProviderConfig, candidates: string[]) {
  return candidates.filter(modelID => (!provider.whitelist || provider.whitelist.includes(modelID)) && !provider.blacklist?.includes(modelID));
}

export function defaultModels(providers: Provider[], selected?: Selection) {
  return Object.fromEntries(providers.flatMap(provider => {
    const model = selected?.providerID === provider.id && provider.models[selected.modelID] ? selected.modelID : Object.keys(provider.models)[0];
    return model ? [[provider.id, model]] : [];
  }));
}
