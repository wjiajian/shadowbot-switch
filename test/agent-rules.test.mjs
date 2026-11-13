import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadAgentRules, maxRuleBytes } from '../dist/service/agent-rules.js';

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'shadowbot-rules-'));
  const agent = join(root, 'agent'), app = join(root, 'app');
  fs.mkdirSync(agent);
  fs.mkdirSync(app);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, agent, app, install: join(agent, 'AGENTS.md'), local: join(app, 'AGENTS.md') };
}

test('rules bound UTF-8 input, omit local paths, prefer root over migration fallback and deduplicate', t => {
  const f = fixture(t);
  fs.writeFileSync(f.install, '\uFEFF全局规则');
  fs.mkdirSync(join(f.app, '.shadowbot-switch'));
  fs.writeFileSync(join(f.app, '.shadowbot-switch', 'AGENTS.md'), 'migrated-rule');
  let result = loadAgentRules(f.agent, f.app);
  assert.match(result.instructions, /全局规则.*migrated-rule/s);
  assert.ok(!result.instructions.includes(f.root));
  fs.writeFileSync(f.local, 'root-rule');
  assert.doesNotMatch(loadAgentRules(f.agent, f.app).instructions, /migrated-rule/);
  fs.writeFileSync(f.local, ' \n');
  assert.doesNotMatch(loadAgentRules(f.agent, f.app).instructions, /migrated-rule|## Application rules/);
  fs.writeFileSync(f.install, 'x'.repeat(maxRuleBytes));
  assert.equal(loadAgentRules(f.agent).files[0].content.length, maxRuleBytes);
  fs.appendFileSync(f.install, 'x');
  result = loadAgentRules(f.agent);
  assert.equal(result.instructions, '');
  assert.match(result.warnings[0], /32 KiB/);
  fs.writeFileSync(f.install, Buffer.from([0xc4, 0xe3, 0xba, 0xc3]));
  assert.match(loadAgentRules(f.agent).warnings[0], /UTF-8/);
  fs.writeFileSync(f.local, 'shared-file-marker');
  result = loadAgentRules(f.app, f.app);
  assert.equal(result.files.length, 1);
  assert.equal(result.instructions.match(/shared-file-marker/g).length, 1);
});

test('rules reject directory links escaping either scope but allow in-scope links', t => {
  const f = fixture(t);
  const outside = join(f.root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(join(outside, 'AGENTS.md'), 'outside-secret-marker');
  // Directory junctions work on Windows without symlink privileges.
  fs.symlinkSync(outside, join(f.app, '.shadowbot-switch'), 'junction');
  let result = loadAgentRules(f.agent, f.app);
  assert.equal(result.instructions, '');
  assert.match(result.warnings[0], /超出/);
  fs.unlinkSync(join(f.app, '.shadowbot-switch'));
  const inside = join(f.app, 'rules');
  fs.mkdirSync(inside);
  fs.writeFileSync(join(inside, 'AGENTS.md'), 'safe-linked-app-rule');
  fs.symlinkSync(inside, join(f.app, '.shadowbot-switch'), 'junction');
  assert.match(loadAgentRules(f.agent, f.app).instructions, /safe-linked-app-rule/);
  // File links may require privileges on Windows; scope checking above is always exercised.
  try { fs.symlinkSync(join(outside, 'AGENTS.md'), f.install, 'file'); }
  catch (error) {
    if (error.code === 'EPERM') { t.diagnostic('File symlinks unavailable; allowed and denied directory-junction paths verified'); return; }
    throw error;
  }
  assert.match(loadAgentRules(f.agent).warnings[0], /超出/);
  fs.unlinkSync(f.install);
  fs.writeFileSync(join(f.agent, 'rules.md'), 'safe-linked-rule');
  fs.symlinkSync(join(f.agent, 'rules.md'), f.install, 'file');
  result = loadAgentRules(f.agent);
  assert.match(result.instructions, /safe-linked-rule/);
  assert.deepEqual(result.warnings, []);
});

test('rule reads tolerate access errors, deletion, replacement, truncation and growth', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.local, 'healthy-app-rule');
  for (const scenario of ['denied', 'deleted', 'replaced', 'truncated', 'grown']) {
    await t.test(scenario, t => {
      fs.writeFileSync(f.install, 'original-installation-rule');
      const originalRead = fs.readSync;
      const originalOpen = fs.openSync;
      const canonical = fs.realpathSync.native(f.install);
      let changed = false;
      if (scenario === 'denied' || scenario === 'deleted') {
        t.mock.method(fs, 'openSync', (...args) => {
          if (args[0] === canonical) {
            if (scenario === 'deleted') fs.unlinkSync(f.install);
            throw Object.assign(new Error('synthetic read failure'), { code: scenario === 'denied' ? 'EACCES' : 'ENOENT' });
          }
          return originalOpen(...args);
        });
      } else {
        t.mock.method(fs, 'readSync', (...args) => {
          if (!changed) {
            changed = true;
            if (scenario === 'replaced') {
              fs.renameSync(f.install, join(f.agent, 'old.md'));
              fs.writeFileSync(f.install, 'replacement-rule');
            } else if (scenario === 'truncated') fs.truncateSync(f.install, 3);
            else fs.appendFileSync(f.install, 'x'.repeat(maxRuleBytes));
          }
          return originalRead(...args);
        });
      }
      syncBuiltinESMExports();
      try {
        const result = loadAgentRules(f.agent, f.app);
        assert.match(result.instructions, /healthy-app-rule/);
        assert.doesNotMatch(result.instructions, /Installation rules|original-installation-rule|replacement-rule/);
        if (scenario !== 'deleted') assert.equal(result.warnings.length, 1);
      } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    });
  }
});
