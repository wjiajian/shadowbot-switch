import type { Session } from '@opencode-ai/sdk/v2';
import { object } from '../config.js';
import { RequestError } from '../errors.js';
import type { Interactions } from '../interactions.js';
import { databaseBusy, failure, type Meta, type Store } from '../store.js';

export interface NativeHistory {
  parentOf(meta: Meta, entryID: string): string | null;
  prepareDelete(meta: Meta): () => void;
  repairInterrupted(meta: Meta, detail: string): void;
}

function alive(pid: number) {
  if (pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

export class SessionHistory {
  constructor(private options: { store: Store; interactions: Interactions; root: string; displayName: string; logPrefix: string;
    isActive(sessionID: string): boolean; native?: NativeHistory }) {}

  running() {
    for (const meta of this.options.store.running(this.options.root)) {
      this.recover(meta);
    }
    return this.options.store.running(this.options.root);
  }

  recover(meta: Meta) {
    if (this.options.isActive(meta.id) || (meta.owner_pid !== process.pid && alive(meta.owner_pid)) || !this.options.store.takeOver(meta)) return false;
    const detail = `${this.options.displayName} was interrupted before the run completed. Review any external tool operations before retrying.`;
    try { this.options.native?.repairInterrupted(meta, detail); }
    catch (error) {
      if (databaseBusy(error)) throw error;
      console.error(`${this.options.logPrefix} could not repair an interrupted native transcript`);
    }
    this.options.store.finishInterrupted(meta, detail);
    this.options.store.event(meta.id, 'session.error', { sessionID: meta.id, error: failure(detail, true) });
    this.options.store.event(meta.id, 'session.status', { sessionID: meta.id, status: { type: 'idle' } });
    this.options.store.event(meta.id, 'session.idle', { sessionID: meta.id });
    return true;
  }

  assertIdle(session: Session) {
    const meta = this.options.store.meta(session.id);
    if (this.options.isActive(session.id) || (meta?.running && !this.recover(meta))) throw new RequestError(409, 'The session is busy');
  }

  patchPart(session: Session, messageID: string, partID: string, input: Record<string, unknown>) {
    this.assertIdle(session);
    const part = this.options.store.message(session.id, messageID)?.parts.find(part => part.id === partID);
    if (!part) throw new RequestError(404, 'Message part not found');
    if (input.id !== partID || input.messageID !== messageID || input.sessionID !== session.id || input.type !== part.type) {
      throw new RequestError(400, 'Message part identity does not match the request path');
    }
    if (part.type !== 'text' || input.text !== part.text || (input.ignored !== undefined && input.ignored !== part.ignored) ||
        (input.synthetic !== undefined && input.synthetic !== part.synthetic)) {
      throw new RequestError(501, `This operation would edit the native ${this.options.displayName} transcript`);
    }
    if (input.metadata !== undefined && !object(input.metadata)) throw new RequestError(400, 'Invalid message part metadata');
    const updated = { ...part, metadata: input.metadata };
    this.options.store.putPart(updated);
    return updated;
  }

  rename(session: Session, title: string) {
    this.assertIdle(session);
    return this.options.store.patchSession(session.id, { title });
  }

  delete(session: Session) {
    const children = this.options.store.list(this.options.root).filter(child => child.parentID === session.id);
    for (const child of children) this.assertIdle(child);
    this.assertIdle(session);
    for (const child of children) this.delete(child);
    const cleanup = this.options.native?.prepareDelete(this.options.store.meta(session.id)!);
    this.options.store.delete(session);
    this.options.interactions.clearGrants(session.id);
    cleanup?.();
    return true;
  }

  revert(session: Session, messageID: string) {
    if (!this.options.native) throw new RequestError(501, `Native history is unavailable for ${this.options.displayName}`);
    this.assertIdle(session);
    const item = this.options.store.message(session.id, messageID);
    if (!item) throw new RequestError(404, 'Message not found');
    const anchor = item.info.role === 'assistant' ? this.options.store.message(session.id, item.info.parentID) : item;
    if (anchor?.info.role !== 'user') throw new RequestError(409, 'The turn has no user message');
    const meta = this.options.store.meta(session.id)!;
    const leaf = this.branchBefore(meta, anchor.info.id);
    const reverted = { ...session, revert: { messageID: anchor.info.id }, time: { ...session.time, updated: Date.now() } };
    return this.options.store.setRevert(reverted, leaf, meta.cutoff ? meta.revert_leaf : meta.native_leaf);
  }

  deleteMessage(session: Session, messageID: string) {
    if (!this.options.native) throw new RequestError(501, `Native history is unavailable for ${this.options.displayName}`);
    this.assertIdle(session);
    const item = this.options.store.message(session.id, messageID);
    if (!item) {
      if (this.options.store.wasMessageRemoved(session.id, messageID)) return true;
      throw new RequestError(404, 'Message not found');
    }
    const meta = this.options.store.meta(session.id)!;
    if (meta.cutoff && !this.options.store.messages(session.id).some(message => message.info.id === messageID)) {
      this.options.store.commitRevert(session.id);
      return true;
    }
    // A bridge-side error can create a projected assistant message without a native entry.
    const local = this.options.store.localCommand(session.id, messageID);
    const cutoff = local ? local.user_id : item.info.role === 'assistant' && (item.info.summary || (item.info.error && !this.options.store.mapped(session.id, messageID)))
      ? item.info.parentID : messageID;
    const leaf = this.branchBefore(meta, cutoff);
    this.options.store.removeMessages(session, cutoff, leaf);
    return true;
  }

  private branchBefore(meta: Meta, messageID: string) {
    const local = this.options.store.localCommand(meta.id, messageID);
    if (local) return local.native_leaf;
    const entryID = this.options.store.mapped(meta.id, messageID);
    if (!entryID) throw new RequestError(409, `The message has no native ${this.options.displayName} entry`);
    return this.options.native!.parentOf(meta, entryID);
  }

  unrevert(session: Session) {
    if (!this.options.native) throw new RequestError(501, `Native history is unavailable for ${this.options.displayName}`);
    this.assertIdle(session);
    const meta = this.options.store.meta(session.id)!;
    if (!meta.cutoff) return session;
    const restored = { ...session };
    delete restored.revert;
    return this.options.store.setRevert(restored, meta.revert_leaf, null);
  }
}
