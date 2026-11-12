import type { PermissionAction, PermissionRequest, PermissionRule, QuestionInfo, QuestionRequest } from '@opencode-ai/sdk/v2';
import { id } from './store.js';
import { object } from './config.js';

type Emit = (sessionID: string, type: string, properties: Record<string, unknown>) => void;
type Reply = 'once' | 'always' | 'reject';
type Pending<T, R> = { request: T; resolve: (value: R) => void; reject: (error: Error) => void };
type PermissionScope = Pick<PermissionRequest, 'patterns' | 'always' | 'metadata'>;

export class Interactions {
  private permissions = new Map<string, Pending<PermissionRequest, Reply>>();
  private questions = new Map<string, Pending<QuestionRequest, string[][]>>();
  private grants = new Map<string, Set<string>>();
  constructor(private emit: Emit) {}

  async permission(sessionID: string, permission: string, reference: { messageID: string; callID: string }, signal: AbortSignal,
    scope: PermissionScope = { patterns: [permission], always: [permission], metadata: {} }, requestSessionID = sessionID) {
    const key = JSON.stringify([permission, scope.always]);
    if (this.grants.get(sessionID)?.has(key)) return true;
    const request: PermissionRequest = { id: id('per'), sessionID: requestSessionID, permission, ...scope, tool: reference };
    const answer = await this.wait(this.permissions, request, 'permission.asked', signal);
    if (answer === 'always') {
      let grants = this.grants.get(sessionID);
      if (!grants) this.grants.set(sessionID, grants = new Set());
      grants.add(key);
    }
    return answer !== 'reject';
  }

  question(sessionID: string, questions: QuestionInfo[], tool: { messageID: string; callID: string }, signal: AbortSignal) {
    const request: QuestionRequest = { id: id('que'), sessionID, questions, tool };
    return this.wait(this.questions, request, 'question.asked', signal);
  }

  private async wait<T extends PermissionRequest | QuestionRequest, R>(map: Map<string, Pending<T, R>>, request: T, event: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const pending = Promise.withResolvers<R>();
    map.set(request.id, { request, resolve: pending.resolve, reject: pending.reject });
    const cancel = () => {
      map.delete(request.id);
      if (event === 'question.asked') this.emit(request.sessionID, 'question.rejected', { sessionID: request.sessionID, requestID: request.id });
      else this.emit(request.sessionID, 'permission.replied', { sessionID: request.sessionID, requestID: request.id, reply: 'reject' });
      pending.reject(new Error('Run cancelled'));
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      this.emit(request.sessionID, event, { ...request });
      return await pending.promise;
    } finally {
      map.delete(request.id);
      signal.removeEventListener('abort', cancel);
    }
  }

  list(kind: 'permission' | 'question', owns: (sessionID: string) => boolean) {
    const values = kind === 'permission' ? [...this.permissions.values()] : [...this.questions.values()];
    return values.map(entry => entry.request).filter(request => owns(request.sessionID));
  }

  permissionReply(requestID: string, reply: Reply, owns: (sessionID: string) => boolean) {
    const pending = this.permissions.get(requestID);
    if (!pending || !owns(pending.request.sessionID)) return false;
    this.permissions.delete(requestID);
    const { sessionID } = pending.request;
    pending.resolve(reply);
    this.emit(sessionID, 'permission.replied', { sessionID, requestID, reply });
    return true;
  }

  questionReply(requestID: string, answers: string[][] | null, owns: (sessionID: string) => boolean) {
    const pending = this.questions.get(requestID);
    if (!pending || !owns(pending.request.sessionID)) return false;
    if (answers && answers.length !== pending.request.questions.length) throw new Error('Incorrect number of question answers');
    if (answers) {
      answers.forEach((selected, index) => {
        const q = pending.request.questions[index];
        if ((!q.multiple && selected.length !== 1) || (q.custom === false && selected.some(answer => !q.options.some(option => option.label === answer)))) {
          throw new Error('Invalid question answer');
        }
      });
    }
    this.questions.delete(requestID);
    const { sessionID } = pending.request;
    if (answers) pending.resolve(answers);
    else pending.reject(new Error('Question rejected'));
    this.emit(sessionID, answers ? 'question.replied' : 'question.rejected', { sessionID, requestID, answers });
    return true;
  }

  clearGrants(sessionID: string) { this.grants.delete(sessionID); }
}

function wildcard(pattern: string, value: string) {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(value);
}

function permissionAction(value: unknown): value is PermissionAction {
  return value === 'allow' || value === 'ask' || value === 'deny';
}

export function* permissionRules(...policies: unknown[]): Generator<PermissionRule> {
  for (const policy of policies) {
    if (Array.isArray(policy)) {
      for (const rule of policy) {
        if (object(rule) && typeof rule.permission === 'string' && typeof rule.pattern === 'string' &&
          permissionAction(rule.action)) yield { permission: rule.permission, pattern: rule.pattern, action: rule.action };
      }
    } else if (object(policy)) {
      for (const [permission, rule] of Object.entries(policy)) {
        if (object(rule)) {
          for (const [pattern, action] of Object.entries(rule)) if (permissionAction(action)) yield { permission, pattern, action };
        } else if (permissionAction(rule)) yield { permission, pattern: '*', action: rule };
      }
    } else if (permissionAction(policy)) yield { permission: '*', pattern: '*', action: policy };
  }
}

export function decision(tool: string, pattern: string, initial: PermissionAction, ...policies: unknown[]): PermissionAction {
  let result = initial;
  const pathPermission = process.platform === 'win32' && (tool === 'external_directory' || tool === 'read');
  const normalize = (value: string) => pathPermission ? value.replaceAll('\\', '/').toLowerCase() : value;
  for (const rule of permissionRules(...policies)) {
    if (wildcard(rule.permission, tool) && wildcard(normalize(rule.pattern), normalize(pattern))) result = rule.action;
  }
  return result;
}

export function permissionMayAllow(tool: string, ...policies: unknown[]) {
  let allowed = true;
  for (const { permission, pattern, action } of permissionRules(...policies)) {
    if (!wildcard(permission, tool)) continue;
    if (action === 'allow' || action === 'ask') allowed = true;
    else if (pattern === '*') allowed = false;
  }
  return allowed;
}
