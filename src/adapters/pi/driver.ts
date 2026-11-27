import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAgentSession, DefaultResourceLoader, estimateTokens, generateSummaryWithUsage, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { AgentSession, AgentSessionEvent, ExtensionFactory, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { clampThinkingLevel, getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import type { AssistantMessage as PiAssistant, ModelThinkingLevel, Usage } from '@earendil-works/pi-ai';
import type { UserMessage } from '@opencode-ai/sdk/v2';
import type { AdapterContext } from '../../adapter.js';
import { copilot, object } from '../../config.js';
import { modelError, RequestError, UserError } from '../../errors.js';
import type { DriverTurn, HarnessDriver, ThinkingCapability } from '../../host/runs.js';
import type { ToolDescriptor } from '../../host/types.js';
import { atomicWrite } from '../../installation.js';
import type { HostTool } from '../../mcp/hub.js';
import type { Meta, Store } from '../../store.js';
import type { McpHub } from './mcp.js';
import type { HostConfig } from './config.js';
import { contextSettings, projectToolContext, runtimeContextEntry, withRuntimeContext } from './context.js';
import { initialThinkingLevel } from './thinking.js';

type Model = Awaited<ReturnType<HostConfig['model']>>;
type Turn = DriverTurn<Model, SessionManager>;
type PiHostTool = HostTool & { definition: ToolDefinition };

function string(value: unknown) { return typeof value === 'string' ? value : ''; }

function usageTotals(usage?: Usage) {
  return { cost: usage?.cost?.total ?? 0, tokens: { total: usage?.totalTokens ?? 0, input: usage?.input ?? 0,
    output: usage?.output ?? 0, reasoning: usage?.reasoning ?? 0, cache: { read: usage?.cacheRead ?? 0, write: usage?.cacheWrite ?? 0 } } };
}

export class PiDriver implements HarnessDriver<Model, SessionManager> {
  readonly displayName = 'Pi';
  readonly logPrefix = 'ShadowBotPi';
  readonly fallbackError = 'Pi 请求失败。检查影刀中的模型设置，运行 .\\switch.ps1 doctor 和 mcp status 查看诊断。';
  readonly descriptors: Record<string, ToolDescriptor> = {
    read: { kind: 'read', permission: 'read' }, ls: { kind: 'list', permission: 'read' },
    grep: { kind: 'grep', permission: 'grep' }, find: { kind: 'glob', permission: 'glob' },
  };
  private readonly sessionsDir: string;
  private readonly nativeAgentDir: string;
  private readonly sessions = new Map<string, { pi: AgentSession; unsubscribe?: () => void }>();
  constructor(private ctx: AdapterContext) {
    this.sessionsDir = join(ctx.home, 'backends', 'pi', 'sessions');
    this.nativeAgentDir = join(ctx.home, 'harnesses', 'pi', 'agent');
    mkdirSync(this.sessionsDir, { recursive: true });
  }

  async resolveModel(request: UserMessage['model'] | undefined, agent: string) {
    const handle = await (this.ctx.config as HostConfig).model(request, agent);
    return { handle, selection: handle.selection };
  }

  readonly thinking: ThinkingCapability<Model> = {
    supportedLevels: model => getSupportedThinkingLevels(model.resolved),
    clamp: (model, level) => clampThinkingLevel(model.resolved, level as ModelThinkingLevel),
    baseline: meta => {
      const current = this.sessions.get(meta.id)?.pi.thinkingLevel;
      if (current !== undefined) return current;
      const manager = this.manager(meta);
      return manager.getBranch().some(entry => entry.type === 'thinking_level_change')
        ? manager.buildSessionContext().thinkingLevel : initialThinkingLevel;
    },
  };

  readonly history: NonNullable<HarnessDriver<Model, SessionManager>['history']> = {
    prepareTurn: meta => this.manager(meta),
    appendNoReply: (manager, { text, images, timestamp }) => {
      const entryID = manager.appendMessage({ role: 'user', content: [{ type: 'text', text }, ...images], timestamp });
      const file = manager.getSessionFile()!;
      if (!existsSync(file)) atomicWrite(file, [manager.getHeader(), ...manager.getEntries()].map(row => JSON.stringify(row)).join('\n') + '\n');
      return { file, entryID };
    },
    checkpoint: (manager, phase) => {
      const file = manager.getSessionFile();
      const leaf = manager.getLeafId();
      if (phase === 'compact' || (file && existsSync(file))) return { file, leaf };
    },
    repairInterrupted: (meta, detail) => this.recoverContext(meta, detail),
    prepareDelete: meta => {
      const file = this.transcriptPath(meta);
      return () => { if (file) rmSync(file, { force: true }); };
    },
    parentOf: (meta, entryID) => {
      const entry = this.manager(meta).getEntry(entryID);
      if (entry?.type !== 'message' && entry?.type !== 'compaction') throw new RequestError(409, 'The native Pi entry is unavailable');
      return entry.parentId;
    },
  };

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
      return SessionManager.create(this.ctx.root, dir);
    }
    const manager = SessionManager.open(file, dir, this.ctx.root);
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
    this.ctx.store.native(meta.id, manager.getSessionFile(), manager.getLeafId());
  }

  legacyMcpTools(onUncertain: (name: string) => void) {
    const legacy = this.ctx.mcp as Partial<McpHub>;
    const result = new Map<string, PiHostTool>();
    for (const [name, tool] of legacy.tools?.(onUncertain) ?? []) {
      const { definition, builtin, server } = tool;
      result.set(name, { name, builtin, server, label: definition.label, description: definition.description,
        parameters: { ...definition.parameters }, definition,
        // Legacy MCP definitions use only the first three SDK execution arguments.
        execute: (args, signal) => (definition.execute as (id: string, args: unknown, signal?: AbortSignal) =>
          ReturnType<HostTool['execute']>)('', args, signal),
      });
    }
    return result;
  }

  async abort(sessionID: string) { await this.sessions.get(sessionID)?.pi.abort(); }
  dispose(sessionID: string) {
    const session = this.sessions.get(sessionID);
    session?.unsubscribe?.();
    session?.pi.dispose();
    this.sessions.delete(sessionID);
  }

  async summarize(meta: Meta, selection: UserMessage['model'], signal: AbortSignal) {
    const manager = this.manager(meta);
    const file = manager.getSessionFile()!;
    const history = manager.buildSessionContext().messages;
    const rewrite = contextSettings();
    const messages = rewrite.enabled ? projectToolContext(history, rewrite.compressSnapshots) : history;
    const { handle } = await this.resolveModel(selection, copilot);
    const instructions = this.ctx.config.value.agent?.compaction?.prompt ??
      '用中文按以下 Markdown 标题整理会话：## 目标、## 重要信息、## 工作状态（### 已完成、### 进行中、### 阻塞）、## 下一步、## 相关文件。';
    const { text, usage } = await generateSummaryWithUsage(messages, handle.resolved, undefined, undefined, undefined, signal,
      instructions, undefined, undefined, (model, context, options) => handle.runtime.streamSimple(model, context, options)).catch(error => {
        throw new UserError(modelError(error instanceof Error ? error.message : ''));
      });
    signal.throwIfAborted();
    if (!text.trim()) throw new UserError('模型返回了空摘要，请重试或更换模型。');
    const tokens = messages.reduce((total, message) => total + estimateTokens(message), 0);
    const entry = manager.appendCompaction(text, null, tokens, undefined, false, usage);
    // Pi delays writing new files until the first assistant message (e.g. command-only sessions).
    if (!existsSync(file)) atomicWrite(file, [manager.getHeader(), ...manager.getEntries()].map(row => JSON.stringify(row)).join('\n') + '\n');
    return { text, file, leaf: entry, ...usageTotals(usage) };
  }

  async runTurn(turn: Turn) {
    const { session, text, images, signal, instructions, contextSettings: rewrite } = turn;
    const manager = turn.prepared!;
    const projection = new Projection(this.ctx.store, manager, turn, () => this.abort(session.id));
    const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: true } });
    const extension: ExtensionFactory = pi => {
      for (const tool of turn.mcpTools.values()) {
        if ('definition' in tool) pi.registerTool((tool as PiHostTool).definition);
        else pi.registerTool({ name: tool.name, label: tool.label, description: tool.description,
          parameters: tool.parameters as ToolDefinition['parameters'], execute: (_id, args, signal) => tool.execute(args, signal) });
      }
      for (const tool of turn.hostTools) pi.registerTool({ ...tool, parameters: tool.parameters as ToolDefinition['parameters'] });
      pi.on('tool_call', async event => {
        const args = event.input as Record<string, unknown>;
        const auth = await turn.authorize(event.toolCallId, event.toolName, args);
        if (!auth.allow) return { block: true, reason: auth.reason };
        if (auth.checkedPath) args.path = pathToFileURL(auth.checkedPath).href;
      });
      pi.on('tool_result', event => {
        const content = turn.limitOutput(event.toolName, event.content);
        if (content) return { content, details: { truncated: true } };
      });
      if (rewrite.enabled) pi.on('context', event => ({ messages: projectToolContext(event.messages, rewrite.compressSnapshots) }));
      pi.on('context_with_system', event => ({ messages: withRuntimeContext(event.messages, turn.runtimeContext) }));
      pi.on('session_compact', async event => {
        const compaction = manager.getBranch().findLast(entry => entry.type === 'compaction') ?? event.compactionEntry;
        await turn.refreshRuntimeContext(instructions => pi.appendEntry(runtimeContextEntry, { compactionID: compaction.id, instructions }));
      });
    };
    const resourceLoader = new DefaultResourceLoader({ cwd: this.ctx.root, agentDir: this.nativeAgentDir, settingsManager: settings,
      noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
      disabledBuiltinExtensions: ['mcp', 'codemode', 'tool_search'], extensionFactories: [extension], appendSystemPrompt: instructions,
    });
    await resourceLoader.reload();
    const { session: pi } = await createAgentSession({ cwd: this.ctx.root, agentDir: this.nativeAgentDir, settingsManager: settings,
      resourceLoader, sessionManager: manager, modelRuntime: turn.model.runtime, model: turn.model.resolved,
      thinkingLevel: turn.savedThinking as ModelThinkingLevel | undefined, tools: turn.toolNames });
    const live: { pi: AgentSession; unsubscribe?: () => void } = { pi };
    this.sessions.set(session.id, live);
    live.unsubscribe = pi.subscribe(event => projection.handle(event));
    await pi.bindExtensions({ mode: 'rpc' });
    signal.throwIfAborted();
    await pi.prompt(text, { images, expandPromptTemplates: false, source: 'rpc' });
  }
}

class Projection {
  private error?: unknown;
  constructor(private store: Store, private manager: SessionManager, private turn: Turn, private abortPi: () => Promise<void>) {}
  handle(event: AgentSessionEvent) {
    if (this.error) return;
    try { this.project(event); }
    catch (error) {
      this.error = error;
      this.turn.translationFailed(error); this.turn.abort();
      void this.abortPi().catch(() => undefined);
    }
  }

  private project(event: AgentSessionEvent) {
    switch (event.type) {
      case 'message_start':
        if (event.message.role === 'assistant') this.turn.recorder.begin(event.message.timestamp);
        break;
      case 'message_update': {
        if (!this.turn.recorder.last) break;
        const delta = event.assistantMessageEvent;
        if (delta.type === 'text_delta' || delta.type === 'thinking_delta') {
          this.turn.recorder.delta(delta.contentIndex, delta.type === 'text_delta' ? 'text' : 'reasoning', delta.delta);
        }
        break;
      }
      case 'message_end': {
        const native = event.message;
        if (native.role === 'assistant') this.finish(native);
        const projected = native.role === 'assistant' ? this.turn.recorder.last?.id : native.role === 'user' ? this.turn.user.id : undefined;
        queueMicrotask(() => {
          if (this.error) return;
          try {
            const entry = this.manager.getLeafEntry();
            const file = this.manager.getSessionFile();
            if (entry?.type === 'message' && entry.message === native) {
              if (projected) this.store.mapMessage(this.turn.session.id, projected, entry.id);
              if (file && existsSync(file)) this.store.native(this.turn.session.id, file, entry.id);
            }
          } catch (error) { this.error = error; this.turn.translationFailed(error); this.turn.abort(); }
        });
        break;
      }
      case 'tool_execution_start':
        this.turn.recorder.toolRunning(event.toolCallId, event.toolName, event.args);
        break;
      case 'tool_execution_end': {
        const output = Array.isArray(event.result?.content) ? event.result.content.map((block: unknown) => object(block) && block.type === 'text' ? string(block.text) : '').filter(Boolean).join('\n') : '';
        const metadata = object(event.result?.details) ? event.result.details : {};
        this.turn.recorder.toolEnd(event.toolCallId, { isError: event.isError, output, metadata });
        break;
      }
      case 'compaction_end':
        if (event.result) this.turn.recorder.compacted();
        break;
    }
  }

  private finish(native: PiAssistant) {
    const segments: { index: number; kind: 'text' | 'reasoning'; text: string }[] = [];
    for (const [index, item] of native.content.entries()) {
      if (item.type === 'text') segments.push({ index, kind: 'text', text: item.text });
      if (item.type === 'thinking') segments.push({ index, kind: 'reasoning', text: item.thinking });
    }
    this.turn.recorder.finishStep({ created: native.timestamp, segments, ...usageTotals(native.usage),
      finish: native.stopReason === 'toolUse' ? 'tool-calls' : native.stopReason,
      error: native.stopReason === 'error' || native.stopReason === 'aborted'
        ? { message: modelError(native.errorMessage), aborted: native.stopReason === 'aborted' } : undefined });
  }
}
