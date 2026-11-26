import assert from 'node:assert/strict';
import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

test('Pi SDK dependencies are confined to the Pi adapter in source and runtime', () => {
  for (const [cwd, extension] of [['src', 'ts'], ['dist/service', 'js']]) {
    const files = globSync(`**/*.${extension}`, { cwd, exclude: ['adapters/pi/**', '**/node_modules/**'] });
    assert.ok(files.length, cwd);
    for (const file of files) {
      assert.ok(!readFileSync(join(cwd, file), 'utf8').includes('@earendil-works/'), join(cwd, file));
    }
  }
});
