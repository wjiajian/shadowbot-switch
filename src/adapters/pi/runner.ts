import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { AgentSession, AgentSessionEvent, ExtensionFactory, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage as PiAssistant, ImageContent } from '@earendil-works/pi-ai';
import type { AssistantMessage, Part, Session, SessionPromptAsyncData, UserMessage } from '@opencode-ai/sdk/v2';
import { copilot, emptyTokens, HostConfig, object } from './config.js';
import { contextSettings, limitToolText, projectToolContext, runtimeContextEntry, withRuntimeContext } from './context.js';
import { authorizeToolCall, hostToolNames, questionTool, skillTool, taskTool, turnToolPolicy, visibleMcpTools, type HostToolSpec } from '../../host/tools.js';
import { SessionHistory } from '../../host/history.js';
import { TurnRecorder } from '../../host/recorder.js';
import { runExplorerTask } from '../../host/explorer.js';
import type { ToolDescriptor, ToolReference, InteractionTarget } from '../../host/types.js';
import type { SkillSources } from '../../host-skills.js';
import { Interactions } from '../../interactions.js';
import { atomicWrite } from '../../installation.js';
import { McpHub } from './mcp.js';
import { ShadowBotContext, skills } from '../../shadowbot.js';
import { admitParts, buildInstructions, parsePromptContent, promptAgent } from '../../host/prompt.js';
import { refreshFailureIsFatal, refreshRuntimeContext, turnRuntimeContext } from '../../host/runtime-context.js';
import type { RunInput } from '../../adapter.js';
import { databaseBusy, failure, id, Store } from '../../store.js';
import type { Meta } from '../../store.js';
import { thinkingArgument } from '../../thinking-command.js';
import { clampThinkingLevel, getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import { initialThinkingLevel } from './thinking.js';
import { modelError, UserError, userMessage } from '../../errors.js';

export type Prompt = NonNullable<SessionPromptAsyncData['body']>;
type Reply = ReturnType<Store['message']>;
type Active = {
  abort: AbortController; done: Promise<Reply>; instructions: string; interaction?: InteractionTarget; pi?: AgentSession;
  cancelled?: boolean; uncertainTool?: string; contextRefreshFailed?: boolean;
};

export { RequestError } from '../../errors.js';
import { RequestError } from '../../errors.js';

function string(value: unknown) { return typeof value === 'string' ? value : ''; }
const filesystemDescriptors: Record<string, ToolDescriptor> = {
  read: { kind: 'read', permission: 'read' }, ls: { kind: 'list', permission: 'read' },
  grep: { kind: 'grep', permission: 'grep' }, find: { kind: 'glob', permission: 'glob' },
};

export class Runs {
  readonly active = new Map<string, Active>();
  readonly interactions: Interactions;
  private readonly history: SessionHistory;
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
    this.history = new SessionHistory({ store, interactions: this.interactions, root, displayName: 'Pi', logPrefix: 'ShadowBotPi',
      isActive: id => this.active.has(id), native: {
        repairInterrupted: (meta, detail) => this.recoverContext(meta, detail),
        prepareDelete: meta => {
          const file = this.transcriptPath(meta);
          return () => { if (file) rmSync(file, { force: true }); };
        },
        parentOf: (meta, entryID) => {
          const entry = this.manager(meta).getEntry(entryID);
          if (entry?.type !== 'message') throw new RequestError(409, 'The native Pi entry is unavailable');
          return entry.parentId;
        },
      } });
    this.running();
  }

  running() { return this.history.running(); }

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

  start(session: Session, prompt: Prompt, run: RunInput, interaction?: InteractionTarget) {
    const thinking = thinkingArgument(prompt);
    if (thinking === undefined) this.history.assertIdle(session);
    const { messageID, parts } = admitParts(this.store, session, prompt);
    const hasRuntime = typeof this.context.hasRuntimeContext === 'boolean' ? this.context.hasRuntimeContext :
      Boolean(process.env.SHADOWBOT_OPENCODE_RUNTIME_CONTEXT_URL);
    const { text, images } = parsePromptContent(prompt, this.root, hasRuntime);
    const agent = promptAgent(session, prompt);
    if (thinking !== undefined) return this.controlThinking(session, prompt, parts, messageID, agent, thinking);
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

  private savedThinking(session: Session): ModelThinkingLevel | undefined {
    const own = this.store.thinking(session.id);
    if (own) return own as ModelThinkingLevel;
    const parent = session.parentID ? this.store.get(session.parentID) : undefined;
    return parent ? this.savedThinking(parent) : undefined;
  }

  private async controlThinking(session: Session, prompt: Prompt, parts: Part[], messageID: string, agent: string, requested: string): Promise<Reply> {
    const previous = this.store.messages(session.id).findLast(item => item.info.role === 'user' &&
      item.info.model?.providerID && item.info.model?.modelID && !this.store.localCommand(session.id, item.info.id));
    const model = prompt.model ?? (previous?.info.role === 'user' ? previous.info.model : undefined);
    const { resolved, selection } = await this.config.model(model, agent);
    const available = getSupportedThinkingLevels(resolved);
    let response!: AssistantMessage;
    let user!: UserMessage;
    let replyPart!: Part;
    let busy = false;
    this.store.transaction(() => {
      const meta = this.store.meta(session.id);
      if (!meta) throw new RequestError(404, 'Session not found');
      busy = Boolean(meta.running);
      if (requested && busy) throw new RequestError(409, '会话正在生成，请等待完成或停止后重试；思考档位未修改。');
      // A new command on a reverted timeline must not silently discard hidden history.
      if (meta.cutoff) throw new RequestError(409, '请先恢复回退的会话，或发送普通消息确认回退，再使用 /thinking。');
      if (this.store.message(session.id, messageID)) throw new RequestError(409, 'The prompt message was already admitted');
      const saved = this.savedThinking(session);
      let baseline = saved ?? this.active.get(session.id)?.pi?.thinkingLevel;
      if (baseline === undefined) {
        const manager = this.manager(meta);
        baseline = (manager.getBranch().some(entry => entry.type === 'thinking_level_change')
          ? manager.buildSessionContext().thinkingLevel : initialThinkingLevel) as ModelThinkingLevel;
      }
      const current = clampThinkingLevel(resolved, baseline);
      const level = requested && available.includes(requested as ModelThinkingLevel) ? requested as ModelThinkingLevel : undefined;
      const text = requested && !level
        ? `不支持思考档位 ${requested}。模型 ${selection.providerID}/${selection.modelID} 支持：${available.join('、')}。设置未修改。`
        : `当前模型 ${selection.providerID}/${selection.modelID} 的实际思考档位：${level ?? current}。支持：${available.join('、')}。` +
          (level ? '已按会话保存，从下一次模型请求生效。回退或删除此设置记录会恢复此前设置。' : '') +
          (!requested && this.store.thinking(session.id) && saved !== current ? `保存档位 ${saved} 不受当前模型支持，请重新设置后再发送消息。` : '') +
          (busy ? '生成中的查询仅临时显示，不保存到会话历史。' : '');
      const now = Date.now();
      user = { id: messageID, role: 'user', sessionID: session.id, agent, model: selection, time: { created: now } };
      for (const part of parts) if (this.store.db.prepare('SELECT 1 FROM main.part WHERE id=?').get(part.id)) {
        throw new RequestError(409, 'The prompt part was already admitted');
      }
      response = { id: id('msg'), role: 'assistant', sessionID: session.id, parentID: user.id, agent, mode: agent,
        modelID: selection.modelID, providerID: selection.providerID, path: { cwd: this.root, root: this.root },
        time: { created: now, completed: now }, finish: 'stop', cost: 0, tokens: emptyTokens() };
      replyPart = { id: id('prt'), sessionID: session.id, messageID: response.id, type: 'text', text, time: { start: now, end: now } };
      if (busy) return; // Never anchor a query to a partial tool exchange or interleave it with the active turn.
      this.store.putMessage(user, false);
      for (const part of parts) this.store.putPart(part, false);
      this.store.putMessage(response, false);
      this.store.putPart(replyPart, false);
      this.store.recordCommand(session.id, user.id, response.id, meta.native_leaf, level);
    });
    this.store.event(session.id, 'message.updated', { info: user });
    for (const part of parts) this.store.event(session.id, 'message.part.updated', { part, time: Date.now() });
    this.store.event(session.id, 'message.updated', { info: response });
    this.store.event(session.id, 'message.part.updated', { part: replyPart, time: Date.now() });
    // The host waits for lifecycle events even when a local command replies immediately.
    // A query during generation must leave the active turn's status untouched.
    if (!busy) {
      this.store.event(session.id, 'session.status', { sessionID: session.id, status: { type: 'idle' } });
      this.store.event(session.id, 'session.idle', { sessionID: session.id });
    }
    return { info: response, parts: [replyPart] };
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
      const ownThinking = this.store.thinking(session.id) as ModelThinkingLevel | undefined;
      const inheritedThinking = this.savedThinking(session);
      const savedThinking = ownThinking ?? (inheritedThinking ? clampThinkingLevel(resolved, inheritedThinking) : undefined);
      const available = getSupportedThinkingLevels(resolved);
      if (savedThinking && !available.includes(savedThinking)) throw new UserError(`保存的思考档位 ${savedThinking} 不受当前模型支持。请先用 /thinking 查询并设置支持的档位：${available.join('、')}。`);
      const loadedSkills = skills(this.agentDir, this.root, this.skillSources, config, agent);
      let context = await turnRuntimeContext(this.context, agent, signal);
      const rewrite = contextSettings();
      const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: true } });
      projection = new Projection(this.store, session, user, manager, selection, this.root, active);
      const interactionSession = active.interaction?.sessionID ?? session.id;
      const interactionTool = (callID: string) => active.interaction?.tool ?? projection!.recorder.reference(callID);
      const connectedTools = this.mcp.tools(name => {
        active.uncertainTool = name;
        active.abort.abort();
        void active.pi?.abort().catch(() => undefined);
      });
      const policy = turnToolPolicy(config, agent, session, prompt, this.agentDir, this.root);
      const mcp = visibleMcpTools(connectedTools, agent, policy);
      const toolNames = [...mcp.keys(), ...hostToolNames(agent)];
      const extension: ExtensionFactory = pi => {
        for (const tool of mcp.values()) pi.registerTool(tool.definition);
        const register = (tool: HostToolSpec) => pi.registerTool({ ...tool, parameters: tool.parameters as ToolDefinition['parameters'] });
        register(skillTool(loadedSkills));
        register(questionTool({ interactions: this.interactions, interactionSession, reference: interactionTool, signal }));
        if (agent === copilot) register(taskTool({ run: (callID, args) => runExplorerTask({
          store: this.store, context: this.context, root: this.root, parent: session, tool: projection!.recorder.reference(callID),
          args, signal, instructions: active.instructions, logPrefix: 'ShadowBotPi',
          startChild: this.start.bind(this), abortChild: this.abort.bind(this),
        }) }));
        pi.on('tool_call', async event => {
          const args = event.input as Record<string, unknown>;
          const auth = await authorizeToolCall({ name: event.toolName, args, root: this.root, policy, skills: loadedSkills,
            mcp: name => mcp.get(name), descriptors: filesystemDescriptors, interactions: this.interactions, sessionID: session.id,
            interactionSession, reference: () => interactionTool(event.toolCallId), signal });
          if (!auth.allow) return { block: true, reason: auth.reason };
          if (auth.checkedPath) args.path = pathToFileURL(auth.checkedPath).href;
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
            context = await refreshRuntimeContext(this.context, agent, signal);
            if (context) pi.appendEntry(runtimeContextEntry, { compactionID: compaction.id, instructions: context });
            this.store.native(session.id, manager.getSessionFile(), manager.getLeafId());
          } catch (error) {
            if (signal.aborted) return;
            active.contextRefreshFailed = refreshFailureIsFatal(error);
            active.abort.abort(error);
            void active.pi?.abort().catch(() => undefined);
          }
        });
      };
      const instructions = buildInstructions({ config, root: this.root, agent, rules: active.instructions,
        system: prompt.system, resources: this.resources, skills: loadedSkills });
      const resourceLoader = new DefaultResourceLoader({ cwd: this.root, agentDir: this.nativeAgentDir, settingsManager: settings,
        noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
        disabledBuiltinExtensions: ['mcp', 'codemode', 'tool_search'], extensionFactories: [extension], appendSystemPrompt: instructions,
      });
      await resourceLoader.reload();
      const { session: pi } = await createAgentSession({ cwd: this.root, agentDir: this.nativeAgentDir, settingsManager: settings,
        resourceLoader, sessionManager: manager, modelRuntime: runtime, model: resolved, thinkingLevel: savedThinking, tools: toolNames.filter(policy.enabled) });
      active.pi = pi;
      unsubscribe = pi.subscribe(event => projection!.handle(event));
      await pi.bindExtensions({ mode: 'rpc' });
      signal.throwIfAborted();
      await pi.prompt(text, { images, expandPromptTemplates: false, source: 'rpc' });
      if (projection.error) throw projection.error;
      signal.throwIfAborted();
      error = projection.recorder.last?.error ? new UserError('message' in projection.recorder.last.error.data ? String(projection.recorder.last.error.data.message) : '模型请求失败。') : undefined;
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
        projection.recorder.finishError(detail, active.cancelled === true);
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
    return projection?.recorder.last ? this.store.message(session.id, projection.recorder.last.id) : undefined;
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

  rename(session: Session, title: string) { return this.history.rename(session, title); }
  delete(session: Session) { return this.history.delete(session); }
  revert(session: Session, messageID: string) { return this.history.revert(session, messageID); }
  deleteMessage(session: Session, messageID: string) { return this.history.deleteMessage(session, messageID); }
  unrevert(session: Session) { return this.history.unrevert(session); }
  patchPart(session: Session, messageID: string, partID: string, input: Record<string, unknown>) {
    return this.history.patchPart(session, messageID, partID, input);
  }
}

class Projection {
  error?: unknown;
  readonly recorder: TurnRecorder;
  constructor(private store: Store, private session: Session, private user: UserMessage, private manager: SessionManager,
    model: UserMessage['model'], root: string, private active: Active) {
    this.recorder = new TurnRecorder(store, session, user, model, root);
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
        if (event.message.role === 'assistant') this.recorder.begin(event.message.timestamp);
        break;
      case 'message_update': {
        if (!this.recorder.last) break;
        const delta = event.assistantMessageEvent;
        if (delta.type === 'text_delta' || delta.type === 'thinking_delta') {
          this.recorder.delta(delta.contentIndex, delta.type === 'text_delta' ? 'text' : 'reasoning', delta.delta);
        }
        break;
      }
      case 'message_end': {
        const native = event.message;
        if (native.role === 'assistant') this.finish(native);
        const projected = native.role === 'assistant' ? this.recorder.last?.id : native.role === 'user' ? this.user.id : undefined;
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
        this.recorder.toolRunning(event.toolCallId, event.toolName, event.args);
        break;
      case 'tool_execution_end': {
        const output = Array.isArray(event.result?.content) ? event.result.content.map((block: unknown) => object(block) && block.type === 'text' ? string(block.text) : '').filter(Boolean).join('\n') : '';
        const metadata = object(event.result?.details) ? event.result.details : {};
        this.recorder.toolEnd(event.toolCallId, { isError: event.isError, output, metadata });
        break;
      }
      case 'compaction_end':
        if (event.result) this.recorder.compacted();
        break;
    }
  }

  private finish(native: PiAssistant) {
    const segments: { index: number; kind: 'text' | 'reasoning'; text: string }[] = [];
    for (const [index, item] of native.content.entries()) {
      if (item.type === 'text') segments.push({ index, kind: 'text', text: item.text });
      if (item.type === 'thinking') segments.push({ index, kind: 'reasoning', text: item.thinking });
    }
    this.recorder.finishStep({ created: native.timestamp, segments, cost: native.usage.cost.total,
      tokens: { total: native.usage.totalTokens, input: native.usage.input, output: native.usage.output,
        reasoning: native.usage.reasoning ?? 0, cache: { read: native.usage.cacheRead, write: native.usage.cacheWrite } },
      finish: native.stopReason === 'toolUse' ? 'tool-calls' : native.stopReason,
      error: native.stopReason === 'error' || native.stopReason === 'aborted'
        ? { message: modelError(native.errorMessage), aborted: native.stopReason === 'aborted' } : undefined });
  }
}
