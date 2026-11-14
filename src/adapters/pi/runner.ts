import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { AgentSession, AgentSessionEvent, ExtensionFactory, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage as PiAssistant, ImageContent } from '@earendil-works/pi-ai';
import type { AssistantMessage, Part, QuestionInfo, Session, SessionPromptAsyncData, ToolPart, UserMessage } from '@opencode-ai/sdk/v2';
import { copilot, emptyTokens, explorer, HostConfig, object } from './config.js';
import { contextSettings, limitToolText, projectToolContext, runtimeContextEntry, withRuntimeContext } from './context.js';
import type { SkillSources } from '../../host-skills.js';
import { decision, Interactions, permissionMayAllow } from '../../interactions.js';
import { atomicWrite } from '../../installation.js';
import { McpHub } from './mcp.js';
import { agentPrompt, ShadowBotContext, skills, userSettings } from '../../shadowbot.js';
import type { RunInput } from '../../adapter.js';
import { outsideWorkspace } from '../../config-paths.js';
import { databaseBusy, failure, id, Store } from '../../store.js';
import type { Meta } from '../../store.js';
import { thinkingArgument } from '../../thinking-command.js';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import { modelError, UserError, userMessage } from '../../errors.js';

export type Prompt = NonNullable<SessionPromptAsyncData['body']>;
type Reply = ReturnType<Store['message']>;
type ToolReference = { messageID: string; callID: string };
type InteractionTarget = { sessionID: string; tool: ToolReference };
type Active = {
  abort: AbortController; done: Promise<Reply>; instructions: string; interaction?: InteractionTarget; pi?: AgentSession;
  cancelled?: boolean; uncertainTool?: string; contextRefreshFailed?: boolean;
};

export { RequestError } from '../../errors.js';
import { RequestError } from '../../errors.js';

function string(value: unknown) { return typeof value === 'string' ? value : ''; }
function schema(properties: Record<string, unknown>, required: string[]) {
  return { type: 'object', properties, required, additionalProperties: false } as ToolDefinition['parameters'];
}
const textSchema = { type: 'string', minLength: 1 };
const filesystemPermissions = new Map([['read', 'read'], ['ls', 'read'], ['grep', 'grep'], ['find', 'glob']]);

function filesystemPath(root: string, input: string) {
  let path = input.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ').replace(/^@/, '');
  if (process.platform === 'win32') {
    path = path.replace(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i, (_, drive, tail) => `${drive}:/${tail ?? ''}`);
  }
  if (path === '~' || /^~[/\\]/.test(path)) path = join(homedir(), path.slice(2));
  if (path.startsWith('file://')) path = fileURLToPath(path);
  return realpathSync.native(resolve(root, path));
}

function alive(pid: number) {
  if (pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

export class Runs {
  readonly active = new Map<string, Active>();
  readonly interactions: Interactions;
  private readonly sessionsDir: string;
  private readonly agentDir: string;
  private readonly nativeAgentDir: string;
  constructor(private store: Store, private config: HostConfig, private root: string, private mcp: McpHub,
    private context: ShadowBotContext, home: string, private resources: string, private skillSources: SkillSources) {
    this.sessionsDir = join(home, 'backends', 'pi', 'sessions');
    this.agentDir = join(home, 'agent');
    this.nativeAgentDir = join(home, 'harnesses', 'pi', 'agent');
    mkdirSync(this.sessionsDir, { recursive: true });
    this.interactions = new Interactions((sessionID, event, fields) => store.event(sessionID, event, fields));
    this.running();
  }

  running() {
    for (const meta of this.store.running(this.root)) {
      this.recover(meta);
    }
    return this.store.running(this.root);
  }

  private recover(meta: Meta) {
    if (this.active.has(meta.id) || (meta.owner_pid !== process.pid && alive(meta.owner_pid)) || !this.store.takeOver(meta)) return false;
    const detail = 'Pi was interrupted before the run completed. Review any external tool operations before retrying.';
    try { this.recoverContext(meta, detail); }
    catch (error) {
      if (databaseBusy(error)) throw error;
      console.error('ShadowBotPi could not repair an interrupted native transcript');
    }
    this.store.finishInterrupted(meta, detail);
    this.store.event(meta.id, 'session.error', { sessionID: meta.id, error: failure(detail, true) });
    this.store.event(meta.id, 'session.status', { sessionID: meta.id, status: { type: 'idle' } });
    this.store.event(meta.id, 'session.idle', { sessionID: meta.id });
    return true;
  }

  private transcriptPath(meta: Meta) {
    if (!meta.native_file) return undefined;
    const name = basename(meta.native_file);
    const folder = dirname(meta.native_file);
    // The adapter recorded absolute paths before the installation became project-local.
    if (!name.endsWith('.jsonl') || basename(folder) !== meta.id || basename(dirname(folder)) !== 'sessions') {
      throw new Error('Invalid Pi native session location');
    }
    return join(this.sessionsDir, meta.id, name);
  }

  private manager(meta: Meta) {
    const dir = join(this.sessionsDir, meta.id);
    const file = this.transcriptPath(meta);
    if (!file || !existsSync(file)) {
      if (meta.native_leaf) throw new Error('Pi native session is missing');
      return SessionManager.create(this.root, dir);
    }
    const manager = SessionManager.open(file, dir, this.root);
    if (meta.native_leaf) manager.branch(meta.native_leaf);
    else manager.resetLeaf();
    return manager;
  }

  private recoverContext(meta: Meta, detail: string) {
    if (!meta.native_file) return;
    const manager = this.manager(meta);
    const pending = new Map<string, string>();
    for (const entry of manager.getBranch()) {
      if (entry.type !== 'message') continue;
      const message = entry.message;
      if (message.role === 'assistant') {
        for (const part of message.content) if (part.type === 'toolCall') pending.set(part.id, part.name);
      } else if (message.role === 'toolResult') pending.delete(message.toolCallId);
    }
    for (const [toolCallId, toolName] of pending) {
      manager.appendMessage({ role: 'toolResult', toolName, toolCallId, isError: true,
        content: [{ type: 'text', text: detail }], timestamp: Date.now() });
    }
    this.store.native(meta.id, manager.getSessionFile(), manager.getLeafId());
  }

  private assertIdle(session: Session) {
    const meta = this.store.meta(session.id);
    if (this.active.has(session.id) || (meta?.running && !this.recover(meta))) throw new RequestError(409, '会话正在生成，请等待完成或停止后重试；思考档位未修改。');
  }

  start(session: Session, prompt: Prompt, run: RunInput, interaction?: InteractionTarget) {
    this.assertIdle(session);
    if (!Array.isArray(prompt.parts) || !prompt.parts.length) throw new RequestError(400, 'The prompt requires parts');
    if (prompt.messageID && !/^msg_[a-zA-Z0-9]{6,64}$/.test(prompt.messageID)) throw new RequestError(400, 'Invalid message ID');
    const messageID = prompt.messageID ?? id('msg');
    if (this.store.db.prepare('SELECT 1 FROM main.message WHERE id=?').get(messageID)) {
      throw new RequestError(409, 'The prompt message was already admitted');
    }
    const provided = new Set<string>();
    const parts = prompt.parts.map(input => {
      if (!object(input)) throw new RequestError(400, 'Invalid prompt part');
      const partID = input.id ?? id('prt');
      if (typeof partID !== 'string' || !/^prt_[a-zA-Z0-9]{6,64}$/.test(partID) || provided.has(partID)) {
        throw new RequestError(400, 'Invalid or duplicate prompt part ID');
      }
      if (this.store.db.prepare('SELECT 1 FROM main.part WHERE id=?').get(partID)) throw new RequestError(409, 'The prompt part was already admitted');
      provided.add(partID);
      return { ...input, id: partID, sessionID: session.id, messageID } as Part;
    });
    const { text, images } = this.promptContent(prompt);
    const agent = prompt.agent || (session.parentID ? explorer : copilot);
    if (agent !== (session.parentID ? explorer : copilot)) throw new RequestError(400, 'This session cannot use the requested agent');
    const manager = this.manager(this.store.meta(session.id)!);
    const abort = new AbortController();
    const done = Promise.withResolvers<Reply>();
    const active: Active = { abort, done: done.promise, instructions: run.instructions, interaction };
    if (!this.store.claim(session.id)) throw new RequestError(409, 'The session is busy');
    try {
      this.store.commitRevert(session.id);
      this.store.event(session.id, 'session.status', { sessionID: session.id, status: { type: 'busy' } });
    } catch (error) {
      // If the database became unavailable after claiming the run, its orphaned lease
      // can be recovered after it is writable again. The model has not been called.
      try { this.store.complete(session.id); } catch { /* recover on the next status or prompt */ }
      throw error;
    }
    this.active.set(session.id, active);
    void this.execute(session, prompt, parts, text, images, messageID, agent, active, manager).then(done.resolve, done.reject);
    return done.promise;
  }

  private promptContent(prompt: Prompt) {
    const text: string[] = [];
    const images: ImageContent[] = [];
    for (const part of prompt.parts) {
      if (part.type === 'text' && typeof part.text === 'string') {
        if (prompt.noReply || !process.env.SHADOWBOT_OPENCODE_RUNTIME_CONTEXT_URL || part.metadata?.xbotPartKind !== 'runtime_context') text.push(part.text);
        continue;
      }
      if (part.type !== 'file' || typeof part.url !== 'string' || !/^image\/(png|jpeg|gif|webp)$/.test(part.mime)) {
        throw new RequestError(400, 'Only text and supported image parts are accepted');
      }
      let data: string;
      const prefix = `data:${part.mime};base64,`;
      if (part.url.startsWith(prefix)) data = part.url.slice(prefix.length);
      else if (part.url.startsWith('file:')) {
        let path: string;
        try { path = realpathSync.native(fileURLToPath(part.url)); }
        catch { throw new RequestError(400, 'Image attachment is unavailable'); }
        if (outsideWorkspace(relative(this.root, path)) || statSync(path).size > 8 * 1024 * 1024) throw new RequestError(400, 'Image attachment is outside the workspace or too large');
        data = readFileSync(path).toString('base64');
      } else throw new RequestError(400, 'Unsupported attachment URL');
      if (data.length > 12 * 1024 * 1024) throw new RequestError(400, 'Image attachment is too large');
      images.push({ type: 'image', data, mimeType: part.mime });
    }
    if (!text.length && !images.length) throw new RequestError(400, 'The prompt is empty');
    return { text: text.join('\n\n'), images };
  }

  patchPart(session: Session, messageID: string, partID: string, input: Record<string, unknown>) {
    this.assertIdle(session);
    const part = this.store.message(session.id, messageID)?.parts.find(part => part.id === partID);
    if (!part) throw new RequestError(404, 'Message part not found');
    if (input.id !== partID || input.messageID !== messageID || input.sessionID !== session.id || input.type !== part.type) {
      throw new RequestError(400, 'Message part identity does not match the request path');
    }
    if (part.type !== 'text' || input.text !== part.text || (input.ignored !== undefined && input.ignored !== part.ignored) ||
        (input.synthetic !== undefined && input.synthetic !== part.synthetic)) {
      throw new RequestError(501, 'This operation would edit the native Pi transcript');
    }
    if (input.metadata !== undefined && !object(input.metadata)) throw new RequestError(400, 'Invalid message part metadata');
    const updated = { ...part, metadata: input.metadata };
    this.store.putPart(updated);
    return updated;
  }

  private async execute(session: Session, prompt: Prompt, parts: Part[], text: string, images: ImageContent[], messageID: string, agent: string, active: Active, manager: SessionManager) {
    const signal = active.abort.signal;
    const config = this.config.value;
    let projection: Projection | undefined;
    let unsubscribe: (() => void) | undefined;
    let selection = prompt.model ?? { providerID: '', modelID: '' };
    let error: unknown;
    const user: UserMessage = { id: messageID, role: 'user', sessionID: session.id, agent,
      model: selection, time: { created: Date.now() }, system: prompt.system };
    try {
      this.store.putMessage(user);
      for (const part of parts) this.store.putPart(part);
      if (prompt.noReply) {
        const entry = manager.appendMessage({ role: 'user', content: [{ type: 'text', text }, ...images], timestamp: user.time.created });
        const file = manager.getSessionFile()!;
        if (!existsSync(file)) atomicWrite(file, [manager.getHeader(), ...manager.getEntries()].map(row => JSON.stringify(row)).join('\n') + '\n');
        this.store.native(session.id, file, entry);
        this.store.mapMessage(session.id, messageID, entry);
        return this.store.message(session.id, messageID);
      }
      const { runtime, resolved, selection: selected } = await this.config.model(prompt.model, agent);
      selection = selected;
      user.model = selection;
      this.store.putMessage(user);
      signal.throwIfAborted();
      const thinking = thinkingArgument(prompt);
      const savedThinking = this.store.thinking(session.id) as ModelThinkingLevel | undefined;
      const available = getSupportedThinkingLevels(resolved);
      if (thinking !== undefined) {
        const settingsManager = SettingsManager.inMemory();
        const resourceLoader = new DefaultResourceLoader({ cwd: this.root, agentDir: this.nativeAgentDir, settingsManager,
          noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
          disabledBuiltinExtensions: ['mcp', 'codemode', 'tool_search'] });
        await resourceLoader.reload();
        const { session: pi } = await createAgentSession({ cwd: this.root, agentDir: this.nativeAgentDir,
          settingsManager, resourceLoader, sessionManager: manager, modelRuntime: runtime, model: resolved,
          thinkingLevel: savedThinking, noTools: 'all' });
        active.pi = pi;
        signal.throwIfAborted();
        let reply: string;
        if (thinking && !available.includes(thinking as ModelThinkingLevel)) {
          reply = `不支持思考档位 ${thinking}。模型 ${selection.providerID}/${selection.modelID} 支持：${available.join('、')}。设置未修改。`;
        } else {
          if (thinking) {
            pi.setThinkingLevel(thinking as ModelThinkingLevel);
            this.store.thinking(session.id, pi.thinkingLevel);
          }
          reply = `当前模型 ${selection.providerID}/${selection.modelID} 的实际思考档位：${pi.thinkingLevel}。支持：${available.join('、')}。` +
            (thinking ? '已按会话保存，从下一次模型请求生效。' : '') +
            (!thinking && savedThinking && savedThinking !== pi.thinkingLevel ? `保存档位 ${savedThinking} 不受当前模型支持，请重新设置后再发送消息。` : '');
        }
        const entry = manager.appendMessage({ role: 'user', content: [{ type: 'text', text }], timestamp: user.time.created });
        this.store.mapMessage(session.id, messageID, entry);
        const native: PiAssistant = { role: 'assistant', content: [{ type: 'text', text: reply }], api: resolved.api,
          provider: resolved.provider, model: resolved.id, timestamp: Date.now(), stopReason: 'stop',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        manager.appendMessage(native);
        projection = new Projection(this.store, session, user, manager, selection, this.root, active);
        projection.handle({ type: 'message_end', message: native });
        if (projection.error) throw projection.error;
        return this.store.message(session.id, projection.last!.id);
      }
      if (savedThinking && !available.includes(savedThinking)) throw new UserError(`保存的思考档位 ${savedThinking} 不受当前模型支持。请先用 /thinking 查询并设置支持的档位：${available.join('、')}。`);
      const loadedSkills = skills(this.agentDir, this.root, this.skillSources, config, agent);
      let context = await this.context.instructions(agent === explorer, signal);
      const rewrite = contextSettings();
      const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: true } });
      projection = new Projection(this.store, session, user, manager, selection, this.root, active);
      const interactionSession = active.interaction?.sessionID ?? session.id;
      const interactionTool = (callID: string) => active.interaction?.tool ?? projection!.reference(callID);
      const connectedTools = this.mcp.tools(name => {
        active.uncertainTool = name;
        active.abort.abort();
        void active.pi?.abort().catch(() => undefined);
      });
      const role = config.agent?.[agent];
      const policies = [config.permission, role?.permission, session.permission];
      const customPolicy = userSettings(this.agentDir, this.root).mcpPermission;
      const enabled = (name: string) => prompt.tools?.[name] !== false && role?.tools?.[name] !== false;
      const mcp = new Map([...connectedTools].filter(([name, tool]) => {
        if (!enabled(name) || !permissionMayAllow(name, ...(tool.builtin ? policies : [customPolicy]))) return false;
        if (agent === explorer) return !tool.builtin || tool.server === 'xbot-copilot' || tool.server === 'browser-use-mcp';
        return tool.server !== 'browser-use-mcp';
      }));
      const toolNames = [...mcp.keys(), 'skill', 'question', 'read'];
      if (agent === copilot) toolNames.push('task', 'grep', 'find', 'ls');
      const extension: ExtensionFactory = pi => {
        for (const tool of mcp.values()) pi.registerTool(tool.definition);
        pi.registerTool({ name: 'skill', label: 'Skill', description: 'Read the instructions of an enabled skill.',
          parameters: schema({ name: textSchema }, ['name']), execute: async (_callID, args) => {
            const skill = object(args) ? loadedSkills.find(skill => skill.name === args.name) : undefined;
            if (!skill) throw new Error('The requested skill is unavailable');
            const text = [readFileSync(skill.filePath, 'utf8').trim(), `Base directory for this skill: ${skill.baseDir}`,
              'Resolve the relative paths in this skill from that directory.'].join('\n\n');
            return { content: [{ type: 'text', text }], details: { name: skill.name, dir: skill.baseDir } };
          } });
        pi.registerTool({ name: 'question', label: '提问', description: 'Ask the user to choose an option before continuing.',
          parameters: schema({ questions: { type: 'array', minItems: 1, items: schema({ question: textSchema, header: textSchema,
            multiple: { type: 'boolean' }, custom: { type: 'boolean' }, options: { type: 'array', minItems: 1,
              items: schema({ label: textSchema, description: { type: 'string' } }, ['label', 'description']) },
          }, ['question', 'header', 'options']) } }, ['questions']), execute: async (callID, args) => {
            if (!object(args) || !Array.isArray(args.questions) || !args.questions.length || args.questions.length > 10) throw new Error('Invalid questions');
            const answers = await this.interactions.question(interactionSession, args.questions as QuestionInfo[], interactionTool(callID), signal);
            return { content: [{ type: 'text', text: JSON.stringify(answers) }], details: { answers } };
          } });
        if (agent === copilot) pi.registerTool({ name: 'task', label: 'Explorer', description: 'Delegate a web exploration task to shadowbot-explorer.',
          parameters: schema({ description: textSchema, prompt: textSchema, subagent_type: textSchema, task_id: { type: 'string' } }, ['description', 'prompt', 'subagent_type']),
          execute: (callID, args) => this.explore(session, projection!.reference(callID), object(args) ? args : {}, signal, active.instructions),
        });
        pi.on('tool_call', async event => {
          const name = event.toolName;
          if (!enabled(name)) return { block: true, reason: 'Tool disabled for this turn' };
          const custom = mcp.get(name);
          const input = event.input as Record<string, unknown>;
          const skill = name === 'skill' ? loadedSkills.find(candidate => candidate.name === input.name) : undefined;
          if (name === 'skill' && !skill) return { block: true, reason: 'The requested skill is unavailable' };
          const subagent = string(input.subagent_type);
          let target = skill?.name ?? (name === 'task' ? (subagent === 'explore' ? explorer : subagent) :
            string(input.filePath ?? input.path ?? input.command) || name);
          const filesystemPermission = filesystemPermissions.get(name);
          const permission = filesystemPermission ?? name;
          let external: { path: string; directory: string; pattern: string } | undefined;
          let checkedPath: string | undefined;
          if (filesystemPermission) {
            try {
              const path = filesystemPath(this.root, string(input.path));
              const fromRoot = relative(this.root, path);
              if (outsideWorkspace(fromRoot)) {
                const directory = statSync(path).isDirectory() ? path : dirname(path);
                external = { path, directory, pattern: join(directory, '*') };
              }
              target = filesystemPermission === 'read' ? fromRoot : string(input.pattern);
              checkedPath = path;
              input.path = pathToFileURL(path).href;
            } catch { return { block: true, reason: 'The filesystem path is unavailable' }; }
          }
          const rule = skill?.source === 'custom' ? 'allow' : custom && !custom.builtin
            ? decision(name, target, 'ask', customPolicy)
            : decision(permission, target, name === 'question' || skill ? 'allow' : 'ask', ...policies);
          if (rule === 'deny') return { block: true, reason: 'Tool denied by the workspace permission policy' };
          const reference = interactionTool(event.toolCallId);
          if (external) {
            const { pattern, path, directory } = external;
            const access = decision('external_directory', pattern, 'ask', ...policies);
            if (access === 'deny') return { block: true, reason: 'Access outside the workspace is denied' };
            if (access === 'ask' && !await this.interactions.permission(session.id, 'external_directory', reference, signal, {
              patterns: [pattern], always: [pattern], metadata: { filepath: path, parentDir: directory },
            }, interactionSession)) return { block: true, reason: 'Access outside the workspace was declined' };
          }
          const skillScope = skill ? { patterns: [skill.name], always: [skill.name], metadata: {} } : undefined;
          if (rule === 'ask' && !await this.interactions.permission(session.id, permission, reference, signal, skillScope, interactionSession)) {
            return { block: true, reason: 'Permission denied by the user' };
          }
          if (signal.aborted) return { block: true, reason: 'Run cancelled' };
          if (checkedPath) {
            try { if (realpathSync.native(checkedPath) === checkedPath) return; }
            catch { /* the approved path no longer exists */ }
            return { block: true, reason: 'The filesystem path changed before the tool could run' };
          }
        });
        pi.on('tool_result', event => {
          const content = limitToolText(event.toolName, event.content);
          if (content) return { content, details: { truncated: true } };
        });
        if (rewrite.enabled) pi.on('context', event => ({ messages: projectToolContext(event.messages, rewrite.compressSnapshots) }));
        pi.on('context_with_system', event => ({ messages: withRuntimeContext(event.messages, context) }));
        pi.on('session_compact', async event => {
          const compaction = manager.getBranch().findLast(entry => entry.type === 'compaction') ?? event.compactionEntry;
          try {
            context = await this.context.instructions(agent === explorer, signal, true);
            if (context) pi.appendEntry(runtimeContextEntry, { compactionID: compaction.id, instructions: context });
            this.store.native(session.id, manager.getSessionFile(), manager.getLeafId());
          } catch (error) {
            if (signal.aborted) return;
            active.contextRefreshFailed = !databaseBusy(error);
            active.abort.abort(error);
            void active.pi?.abort().catch(() => undefined);
          }
        });
      };
      const summary = loadedSkills.map(skill => `${skill.name}: ${skill.description}`).join('\n');
      // AGENTS.md rules come from the shared layer (run.instructions). prompt.system stays
      // exactly what the host sent, because it is persisted and echoed back to the host.
      const instructions = [agentPrompt(config, this.root, agent), active.instructions, prompt.system,
        `ShadowBot reference directory: ${join(this.resources, 'Copilot', 'knowledge')}`,
        summary && `Available skills. Use the skill tool to read their instructions.\n${summary}`].filter((value): value is string => Boolean(value));
      const resourceLoader = new DefaultResourceLoader({ cwd: this.root, agentDir: this.nativeAgentDir, settingsManager: settings,
        noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
        disabledBuiltinExtensions: ['mcp', 'codemode', 'tool_search'], extensionFactories: [extension], appendSystemPrompt: instructions,
      });
      await resourceLoader.reload();
      const { session: pi } = await createAgentSession({ cwd: this.root, agentDir: this.nativeAgentDir, settingsManager: settings,
        resourceLoader, sessionManager: manager, modelRuntime: runtime, model: resolved, thinkingLevel: savedThinking, tools: toolNames.filter(enabled) });
      active.pi = pi;
      unsubscribe = pi.subscribe(event => projection!.handle(event));
      await pi.bindExtensions({ mode: 'rpc' });
      signal.throwIfAborted();
      await pi.prompt(text, { images, expandPromptTemplates: false, source: 'rpc' });
      if (projection.error) throw projection.error;
      signal.throwIfAborted();
      error = projection.last?.error ? new UserError('message' in projection.last.error.data ? String(projection.last.error.data.message) : '模型请求失败。') : undefined;
    } catch (caught) { error = caught; }
    finally {
      unsubscribe?.();
      active.pi?.dispose();
      this.active.delete(session.id);
      if (error) {
        const detail = active.cancelled ? 'Chat cancelled. Any flow already started may continue in ShadowBot.'
          : active.uncertainTool ? `MCP tool ${active.uncertainTool} did not confirm its outcome. Check the result in ShadowBot before retrying.`
          : active.contextRefreshFailed ? 'Pi compacted the conversation, but could not refresh or save the ShadowBot runtime context. Check the workspace connection before retrying.'
          : databaseBusy(error) ? 'The ShadowBot session database became busy. Refresh session status and review any external tool operations before retrying.'
          : userMessage(error, 'Pi 请求失败。检查影刀中的模型设置，运行 .\\switch.ps1 doctor 和 mcp status 查看诊断。');
        projection ??= new Projection(this.store, session, user, manager, selection, this.root, active);
        projection.finishError(detail, active.cancelled === true);
        this.store.event(session.id, 'session.error', { sessionID: session.id, error: failure(detail, active.cancelled === true) });
        this.store.finishInterrupted(this.store.meta(session.id)!, detail);
      }
      const leaf = manager.getLeafId();
      if (manager.getSessionFile() && existsSync(manager.getSessionFile()!)) this.store.native(session.id, manager.getSessionFile(), leaf);
      this.store.complete(session.id);
      const current = this.store.get(session.id)!;
      this.store.update({ ...current, time: { ...current.time, updated: Date.now() } });
      this.store.event(session.id, 'session.status', { sessionID: session.id, status: { type: 'idle' } });
      this.store.event(session.id, 'session.idle', { sessionID: session.id });
    }
    return projection?.last ? this.store.message(session.id, projection.last.id) : undefined;
  }

  // The Explorer child runs inside the parent's turn, so it reuses that turn's rules snapshot.
  private async explore(parent: Session, tool: ToolReference, args: Record<string, unknown>, signal: AbortSignal, instructions: string) {
    if (!['explore', explorer].includes(string(args.subagent_type)) || !string(args.prompt)) throw new Error('Invalid Explorer task');
    const prior = string(args.task_id);
    const child = prior ? this.store.get(prior) : this.store.create(this.root, parent.directory, { parentID: parent.id, title: string(args.description) });
    if (!child || child.parentID !== parent.id) throw new Error('Explorer session does not belong to this Copilot session');
    signal.throwIfAborted();
    const cancel = () => { void this.abort(child.id).catch(() => console.error('ShadowBotPi Explorer cancellation failed')); };
    signal.addEventListener('abort', cancel, { once: true });
    let reply: Reply;
    let recycled = false;
    try {
      await this.context.overlay('start', parent.id, tool.callID).catch(() => console.error('ShadowBotPi Explorer overlay start failed'));
      signal.throwIfAborted();
      reply = await this.start(child, { agent: explorer, parts: [{ type: 'text', text: string(args.prompt) }] }, { instructions }, { sessionID: parent.id, tool });
      if (reply?.info.role !== 'assistant' || reply.info.error) throw new Error('Explorer task failed');
    } finally {
      signal.removeEventListener('abort', cancel);
      const cleanup = await this.context.overlay('end', parent.id, tool.callID).catch(() => {
        console.error('ShadowBotPi Explorer overlay cleanup failed');
        return undefined;
      });
      recycled = cleanup?.recycled ?? false;
    }
    const text = reply.parts.filter(part => part.type === 'text').map(part => part.text).join('\n');
    const evidence = await this.context.finalizedEvidence().catch(() => undefined);
    const evidenceText = evidence ? `[SHADOWBOT_EXPLORATION_EVIDENCE]\n${JSON.stringify(evidence.snapshot).slice(0, 24_000)}` : '';
    const notice = recycled ? '任务已结束，runtime已被回收，下次执行将会启动一个全新的runtime' : '';
    return { content: [{ type: 'text' as const, text: [text, evidenceText, notice].filter(Boolean).join('\n\n') }],
      details: { parentSessionId: parent.id, sessionId: child.id, shadowbot_exploration_evidence_snapshot_id: evidence?.id } };
  }

  async abort(sessionID: string) {
    const run = this.active.get(sessionID);
    if (!run) {
      if (this.store.meta(sessionID)?.running) throw new RequestError(409, 'This run belongs to another bridge process');
      return false;
    }
    run.cancelled = true;
    run.abort.abort();
    await run.pi?.abort();
    await run.done;
    return true;
  }

  rename(session: Session, title: string) {
    this.assertIdle(session);
    return this.store.update({ ...session, title, time: { ...session.time, updated: Date.now() } });
  }

  delete(session: Session) {
    const children = this.store.list(this.root).filter(child => child.parentID === session.id);
    for (const child of children) this.assertIdle(child);
    this.assertIdle(session);
    for (const child of children) this.delete(child);
    const file = this.transcriptPath(this.store.meta(session.id)!);
    this.store.delete(session);
    this.interactions.clearGrants(session.id);
    if (file) rmSync(file, { force: true });
    return true;
  }

  revert(session: Session, messageID: string) {
    this.assertIdle(session);
    const item = this.store.message(session.id, messageID);
    if (!item) throw new RequestError(404, 'Message not found');
    const anchor = item.info.role === 'assistant' ? this.store.message(session.id, item.info.parentID) : item;
    if (anchor?.info.role !== 'user') throw new RequestError(409, 'The turn has no user message');
    const meta = this.store.meta(session.id)!;
    const leaf = this.branchBefore(meta, anchor.info.id);
    const reverted = { ...session, revert: { messageID: anchor.info.id }, time: { ...session.time, updated: Date.now() } };
    return this.store.setRevert(reverted, leaf, meta.cutoff ? meta.revert_leaf : meta.native_leaf);
  }

  deleteMessage(session: Session, messageID: string) {
    this.assertIdle(session);
    const item = this.store.message(session.id, messageID);
    if (!item) {
      if (this.store.wasMessageRemoved(session.id, messageID)) return true;
      throw new RequestError(404, 'Message not found');
    }
    const meta = this.store.meta(session.id)!;
    if (meta.cutoff && !this.store.messages(session.id).some(message => message.info.id === messageID)) {
      this.store.commitRevert(session.id);
      return true;
    }
    // A bridge-side error can create a projected assistant message without a Pi entry.
    const cutoff = item.info.role === 'assistant' && item.info.error && !this.store.mapped(session.id, messageID)
      ? item.info.parentID : messageID;
    const leaf = this.branchBefore(meta, cutoff);
    this.store.removeMessages(session, cutoff, leaf);
    return true;
  }

  private branchBefore(meta: Meta, messageID: string) {
    const piID = this.store.mapped(meta.id, messageID);
    if (!piID) throw new RequestError(409, 'The message has no native Pi entry');
    const entry = this.manager(meta).getEntry(piID);
    if (entry?.type !== 'message') throw new RequestError(409, 'The native Pi entry is unavailable');
    return entry.parentId;
  }

  unrevert(session: Session) {
    this.assertIdle(session);
    const meta = this.store.meta(session.id)!;
    if (!meta.cutoff) return session;
    const restored = { ...session };
    delete restored.revert;
    return this.store.setRevert(restored, meta.revert_leaf, null);
  }
}

class Projection {
  last?: AssistantMessage;
  error?: unknown;
  private segments = new Map<number, Extract<Part, { type: 'text' | 'reasoning' }>>();
  private toolParts = new Map<string, ToolPart>();

  constructor(private store: Store, private session: Session, private user: UserMessage, private manager: SessionManager,
    private model: UserMessage['model'], private root: string, private active: Active) {}

  private begin(created = Date.now()) {
    const { session, user, model } = this;
    this.last = { id: id('msg'), sessionID: session.id, parentID: user.id, role: 'assistant', agent: user.agent,
      mode: user.agent, modelID: model.modelID, providerID: model.providerID, path: { cwd: this.root, root: this.root },
      time: { created }, cost: 0, tokens: emptyTokens() };
    this.segments.clear();
    this.store.putMessage(this.last);
    this.store.putPart({ ...this.partRef(), type: 'step-start' });
  }

  private partRef() { return { id: id('prt'), sessionID: this.session.id, messageID: this.last!.id }; }

  reference(callID: string) {
    return { messageID: this.toolParts.get(callID)?.messageID ?? this.last?.id ?? this.user.id, callID };
  }

  handle(event: AgentSessionEvent) {
    if (this.error) return;
    try { this.project(event); }
    catch (error) {
      this.error = error;
      this.active.abort.abort();
      void this.active.pi?.abort().catch(() => undefined);
    }
  }

  private project(event: AgentSessionEvent) {
    switch (event.type) {
      case 'message_start':
        if (event.message.role === 'assistant') this.begin(event.message.timestamp);
        break;
      case 'message_update': {
        if (!this.last) break;
        const delta = event.assistantMessageEvent;
        if (delta.type === 'text_delta' || delta.type === 'thinking_delta') {
          const record = this.segment(delta.contentIndex, delta.type === 'text_delta' ? 'text' : 'reasoning');
          record.text += delta.delta;
          this.store.putPart(record, false);
          this.store.event(this.session.id, 'message.part.delta', { sessionID: this.session.id, messageID: record.messageID,
            partID: record.id, field: 'text', delta: delta.delta });
        }
        break;
      }
      case 'message_end': {
        const native = event.message;
        if (native.role === 'assistant') this.finish(native);
        const projected = native.role === 'assistant' ? this.last?.id : native.role === 'user' ? this.user.id : undefined;
        queueMicrotask(() => {
          if (this.error) return;
          try {
            const entry = this.manager.getLeafEntry();
            const file = this.manager.getSessionFile();
            if (entry?.type === 'message' && entry.message === native) {
              if (projected) this.store.mapMessage(this.session.id, projected, entry.id);
              if (file && existsSync(file)) this.store.native(this.session.id, file, entry.id);
            }
          } catch (error) { this.error = error; this.active.abort.abort(); }
        });
        break;
      }
      case 'tool_execution_start':
        this.runningTool(event.toolCallId, event.toolName, event.args);
        break;
      case 'tool_execution_end': {
        const record = this.toolParts.get(event.toolCallId);
        if (!record) break;
        const state = record.state;
        const time = { start: state.status === 'pending' ? Date.now() : state.time.start, end: Date.now() };
        const output = Array.isArray(event.result?.content) ? event.result.content.map((block: unknown) => object(block) && block.type === 'text' ? string(block.text) : '').filter(Boolean).join('\n') : '';
        const metadata = object(event.result?.details) ? event.result.details : {};
        record.state = event.isError ? { status: 'error', input: state.input, error: output || 'Tool execution failed', time, metadata }
          : { status: 'completed', input: state.input, output, title: record.tool, time, metadata };
        this.store.putPart(record);
        break;
      }
      case 'compaction_end':
        if (event.result) this.store.event(this.session.id, 'session.compacted', { sessionID: this.session.id });
        break;
    }
  }

  private segment(index: number, type: 'text' | 'reasoning'): Extract<Part, { type: 'text' | 'reasoning' }> {
    const existing = this.segments.get(index);
    if (existing) return existing;
    const base = { ...this.partRef(), text: '', time: { start: Date.now() } };
    const record = type === 'text' ? { ...base, type: 'text' as const } : { ...base, type: 'reasoning' as const };
    this.segments.set(index, record);
    this.store.putPart(record);
    return record;
  }

  private runningTool(callID: string, name: string, args: unknown) {
    if (!this.last) this.begin();
    let record = this.toolParts.get(callID);
    const input = object(args) ? args : {};
    if (!record) {
      record = { ...this.partRef(), type: 'tool', tool: name, callID, state: { status: 'pending', input, raw: JSON.stringify(input) } };
      this.toolParts.set(callID, record);
      this.store.mapTool(this.session.id, callID, record.id);
    }
    record.state = { status: 'running', input, time: { start: Date.now() } };
    this.store.putPart(record);
  }

  private finish(native: PiAssistant) {
    if (!this.last) this.begin(native.timestamp);
    const info = this.last!;
    for (const [index, item] of native.content.entries()) {
      if (item.type !== 'text' && item.type !== 'thinking') continue;
      const record = this.segment(index, item.type === 'text' ? 'text' : 'reasoning');
      record.text = item.type === 'text' ? item.text : item.thinking;
      record.time = { start: record.time?.start ?? info.time.created, end: Date.now() };
      this.store.putPart(record);
    }
    info.time.completed = Date.now();
    info.cost = native.usage.cost.total;
    info.tokens = { total: native.usage.totalTokens, input: native.usage.input, output: native.usage.output,
      reasoning: native.usage.reasoning ?? 0, cache: { read: native.usage.cacheRead, write: native.usage.cacheWrite } };
    info.finish = native.stopReason === 'toolUse' ? 'tool-calls' : native.stopReason;
    if (native.stopReason === 'error' || native.stopReason === 'aborted') info.error = failure(modelError(native.errorMessage), native.stopReason === 'aborted');
    this.store.putPart({ ...this.partRef(), type: 'step-finish', reason: info.finish, cost: info.cost, tokens: info.tokens });
    this.store.putMessage(info);
  }

  finishError(detail: string, aborted: boolean) {
    if (!this.last) this.begin();
    this.last!.time.completed = Date.now();
    this.last!.finish = 'error';
    this.last!.error = failure(detail, aborted);
    this.store.putMessage(this.last!);
  }
}
