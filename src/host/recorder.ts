import type { AssistantMessage, Part, Session, ToolPart, UserMessage } from '@opencode-ai/sdk/v2';
import { emptyTokens, object } from '../config.js';
import { failure, id, type Store } from '../store.js';

export class TurnRecorder {
  last?: AssistantMessage;
  private segments = new Map<number, Extract<Part, { type: 'text' | 'reasoning' }>>();
  private toolParts = new Map<string, ToolPart>();

  constructor(private store: Store, private session: Session, private user: UserMessage,
    private model: UserMessage['model'], private root: string) {}

  begin(created = Date.now()) {
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

  delta(index: number, kind: 'text' | 'reasoning', text: string) {
    if (!this.last) return;
    const record = this.segment(index, kind);
    record.text += text;
    this.store.putPart(record, false);
    this.store.event(this.session.id, 'message.part.delta', { sessionID: this.session.id, messageID: record.messageID,
      partID: record.id, field: 'text', delta: text });
  }

  compacted() {
    this.store.event(this.session.id, 'session.compacted', { sessionID: this.session.id });
  }

  toolEnd(callID: string, { isError, output, metadata }: { isError: boolean; output: string; metadata: Record<string, unknown> }) {
    const record = this.toolParts.get(callID);
    if (!record) return;
    const state = record.state;
    const time = { start: state.status === 'pending' ? Date.now() : state.time.start, end: Date.now() };
    record.state = isError ? { status: 'error', input: state.input, error: output || 'Tool execution failed', time, metadata }
      : { status: 'completed', input: state.input, output, title: record.tool, time, metadata };
    this.store.putPart(record);
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

  toolRunning(callID: string, name: string, args: unknown) {
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

  finishStep(input: { created?: number; segments: { index: number; kind: 'text' | 'reasoning'; text: string }[];
    cost: number; tokens: AssistantMessage['tokens']; finish: string; error?: { message: string; aborted: boolean } }) {
    if (!this.last) this.begin(input.created);
    const info = this.last!;
    for (const { index, kind, text } of input.segments) {
      const record = this.segment(index, kind);
      record.text = text;
      record.time = { start: record.time?.start ?? info.time.created, end: Date.now() };
      this.store.putPart(record);
    }
    info.time.completed = Date.now();
    info.cost = input.cost;
    info.tokens = input.tokens;
    info.finish = input.finish;
    if (input.error) info.error = failure(input.error.message, input.error.aborted);
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
