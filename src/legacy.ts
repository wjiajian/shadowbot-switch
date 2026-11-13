import { join } from 'node:path';
import type { Installation } from './installation.js';

// Keep pre-registry metadata interpretation in one compatibility reader.
export function legacyRuntimeDirectory(home: string, installation: Installation) {
  const id = installation.runtimeRelease;
  if (id === undefined) return home;
  if (!/^[0-9a-f]{64}$/.test(id)) throw new Error('Invalid installation release ID');
  return installation.piVersion ? join(home, 'harnesses', 'pi', 'releases', id) : join(home, 'releases', id);
}
export function legacyRuntimeHarness() { return 'pi'; }
export function legacyVersion(installation: Installation, harness: string) { return harness === 'pi' ? installation.piVersion : undefined; }
