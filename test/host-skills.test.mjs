import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { skillSources } from '../dist/service/host-skills.js';
import { skills } from '../dist/service/shadowbot.js';

test('official skills follow the live runtime and refresh archive contents without reinstalling', {
  skip: process.platform !== 'win32',
}, () => {
  const fixture = mkdtempSync(join(tmpdir(), 'shadowbot-host-skills-'));
  const home = join(fixture, 'project');
  const resources = join(fixture, 'Resources');
  const archives = join(resources, 'Skills');
  const runtime = join(fixture, 'runtime', 'skills');
  const live = join(runtime, 'fixture-explorer');
  const zipSource = join(fixture, 'zip-source');
  const archive = join(archives, 'fixture-sdk.zip');
  const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  const markdown = (name, revision) => `---\nname: ${name}\ndescription: Revision ${revision}.\n---\n${revision}\n`;
  try {
    for (const path of [archives, live, join(zipSource, 'references')]) mkdirSync(path, { recursive: true });
    const pack = revision => {
      writeFileSync(join(zipSource, 'SKILL.md'), markdown('fixture-sdk', revision));
      writeFileSync(join(zipSource, 'references', 'api.md'), revision);
      execFileSync(tar, ['-a', '-cf', archive, '-C', zipSource, 'SKILL.md', 'references']);
    };
    const sources = skillSources(home, { resources, hostSkills: runtime });
    const scan = () => Object.fromEntries(skills(join(home, 'agent'), home, sources, {}).map(skill => [skill.name, skill]));
    const liveFile = join(live, 'SKILL.md');
    writeFileSync(liveFile, markdown('fixture-explorer', 'first'));
    pack('first');
    const first = scan();
    const link = join(sources.cache, 'runtime');
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(realpathSync.native(first['fixture-explorer'].filePath), realpathSync.native(liveFile));
    assert.equal(readFileSync(join(first['fixture-sdk'].baseDir, 'references', 'api.md'), 'utf8'), 'first');
    assert.equal(scan()['fixture-sdk'].filePath, first['fixture-sdk'].filePath);

    writeFileSync(liveFile, markdown('fixture-explorer', 'second'));
    pack('second');
    const second = scan();
    assert.equal(second['fixture-explorer'].filePath, first['fixture-explorer'].filePath);
    assert.equal(second['fixture-explorer'].description, 'Revision second.');
    assert.notEqual(second['fixture-sdk'].filePath, first['fixture-sdk'].filePath);
    assert.equal(readFileSync(join(second['fixture-sdk'].baseDir, 'references', 'api.md'), 'utf8'), 'second');
    assert.equal(readFileSync(join(first['fixture-sdk'].baseDir, 'references', 'api.md'), 'utf8'), 'first');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
