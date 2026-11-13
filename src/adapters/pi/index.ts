import { join } from 'node:path';

// Pi reads its agent directory during module evaluation. Set it before importing
// any SDK code, so credentials never fall back to the user's standalone Pi home.
export async function initialize(home: string) {
  process.env.PI_CODING_AGENT_DIR = join(home, 'harnesses', 'pi', 'agent');
  return (await import('./implementation.js')).adapter;
}
