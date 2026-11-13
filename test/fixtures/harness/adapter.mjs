import { HostConfig, copilot, emptyTokens } from '../../config.js';
import { Interactions } from '../../interactions.js';
import { RequestError } from '../../errors.js';
import { id } from '../../store.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Deliberately no Pi imports, model calls or MCP. This is a contract fixture, not a product engine.
export const adapter = {
  id: 'fixture',
  async verify(version) { if (version !== '1.0.0') throw new Error('Fixture version mismatch'); },
  createConfig: () => new HostConfig(),
  createRuns({ store, root, home }) {
    const unsupported = () => { throw new RequestError(501, 'Fixture operation unavailable'); };
    return {
      active: new Map(), interactions: new Interactions((session, event, fields) => store.event(session, event, fields)),
      running: () => [], abort: async () => false,
      rename: (session, title) => store.update({ ...session, title }),
      delete(session) { store.delete(session); return true; },
      revert: unsupported, unrevert: unsupported, deleteMessage: unsupported, patchPart: unsupported,
      async start(session, prompt) {
        const userID = id('msg'), replyID = id('msg'), now = Date.now();
        store.putMessage({ id: userID, sessionID: session.id, role: 'user', time: { created: now }, agent: copilot, model: { providerID: 'fixture', modelID: 'fixture' } });
        store.putPart({ id: id('prt'), sessionID: session.id, messageID: userID, type: 'text', text: prompt.parts.map(p => p.text ?? '').join('') });
        store.putMessage({ id: replyID, sessionID: session.id, role: 'assistant', parentID: userID, time: { created: now, completed: now },
          modelID: 'fixture', providerID: 'fixture', mode: copilot, agent: copilot, path: { cwd: root, root }, cost: 0, tokens: emptyTokens(), finish: 'stop' });
        store.putPart({ id: id('prt'), sessionID: session.id, messageID: replyID, type: 'text', text: 'fixture reply' });
        const directory = join(home, 'backends', 'fixture', 'sessions');
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, `${session.id}.json`), JSON.stringify(prompt));
        return store.message(session.id, replyID);
      },
    };
  },
};
