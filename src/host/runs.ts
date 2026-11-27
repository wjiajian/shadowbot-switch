import { join } from 'node:path';
import type { AssistantMessage, Part, Session, UserMessage } from '@opencode-ai/sdk/v2';
import type { AdapterContext, HarnessRuns, Prompt, RunInput } from '../adapter.js';
import { copilot, emptyTokens } from '../config.js';
import { isRequestError, isUserError, RequestError, UserError, userMessage } from '../errors.js';
import { Interactions } from '../interactions.js';
import type { HostTool } from '../mcp/hub.js';
import { installationThinkingSetting, skills } from '../shadowbot.js';
import { databaseBusy, failure, id, type Meta, type Store } from '../store.js';
import { thinkingArgument } from '../thinking-command.js';
import { runExplorerTask } from './explorer.js';
import { SessionHistory, type NativeHistory } from './history.js';
import { admitParts, buildInstructions, parsePromptContent, promptAgent } from './prompt.js';
import { TurnRecorder } from './recorder.js';
import { refreshFailureIsFatal, refreshRuntimeContext, turnRuntimeContext } from './runtime-context.js';
import { contextSettings } from './tool-context.js';
import { limitToolText } from './tool-output.js';
import { authorizeToolCall, hostToolNames, questionTool, skillTool, taskTool, turnToolPolicy, visibleMcpTools,
  type Authorization, type HostToolSpec } from './tools.js';
import type { ImageBlock, InteractionTarget, ToolDescriptor, ToolReference } from './types.js';

type Reply = ReturnType<Store['message']>;
type Selection = UserMessage['model'];
type Active = {
  abort: AbortController; done: Promise<Reply>; instructions: string; interaction?: InteractionTarget;
  cancelled?: boolean; uncertainTool?: string; contextRefreshFailed?: boolean;
};

export interface ThinkingCapability<Model> {
  supportedLevels(model: Model): readonly string[];
  clamp(model: Model, level: string): string;
  baseline(meta: Meta): string;
}

export interface DriverTurn<Model, Native> {
  session: Session; prompt: Prompt; agent: string; text: string; images: ImageBlock[]; user: UserMessage;
  recorder: TurnRecorder; model: Model; savedThinking?: string; prepared?: Native; signal: AbortSignal;
  instructions: string[]; readonly runtimeContext: string; contextSettings: ReturnType<typeof contextSettings>;
  hostTools: HostToolSpec[]; mcpTools: Map<string, HostTool>; toolNames: string[];
  authorize(callID: string, name: string, args: Record<string, unknown>): Promise<Authorization>;
  limitOutput: typeof limitToolText;
  interactionTool(callID: string): ToolReference;
  markUncertain(name: string): void;
  refreshRuntimeContext(persist?: (instructions: string) => void): Promise<void>;
  abort(reason?: unknown): void;
  translationFailed(error: unknown): void;
}

export interface HarnessDriver<Model = unknown, Native = unknown> {
  displayName: string; logPrefix: string; fallbackError: string;
  resolveModel(request: Selection | undefined, agent: string): Promise<{ selection: Selection; handle: Model }>;
  summarize?(meta: Meta, model: Selection, signal: AbortSignal): Promise<{ text: string; file: string; leaf: string; cost: number; tokens: AssistantMessage['tokens'] }>;
  runTurn(turn: DriverTurn<Model, Native>): Promise<void>;
  abort(sessionID: string): Promise<void>;
  dispose?(sessionID: string): void;
  descriptors?: Record<string, ToolDescriptor>;
  legacyMcpTools?(onUncertain: (name: string) => void): Map<string, HostTool>;
  thinking?: ThinkingCapability<Model>;
  history?: NativeHistory & {
    prepareTurn(meta: Meta): Native;
    appendNoReply(prepared: Native, input: { text: string; images: ImageBlock[]; timestamp: number }): { file: string; entryID: string };
    checkpoint(prepared: Native, phase: 'compact' | 'finish'): { file?: string; leaf: string | null } | undefined;
  };
}

export function createHostRuns<Model, Native>(ctx: AdapterContext, driver: HarnessDriver<Model, Native>): HarnessRuns {
  return new HostRuns(ctx, driver);
}

class HostRuns<Model, Native> {
  readonly active = new Map<string, Active>();
  readonly interactions: Interactions;
  private readonly history: SessionHistory;
  private readonly agentDir: string;
  private readonly store: Store;
  private readonly root: string;
  constructor(private ctx: AdapterContext, private driver: HarnessDriver<Model, Native>) {
    const { store, root, home } = ctx;
    this.store = store;
    this.root = root;
    this.agentDir = join(home, 'agent');
    this.interactions = new Interactions((sessionID, event, fields) => store.event(sessionID, event, fields));
    this.history = new SessionHistory({ store, root, interactions: this.interactions, displayName: driver.displayName,
      logPrefix: driver.logPrefix, isActive: id => this.active.has(id), native: driver.history });
    this.running();
  }

  running() { return this.history.running(); }

  start(session: Session, prompt: Prompt, run: RunInput, interaction?: InteractionTarget) {
    const thinking = this.driver.thinking && installationThinkingSetting(this.agentDir) !== false ? thinkingArgument(prompt) : undefined;
    if (thinking === undefined) this.history.assertIdle(session);
    const { messageID, parts } = admitParts(this.store, session, prompt);
    const hasRuntime = typeof this.ctx.context.hasRuntimeContext === 'boolean' ? this.ctx.context.hasRuntimeContext :
      Boolean(process.env.SHADOWBOT_OPENCODE_RUNTIME_CONTEXT_URL);
    const { text, images } = parsePromptContent(prompt, this.root, hasRuntime);
    const agent = promptAgent(session, prompt);
    if (thinking !== undefined) return this.controlThinking(session, prompt, parts, messageID, agent, thinking);
    const prepared = this.driver.history?.prepareTurn(this.store.meta(session.id)!);
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
    void this.execute(session, prompt, parts, text, images, messageID, agent, active, prepared).then(done.resolve, done.reject);
    return done.promise;
  }

  private savedThinking(session: Session): string | undefined {
    const own = this.store.thinking(session.id);
    if (own) return own;
    const parent = session.parentID ? this.store.get(session.parentID) : undefined;
    return parent ? this.savedThinking(parent) : undefined;
  }

  private async controlThinking(session: Session, prompt: Prompt, parts: Part[], messageID: string, agent: string, requested: string): Promise<Reply> {
    const previous = this.store.messages(session.id).findLast(item => item.info.role === 'user' &&
      item.info.model?.providerID && item.info.model?.modelID && !this.store.localCommand(session.id, item.info.id));
    const model = prompt.model ?? (previous?.info.role === 'user' ? previous.info.model : undefined);
    const thinking = this.driver.thinking!;
    const { handle, selection } = await this.driver.resolveModel(model, agent);
    const available = thinking.supportedLevels(handle);
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
      const baseline = saved ?? thinking.baseline(meta);
      const current = thinking.clamp(handle, baseline);
      const level = requested && available.includes(requested) ? requested : undefined;
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

  private async execute(session: Session, prompt: Prompt, parts: Part[], text: string, images: ImageBlock[], messageID: string, agent: string, active: Active, prepared: Native | undefined) {
    const signal = active.abort.signal;
    const config = this.ctx.config.value;
    let recorder: TurnRecorder | undefined;
    let translationError: unknown;
    const checkpoint = (phase: 'finish' | 'compact') => {
      const state = this.driver.history?.checkpoint(prepared!, phase);
      if (state) this.store.native(session.id, state.file, state.leaf);
    };
    let selection = prompt.model ?? { providerID: '', modelID: '' };
    let error: unknown;
    const user: UserMessage = { id: messageID, role: 'user', sessionID: session.id, agent,
      model: selection, time: { created: Date.now() }, system: prompt.system };
    try {
      this.store.putMessage(user);
      for (const part of parts) this.store.putPart(part);
      if (prompt.noReply) {
        if (this.driver.history) {
          const { file, entryID } = this.driver.history.appendNoReply(prepared!, { text, images, timestamp: user.time.created });
          this.store.native(session.id, file, entryID);
          this.store.mapMessage(session.id, messageID, entryID);
        }
        return this.store.message(session.id, messageID);
      }
      const { handle, selection: selected } = await this.driver.resolveModel(prompt.model, agent);
      selection = selected;
      user.model = selection;
      this.store.putMessage(user);
      signal.throwIfAborted();
      let savedThinking: string | undefined;
      const thinking = this.driver.thinking;
      if (thinking) {
        const own = this.store.thinking(session.id);
        const inherited = this.savedThinking(session);
        savedThinking = own ?? (inherited ? thinking.clamp(handle, inherited) : undefined);
        const available = thinking.supportedLevels(handle);
        if (savedThinking && !available.includes(savedThinking)) throw new UserError(`保存的思考档位 ${savedThinking} 不受当前模型支持。请先用 /thinking 查询并设置支持的档位：${available.join('、')}。`);
      }
      const loadedSkills = skills(this.agentDir, this.root, this.ctx.skillSources, config, agent);
      let context = await turnRuntimeContext(this.ctx.context, agent, signal);
      const rewrite = contextSettings();
      recorder = new TurnRecorder(this.store, session, user, selection, this.root);
      const interactionSession = active.interaction?.sessionID ?? session.id;
      const interactionTool = (callID: string) => active.interaction?.tool ?? recorder!.reference(callID);
      const markUncertain = (name: string) => {
        active.uncertainTool = name;
        active.abort.abort();
        void this.driver.abort(session.id).catch(() => undefined);
      };
      const connectedTools = this.ctx.mcp.hostTools?.(markUncertain) ?? this.driver.legacyMcpTools?.(markUncertain) ?? new Map<string, HostTool>();
      const policy = turnToolPolicy(config, agent, session, prompt, this.agentDir, this.root);
      const mcp = visibleMcpTools(connectedTools, agent, policy);
      const toolNames = [...mcp.keys(), ...hostToolNames(agent)].filter(policy.enabled);
      const hostTools = [skillTool(loadedSkills), questionTool({ interactions: this.interactions, interactionSession, reference: interactionTool, signal })];
      if (agent === copilot) hostTools.push(taskTool({ run: (callID, args) => runExplorerTask({
        store: this.store, context: this.ctx.context, root: this.root, parent: session, tool: recorder!.reference(callID),
        args, signal, instructions: active.instructions, logPrefix: this.driver.logPrefix,
        startChild: this.start.bind(this), abortChild: this.abort.bind(this),
      }) }));
      const instructions = buildInstructions({ config, root: this.root, agent, rules: active.instructions,
        system: prompt.system, resources: this.ctx.resources, skills: loadedSkills });
      await this.driver.runTurn({ session, prompt, agent, text, images, user, recorder, model: handle, savedThinking,
        prepared, signal, instructions, get runtimeContext() { return context; }, contextSettings: rewrite,
        hostTools, mcpTools: mcp, toolNames, interactionTool, markUncertain,
        authorize: (callID, name, args) => authorizeToolCall({ name, args, root: this.root, policy, skills: loadedSkills,
          mcp: name => mcp.get(name), descriptors: this.driver.descriptors ?? {}, interactions: this.interactions,
          sessionID: session.id, interactionSession, reference: () => interactionTool(callID), signal }),
        limitOutput: limitToolText,
        abort: reason => active.abort.abort(reason),
        translationFailed: error => { translationError = error; },
        refreshRuntimeContext: async persist => {
          try {
            context = await refreshRuntimeContext(this.ctx.context, agent, signal);
            if (context) persist?.(context);
            checkpoint('compact');
          } catch (error) {
            if (signal.aborted) return;
            active.contextRefreshFailed = refreshFailureIsFatal(error);
            active.abort.abort(error);
            void this.driver.abort(session.id).catch(() => undefined);
          }
        },
      });
      if (translationError) throw translationError;
      signal.throwIfAborted();
      error = recorder.last?.error ? new UserError('message' in recorder.last.error.data ? String(recorder.last.error.data.message) : '模型请求失败。') : undefined;
    } catch (caught) { error = caught; }
    finally {
      this.driver.dispose?.(session.id);
      this.active.delete(session.id);
      if (error) {
        const detail = active.cancelled ? 'Chat cancelled. Any flow already started may continue in ShadowBot.'
          : active.uncertainTool ? `MCP tool ${active.uncertainTool} did not confirm its outcome. Check the result in ShadowBot before retrying.`
          : active.contextRefreshFailed ? `${this.driver.displayName} compacted the conversation, but could not refresh or save the ShadowBot runtime context. Check the workspace connection before retrying.`
          : databaseBusy(error) ? 'The ShadowBot session database became busy. Refresh session status and review any external tool operations before retrying.'
          : userMessage(error, this.driver.fallbackError);
        recorder ??= new TurnRecorder(this.store, session, user, selection, this.root);
        recorder.finishError(detail, active.cancelled === true);
        this.store.event(session.id, 'session.error', { sessionID: session.id, error: failure(detail, active.cancelled === true) });
        this.store.finishInterrupted(this.store.meta(session.id)!, detail);
      }
      checkpoint('finish');
      this.store.complete(session.id);
      this.store.patchSession(session.id, {});
      this.store.event(session.id, 'session.status', { sessionID: session.id, status: { type: 'idle' } });
      this.store.event(session.id, 'session.idle', { sessionID: session.id });
    }
    return recorder?.last ? this.store.message(session.id, recorder.last.id) : undefined;
  }

  async summarize(session: Session, model: Selection) {
    if (!this.driver.summarize) throw new RequestError(501, 'This harness does not support session compaction');
    this.history.assertIdle(session);
    if (!this.store.claim(session.id)) throw new RequestError(409, 'The session is busy');
    const abort = new AbortController();
    const done = Promise.withResolvers<Reply>();
    this.active.set(session.id, { abort, done: done.promise, instructions: '' });
    try {
      const meta = this.store.meta(session.id)!;
      this.store.event(session.id, 'session.status', { sessionID: session.id, status: { type: 'busy' } });
      const started = Date.now();
      const summary = await this.driver.summarize(meta, model, abort.signal);
      abort.signal.throwIfAborted();
      if (summary.leaf !== meta.native_leaf) {
        this.store.commitRevert(session.id);
        const now = Date.now();
        const user: UserMessage = { id: id('msg'), sessionID: session.id, role: 'user', agent: copilot, model, summary: { diffs: [] }, time: { created: started } };
        const assistant: AssistantMessage = { id: id('msg'), sessionID: session.id, role: 'assistant', parentID: user.id,
          agent: 'compaction', mode: 'compaction', summary: true, finish: 'stop', ...model, path: { cwd: this.root, root: this.root },
          time: { created: started, completed: now }, cost: summary.cost, tokens: summary.tokens };
        const parts: Part[] = [
          { id: id('prt'), sessionID: session.id, messageID: user.id, type: 'compaction', auto: false },
          { id: id('prt'), sessionID: session.id, messageID: assistant.id, type: 'step-start' },
          { id: id('prt'), sessionID: session.id, messageID: assistant.id, type: 'text', text: summary.text, time: { start: started, end: now } },
          { id: id('prt'), sessionID: session.id, messageID: assistant.id, type: 'step-finish', reason: 'stop', cost: summary.cost, tokens: summary.tokens },
        ];
        this.store.transaction(() => {
          for (const message of [user, assistant]) {
            this.store.putMessage(message, false);
            this.store.mapMessage(session.id, message.id, summary.leaf);
          }
          for (const part of parts) this.store.putPart(part, false);
          this.store.native(session.id, summary.file, summary.leaf);
        });
        for (const info of [user, assistant]) {
          this.store.event(session.id, 'message.updated', { info });
          for (const part of parts.filter(p => p.messageID === info.id)) {
            this.store.event(session.id, 'message.part.updated', { part, time: now });
          }
        }
      }
      this.store.patchSession(session.id, {});
      this.store.event(session.id, 'session.compacted', { sessionID: session.id });
      return true;
    } catch (error) {
      const cancelled = abort.signal.aborted;
      const reported = cancelled ? new RequestError(409, '会话摘要已取消，可以重试。')
        : isRequestError(error) || isUserError(error) ? error : new UserError(this.driver.fallbackError);
      this.store.event(session.id, 'session.error', { sessionID: session.id, error: failure(reported.message, cancelled) });
      throw reported;
    } finally {
      this.active.delete(session.id);
      done.resolve(undefined);
      this.store.complete(session.id);
      this.store.event(session.id, 'session.status', { sessionID: session.id, status: { type: 'idle' } });
      this.store.event(session.id, 'session.idle', { sessionID: session.id });
    }
  }

  async abort(sessionID: string) {
    const run = this.active.get(sessionID);
    if (!run) {
      if (this.store.meta(sessionID)?.running) throw new RequestError(409, 'This run belongs to another bridge process');
      return false;
    }
    run.cancelled = true;
    run.abort.abort();
    await this.driver.abort(sessionID);
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
