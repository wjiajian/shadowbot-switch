import { object } from '../config.js';

export function parseObject(text: string) {
  try {
    const parsed: unknown = JSON.parse(text);
    return object(parsed) ? parsed : undefined;
  } catch { return undefined; }
}
