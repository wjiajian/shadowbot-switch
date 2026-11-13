import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { HarnessRegistry, harnessCapabilities, loadAdapter } from './harnesses.js';
import type { Harness } from './harnesses.js';
import { assertRunsContract, NoMcp } from './adapter.js';
import type { HarnessAdapter, HarnessRuns, McpConnection, Prompt } from './adapter.js';
import type { Agent, Auth, McpLocalConfig, McpRemoteConfig, Session, SessionCreateData } from '@opencode-ai/sdk/v2';
import { commandTemplate, copilot, explorer, HostConfig, modelSelection, object } from './config.js';
import { skillSources } from './host-skills.js';
import type { SkillSources } from './host-skills.js';
import { installationHome, mode, protocolVersion, readJson, installedVersion, runtimeDirectory } from './installation.js';
import type { Installation } from './installation.js';
import { permissionRules } from './interactions.js';
import { customMcp } from './mcp-config.js';
import { RequestError, isRequestError, isUserError } from './errors.js';
import { ShadowBotContext, skills, workspace } from './shadowbot.js';
import { databaseBusy, id, Store } from './store.js';
import type { Frame } from './store.js';
import { verifySchema } from './switch.js';
import { configurationRevision, publishRuntimeState } from './runtime-state.js';
import { skillInventory } from './shadowbot.js';
import { skillCommand, syncSkillCommands } from './skill-commands.js';
import { userMessage } from './errors.js';
import { agentRules } from './agent-rules.js';

function flags(args: string[]) {
  if (args[0] !== 'serve') throw new Error('Expected serve');
  let hostname = '127.0.0.1', port = 0;
  const cors = new Set<string>();
  for (let i = 1; i < args.length; i++) {
    const [name, inline] = args[i].split(/=(.*)/s, 2);
    if (name === '--print-logs') continue;
    if (!['--port', '--hostname', '--cors', '--log-level'].includes(name)) throw new Error('Unsupported serve option');
    const value = inline ?? args[++i];
    if (!value || value.startsWith('--')) throw new Error('Serve option requires a value');
    if (name === '--hostname') hostname = value;
    if (name === '--port') port = Number(value);
    if (name === '--cors') cors.add(value);
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(hostname) || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Expected a loopback listener and valid port');
  return { hostname, port, cors };
}

function json(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of req) {
    const chunk = Buffer.from(raw);
    size += chunk.length;
    if (size > 16 * 1024 * 1024) throw new RequestError(413, 'Request body is too large');
    chunks.push(chunk);
  }
  try {
    const parsed: unknown = size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    if (object(parsed)) return parsed;
  } catch { /* report the same contract error for malformed and non-object JSON */ }
  throw new RequestError(400, 'Expected a JSON object');
}

function value(input: unknown, field: string) {
  if (typeof input !== 'string' || !input.trim()) throw new RequestError(400, `Missing or invalid ${field}`);
  return input;
}

type Listener = { res: ServerResponse; global: boolean; root: string };
type Workspace = { mcp: McpConnection; runs: HarnessRuns; revision: string; queue: Promise<void>; configurationError?: string; menuReconnect?: boolean };

class Bridge {
  readonly server;
  private config: HostConfig;
  private listeners = new Set<Listener>();
  private workspaces = new Map<string, Promise<Workspace>>();
  private store: Store;
  private context = new ShadowBotContext();
  private agentDir: string;
  private skillSources: SkillSources;
  private readonly credential = process.env.OPENCODE_SERVER_PASSWORD ?
    createHash('sha256').update(`Basic ${Buffer.from(`${process.env.OPENCODE_SERVER_USERNAME || 'opencode'}:${process.env.OPENCODE_SERVER_PASSWORD}`).toString('base64')}`).digest() : undefined;

  constructor(private home: string, private installation: Installation, private cors: Set<string>, private harness: Harness, private adapter: HarnessAdapter) {
    this.config = adapter.createConfig();
    this.agentDir = join(home, 'agent');
    this.skillSources = skillSources(home, installation, harness.id);
    this.store = new Store(installation.database, join(home, 'backends', harness.id, 'adapter.db'), (event, directory, root) => {
      for (const client of this.listeners) {
        if (root.toLowerCase() === client.root.toLowerCase()) this.frame(client, event, directory);
      }
    });
    this.server = createServer({ requestTimeout: 0, headersTimeout: 10_000 }, (req, res) => {
      void this.route(req, res).catch(error => this.error(res, error));
    });
  }

  async ready() {
    if (process.env.SHADOWBOT_OPENCODE_WORKSPACE_ROOT) {
      const root = workspace();
      await this.context.reportHealth(root);
    }
  }

  private async local(root: string) {
    const key = root.toLowerCase();
    let loading = this.workspaces.get(key);
    if (!loading) {
      loading = (async () => {
        const mcp = this.adapter.mcp ? this.adapter.mcp.create(root) : new NoMcp();
        try {
          const revision = configurationRevision(this.home, root);
          for (const [name, config] of Object.entries(this.config.value.mcp ?? {})) {
            if ('type' in config) await mcp.addBuiltin(name, config);
          }
          let configurationError: string | undefined;
          try { if (this.harness.capabilities.mcp) await mcp.reloadCustom(customMcp(this.agentDir, root)); }
          catch (error) { configurationError = userMessage(error); }
          const runs = assertRunsContract(this.adapter.createRuns({ store: this.store, config: this.config, root, mcp, context: this.context, home: this.home, resources: this.installation.resources, skillSources: this.skillSources }), this.harness.id);
          const local: Workspace = { mcp, runs, revision, queue: Promise.resolve(), configurationError };
          this.publish(root, local);
          const heartbeat = setInterval(() => this.publish(root, local), 2000);
          heartbeat.unref();
          return local;
        } catch (error) { await mcp.close(); throw error; }
      })();
      this.workspaces.set(key, loading);
    }
    try { return await loading; }
    catch (error) { this.workspaces.delete(key); throw error; }
  }

  private publish(root: string, local: Workspace) {
    try { publishRuntimeState(this.home, { harness: this.harness.id, root, active: local.runs.active.size, revision: local.revision,
      mcp: local.mcp.status(), errors: local.mcp.configurationErrors(), configurationError: local.configurationError, menuReconnect: local.menuReconnect }); }
    catch { console.error('ShadowBot Switch 无法写入运行状态，请检查安装数据目录的权限。'); }
  }

  private async refresh(root: string, local: Workspace) {
    if (local.runs.active.size) return;
    const revision = configurationRevision(this.home, root);
    const disconnected = Object.values(local.mcp.status()).some(status => status.status === 'failed');
    if (local.revision !== revision || disconnected || local.configurationError || Object.keys(local.mcp.configurationErrors()).length) {
      try {
        if (this.harness.capabilities.mcp) await local.mcp.reloadCustom(customMcp(this.agentDir, root));
        local.revision = revision;
        local.configurationError = undefined;
      } catch (error) { local.configurationError = userMessage(error); }
    }
    try {
      const global = this.harness.capabilities.skills ? skillInventory(this.agentDir, undefined, this.skillSources, this.config.value)
        .filter(row => row.source !== 'official' && row.status === 'enabled').map(row => row.skill!) : undefined;
      const menu = syncSkillCommands(this.installation.resources, global);
      if (menu.added + menu.updated + menu.removed) local.menuReconnect = true;
    } catch (error) { local.configurationError = userMessage(error, 'Skill 菜单同步失败。检查影刀 Resources/Copilot/commands 目录权限。'); }
    this.publish(root, local);
  }

  private enqueue<T>(workspace: Workspace, operation: () => T | Promise<T>) {
    const result = workspace.queue.then(operation);
    workspace.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private configureMcp<T>(workspace: Workspace, operation: () => Promise<T>) {
    return this.enqueue(workspace, () => {
      if (workspace.runs.active.size) throw new RequestError(409, 'MCP configuration can change when runs settle');
      return operation();
    });
  }

  private error(res: ServerResponse, error: unknown) {
    if (res.headersSent) { res.end(); return; }
    if (isRequestError(error)) {
      const name = error.status === 404 ? 'NotFoundError' : error.status === 409 ? 'SessionBusyError' : 'InvalidRequestError';
      json(res, { name, data: { message: error.message }, message: error.message }, error.status);
    } else if (databaseBusy(error)) {
      json(res, { name: 'DatabaseBusyError', data: { message: 'The ShadowBot session database is busy. Refresh session status before retrying.' } }, 503);
    } else if (isUserError(error)) {
      json(res, { name: 'ConfigurationError', data: { message: error.message } }, 400);
    } else {
      console.error('ShadowBot Switch request failed', error instanceof Error ? error.name : 'UnknownError');
      json(res, { name: 'UnknownError', data: { message: 'ShadowBot Switch request failed' } }, 500);
    }
  }

  private frame(listener: Listener, payload: Frame, directory: string) {
    const { res, global } = listener;
    if (res.destroyed) return;
    const data = `data: ${JSON.stringify(global ? { directory, payload } : payload)}\n\n`;
    if (res.writableLength + Buffer.byteLength(data) > 1024 * 1024) res.destroy();
    else res.write(data);
  }

  private events(res: ServerResponse, root: string, global: boolean) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' });
    const listener = { res, root, global };
    this.listeners.add(listener);
    this.frame(listener, { id: id('evt'), type: 'server.connected', properties: {} }, 'global');
    const timer = setInterval(() => this.frame(listener, { id: id('evt'), type: 'server.heartbeat', properties: {} }, 'global'), 15_000);
    timer.unref();
    res.on('close', () => { clearInterval(timer); this.listeners.delete(listener); });
  }

  private async route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const method = req.method;
    const origin = req.headers.origin;
    if (origin && this.cors.has(origin)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'Origin');
      if (method === 'OPTIONS') {
        res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
        res.setHeader('access-control-allow-headers', 'Authorization, Content-Type, X-OpenCode-Directory, X-OpenCode-Workspace');
        res.writeHead(204).end();
        return;
      }
    }
    if (this.credential && !timingSafeEqual(createHash('sha256').update(req.headers.authorization ?? '').digest(), this.credential)) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="opencode"' }).end();
      return;
    }
    if (path === '/global/health' && method === 'GET') return json(res, { healthy: true, version: protocolVersion });
    if (path === '/config' || path === '/global/config') {
      if (method === 'GET') return json(res, this.config.publicConfig());
      if (method === 'PATCH') {
        const input = await body(req);
        try { return json(res, this.config.patch(input)); }
        catch { throw new RequestError(400, 'Invalid OpenCode configuration'); }
      }
    }
    if (path === '/provider' && method === 'GET') {
      const models = await this.config.listProviders();
      return json(res, { all: models.providers, default: models.default, connected: models.connected });
    }
    if (path === '/config/providers' && method === 'GET') {
      const { connected: _, ...providers } = await this.config.listProviders();
      return json(res, providers);
    }
    if (path === '/provider/auth' && method === 'GET') {
      return json(res, Object.fromEntries(Object.keys(this.config.value.provider ?? {}).map(id => [id, [{ type: 'api', label: 'API key' }]])));
    }
    const segments = path.split('/').slice(1).map(segment => decodeURIComponent(segment));
    const [resource, identifier, action, subID, leaf, partID] = segments;
    if (resource === 'auth' && identifier && segments.length === 2) {
      if (method === 'PUT') { this.config.setAuth(identifier, await body(req) as Auth); return json(res, true); }
      if (method === 'DELETE') { this.config.removeAuth(identifier); return json(res, true); }
    }
    const directoryHeader = req.headers['x-opencode-directory'];
    const requested = url.searchParams.get('directory') ?? (typeof directoryHeader === 'string' ? decodeURIComponent(directoryHeader) : undefined);
    let root: string;
    try { root = workspace(requested); }
    catch { throw new RequestError(400, 'An actual ShadowBot workspace is required'); }
    const directory = requested && resolve(requested) === requested ? requested : process.env.SHADOWBOT_OPENCODE_WORKSPACE_ROOT ? process.cwd() : root;
    const owns = (sessionID: string) => Boolean(this.store.owned(sessionID, root));
    if ((path === '/event' || path === '/global/event') && method === 'GET') return this.events(res, root, path === '/global/event');
    if (path === '/path' && method === 'GET') return json(res, { home: this.agentDir, state: this.home, config: this.agentDir, directory, worktree: root });
    if (path === '/agent' && method === 'GET') return json(res, [copilot, explorer].map((name): Agent => {
      const config = this.config.value;
      const role = config.agent?.[name];
      return { name, mode: name === copilot ? 'primary' : 'subagent', native: true,
        description: role?.description, hidden: role?.hidden, topP: role?.top_p, temperature: role?.temperature, color: role?.color,
        model: modelSelection(role?.model), permission: [...permissionRules(config.permission, role?.permission)],
        prompt: role?.prompt, variant: role?.variant, options: role?.options ?? {}, steps: role?.steps ?? role?.maxSteps };
    }));
    const commands = { ...this.config.value.command };
    if (this.harness.capabilities.skills && (path === '/command' || action === 'command')) {
      for (const skill of skills(this.agentDir, root, this.skillSources, this.config.value)) {
        const name = `skill-${skill.name}`;
        if (!commands[name]) commands[name] = { template: skillCommand(skill.name), description: skill.description, agent: copilot };
      }
    }
    if (path === '/command' && method === 'GET') return json(res, Object.entries(commands).map(([name, command]) => ({ ...command, name, hints: [] })));
    if (path === '/skill' && method === 'GET') return json(res, this.harness.capabilities.skills ? skills(this.agentDir, root, this.skillSources, this.config.value) : []);

    const local = await this.local(root);
    const { mcp, runs } = local;
    if (resource === 'mcp') {
      if (!this.adapter.mcp) throw new RequestError(501, 'This harness does not support host MCP');
      if (path === '/mcp' && method === 'GET') return json(res, mcp.status());
      if (path === '/mcp' && method === 'POST') {
        const input = await body(req);
        if (!object(input.config)) throw new RequestError(400, 'Invalid host MCP configuration');
        const name = value(input.name, 'MCP name');
        const config = input.config as McpLocalConfig | McpRemoteConfig;
        await this.configureMcp(local, () => mcp.addBuiltin(name, config));
        return json(res, mcp.status());
      }
      if (method === 'POST' && segments.length === 3 && ['connect', 'disconnect'].includes(action)) {
        if (action === 'connect') {
          await this.configureMcp(local, () => mcp.connect(identifier));
          return json(res, mcp.status()[identifier]?.status === 'connected');
        }
        await this.configureMcp(local, () => mcp.disconnect(identifier));
        return json(res, true);
      }
    }
    if (resource === 'permission' || resource === 'question') {
      if (!identifier && method === 'GET') return json(res, runs.interactions.list(resource, owns));
      let result: boolean | undefined;
      if (method === 'POST' && segments.length === 3) {
        if (resource === 'permission' && action === 'reply') {
          const { reply } = await body(req);
          if (reply !== 'always' && reply !== 'once' && reply !== 'reject') throw new RequestError(400, 'Invalid permission reply');
          result = runs.interactions.permissionReply(identifier, reply, owns);
        }
        if (resource === 'question' && action === 'reject') result = runs.interactions.questionReply(identifier, null, owns);
        if (resource === 'question' && action === 'reply') {
          const { answers } = await body(req);
          if (!Array.isArray(answers) || !answers.every(a => Array.isArray(a) && a.every(value => typeof value === 'string'))) {
            throw new RequestError(400, 'Invalid question answers');
          }
          result = runs.interactions.questionReply(identifier, answers, owns);
        }
      }
      if (result === false) throw new RequestError(404, 'The interaction is no longer pending');
      if (result) return json(res, true);
    }
    if (resource === 'session') {
      if (identifier === 'status' && segments.length === 2 && method === 'GET') {
        return json(res, Object.fromEntries(runs.running().map(({ id }) => [id, { type: 'busy' }])));
      }
      if (!identifier && method === 'GET') {
        const search = url.searchParams.get('search')?.toLowerCase();
        const limit = this.limit(url);
        const start = Number(url.searchParams.get('start') ?? 0);
        return json(res, this.store.list(root).filter(session => session.time.updated >= start &&
          (!search || session.title.toLowerCase().includes(search)) && (url.searchParams.get('roots') !== 'true' || !session.parentID)).slice(0, limit));
      }
      if (!identifier && method === 'POST') {
        const input = await body(req) as NonNullable<SessionCreateData['body']>;
        if (input.parentID && !owns(input.parentID)) throw new RequestError(404, 'Unknown parent session');
        return json(res, this.store.create(root, directory, { title: input.title, parentID: input.parentID, permission: input.permission }));
      }
      if (!owns(identifier)) throw new RequestError(404, 'Session not found in this workspace');
      const session = this.store.get(identifier)!;
      if (!action && method === 'GET') return json(res, session);
      if (!action && method === 'DELETE') return json(res, runs.delete(session));
      if (!action && method === 'PATCH') return json(res, runs.rename(session, value((await body(req)).title, 'title')));
      if (action === 'children' && !subID && method === 'GET') return json(res, this.store.list(root).filter(child => child.parentID === identifier));
      if (action === 'todo' && !subID && method === 'GET') {
        return json(res, this.store.db.prepare('SELECT content,status,priority FROM main.todo WHERE session_id=? ORDER BY position').all(identifier));
      }
      if (action === 'abort' && !subID && method === 'POST') return json(res, await runs.abort(identifier));
      if (action === 'permissions' && subID && !leaf && method === 'POST') {
        const { response } = await body(req);
        if (response !== 'always' && response !== 'once' && response !== 'reject') throw new RequestError(400, 'Invalid permission reply');
        if (!runs.interactions.permissionReply(subID, response, sessionID => sessionID === identifier)) {
          throw new RequestError(404, 'The permission request is no longer pending');
        }
        return json(res, true);
      }
      if (action === 'revert' && !subID && method === 'POST') {
        const input = await body(req);
        if (input.partID) throw new RequestError(501, 'Partial message revert is unavailable');
        return json(res, runs.revert(session, value(input.messageID, 'message ID')));
      }
      if (action === 'unrevert' && !subID && method === 'POST') return json(res, runs.unrevert(session));
      if (action === 'message' && method === 'GET' && !leaf) {
        if (!subID) return json(res, this.store.messages(identifier).slice(-this.limit(url)));
        const message = this.store.messages(identifier).find(item => item.info.id === subID);
        if (!message) throw new RequestError(404, 'Message not found');
        return json(res, message);
      }
      if (action === 'message' && method === 'DELETE' && subID && !leaf) {
        return json(res, runs.deleteMessage(session, subID));
      }
      if (action === 'message' && method === 'PATCH' && subID && leaf === 'part' && partID && segments.length === 6) {
        return json(res, runs.patchPart(session, subID, partID, await body(req)));
      }
      if (['message', 'prompt_async', 'command'].includes(action) && !subID && method === 'POST') {
        const input = await body(req);
        const prompt = action === 'command' ? this.expandCommand(input, commands) : input as Prompt;
        const { result } = await this.enqueue(local, async () => {
          await this.refresh(root, local);
          // The queue ends at admission. Permission, question and abort requests remain available during the run.
          const current = this.store.get(identifier);
          if (!current) throw new RequestError(404, 'Session not found in this workspace');
          // Every harness receives the same per-turn AGENTS.md rules from the shared layer.
          // root is the host workspace, never a temporary session directory.
          const instructions = prompt.noReply ? '' : agentRules(this.agentDir, root);
          return { result: runs.start(current, prompt, { instructions }) };
        });
        if (action === 'prompt_async') {
          void result.catch(error => console.error('ShadowBot Switch run persistence failed', error instanceof Error ? error.name : 'UnknownError'));
          res.writeHead(204).end();
          return;
        }
        return json(res, await result);
      }
    }
    throw new RequestError(501, 'This OpenCode operation is unavailable in the active harness');
  }

  private expandCommand(input: Record<string, unknown>, commands: NonNullable<HostConfig['value']['command']>): Prompt {
    const name = value(input.command, 'command');
    if (!/^[\w-]+$/.test(name)) throw new RequestError(400, 'Invalid command');
    const command = commands[name];
    const file = join(this.installation.resources, 'Copilot', 'commands', `${name}.md`);
    if (!command && !existsSync(file)) throw new RequestError(404, 'Command not found');
    const template = command?.template ?? commandTemplate(file);
    if (template.includes('!`')) throw new RequestError(501, 'Shell expansion in commands is unavailable');
    const args = typeof input.arguments === 'string' ? input.arguments : '';
    const text = template.includes('$ARGUMENTS') ? template.replaceAll('$ARGUMENTS', args) : `${template}\n${args}`;
    const model = typeof input.model === 'string' ? input.model : command?.model;
    return { messageID: typeof input.messageID === 'string' ? input.messageID : undefined,
      agent: typeof input.agent === 'string' ? input.agent : command?.agent,
      model: modelSelection(model),
      parts: [{ type: 'text', text }, ...(Array.isArray(input.parts) ? input.parts : [])],
    };
  }

  private limit(url: URL) {
    const requested = Number(url.searchParams.get('limit') ?? 100);
    if (!Number.isSafeInteger(requested) || requested < 1) throw new RequestError(400, 'Invalid limit');
    return Math.min(requested, 1000);
  }
}

async function main() {
  const options = flags(process.argv.slice(2));
  const home = installationHome();
  const installation = readJson<Installation>(join(home, 'install.json'));
  const registered = new HarnessRegistry().get(mode(home));
  const harness = { ...registered, capabilities: harnessCapabilities(installation, registered) };
  if (harness.kind !== 'managed' || existsSync(join(home, 'switch.pending.json')) || existsSync(join(home, 'activation.pending.json'))) throw new Error('Harness is not ready');
  verifySchema(installation.database, readFileSync(join(runtimeDirectory(home, installation, harness.id), 'schema.sql'), 'utf8'));
  const adapter = await loadAdapter(home, installation, harness);
  await adapter.verify(installedVersion(installation, harness.id));
  const bridge = new Bridge(home, installation, options.cors, harness, adapter);
  await bridge.ready();
  bridge.server.listen(options.port, options.hostname, () => {
    const address = bridge.server.address() as AddressInfo;
    const host = isIP(address.address) === 6 ? `[${address.address}]` : address.address;
    console.log(`opencode server listening on http://${host}:${address.port}`);
    console.error(`ShadowBot Switch backend ${harness.name}, OpenCode protocol ${protocolVersion}`);
  });
}

void main().catch(error => {
  console.error(`ShadowBot Switch startup failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
});
