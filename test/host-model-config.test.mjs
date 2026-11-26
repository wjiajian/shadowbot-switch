import assert from 'node:assert/strict';
import test from 'node:test';
import { configuredHeaders, defaultModels, envValue, hasExplicitAuth, isLoopbackRelay, resolveBaseUrl,
  resolveCredential, selectModel, visibleModelIDs } from '../dist/service/host/model-config.js';

test('selection favors the requested model, then the agent and global configuration', () => {
  const config = { model: 'global/model', agent: { explorer: { model: 'agent/tools/model' } } };
  const explicit = { providerID: 'request', modelID: 'model' };
  assert.equal(selectModel(config, explicit, 'explorer'), explicit);
  assert.deepEqual(selectModel(config, undefined, 'explorer'), { providerID: 'agent', modelID: 'tools/model' });
  assert.deepEqual(selectModel(config, undefined, 'other'), { providerID: 'global', modelID: 'model' });
  assert.throws(() => selectModel({}, undefined, 'other'), /尚未选择模型/);
});

test('credentials and header substitution preserve precedence and case-insensitive auth names', t => {
  const key = 'SHADOWBOT_TEST_MODEL_CONFIG_KEY';
  const original = process.env[key];
  t.after(() => { if (original === undefined) delete process.env[key]; else process.env[key] = original; });
  delete process.env[key];
  const variable = '{env:' + key + '}';
  assert.equal(envValue('pre' + variable), 'pre');
  process.env[key] = 'env-key';
  const provider = { options: { apiKey: 'inline-' + variable }, env: [key] };
  assert.equal(resolveCredential(new Map([['p', { type: 'api', key: 'saved' }]]), 'p', provider), 'saved');
  assert.equal(resolveCredential(new Map(), 'p', provider), 'inline-env-key');
  assert.equal(resolveCredential(new Map(), 'p', { env: [key] }), 'env-key');
  assert.equal(resolveCredential(new Map(), 'p', {}), undefined);
  assert.deepEqual(configuredHeaders({ Auth: variable, ignored: 1 }), { Auth: 'env-key' });
  assert.deepEqual(configuredHeaders(null), {});
  for (const header of ['Authorization', 'X-API-Key', 'api-key', 'x-Goog-api-key']) assert.equal(hasExplicitAuth({ [header]: '' }), true);
  assert.equal(hasExplicitAuth({ 'x-auth': 'secret' }), false);
});

test('base URL errors and loopback classification remain distinct', () => {
  const url = base => resolveBaseUrl(base, 'p', 'm');
  assert.throws(() => url(undefined), /模型 p\/m 未配置 API 地址/);
  assert.throws(() => url('bad'), /模型 API 地址无效/);
  for (const base of ['ftp://server', 'https://name:pass@server']) assert.throws(() => url(base), /模型 API 地址必须使用 http 或 https/);
  for (const address of ['localhost', '127.0.0.1', '[::1]']) assert.equal(isLoopbackRelay(url('http://' + address + '/api')), true);
  assert.equal(isLoopbackRelay(url('https://remote.example')), false);
});

test('model visibility preserves candidate order, exclusions and provider defaults', () => {
  assert.deepEqual(visibleModelIDs({ whitelist: ['b', 'a', 'c'], blacklist: ['b'] }, ['c', 'b', 'a', 'd']), ['c', 'a']);
  assert.deepEqual(visibleModelIDs({ whitelist: [] }, ['a']), []);
  const providers = [{ id: 'p', models: { a: {}, b: {} } }, { id: 'q', models: { x: {} } }, { id: 'empty', models: {} }];
  assert.deepEqual(defaultModels(providers, { providerID: 'p', modelID: 'b' }), { p: 'b', q: 'x' });
  assert.deepEqual(defaultModels(providers, { providerID: 'p', modelID: 'missing' }), { p: 'a', q: 'x' });
});
