import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { skillSources } from '../dist/service/host-skills.js';
import { skills } from '../dist/service/shadowbot.js';
import { syncSkillCommands } from '../dist/service/skill-commands.js';
import { loadSkillsFromDir } from '../dist/service/skills.js';

test('shared skill discovery retains ignore rules, root markdown and non-fatal naming diagnostics', () => {
  const root = mkdtempSync(join(tmpdir(), 'shadowbot-skill-discovery-'));
  const put = (folder, name) => {
    mkdirSync(join(root, folder), { recursive: true });
    writeFileSync(join(root, folder, 'SKILL.md'), `---\nname: ${name}\ndescription: Fixture skill.\n---\nInstructions`);
  };
  try {
    put('ignored', 'ignored'); put('node_modules/dependency', 'dependency'); put('warning', 'Mixed_Case');
    put('parent/hidden', 'hidden'); put('parent/visible', 'visible');
    writeFileSync(join(root, '.gitignore'), 'ignored/\n');
    writeFileSync(join(root, 'parent', '.ignore'), 'hidden/\n');
    writeFileSync(join(root, 'flat.md'), '---\nname: flat\ndescription: Root markdown.\n---\nInstructions');
    writeFileSync(join(root, 'notes.md'), 'Ordinary notes without skill metadata.');
    const loaded = loadSkillsFromDir({ dir: root, source: 'custom' });
    assert.deepEqual(loaded.skills.map(s => s.name).sort(), ['Mixed_Case', 'flat', 'visible']);
    assert.ok(loaded.diagnostics.some(d => d.type === 'warning' && d.path.includes('warning')));
    assert.equal(loaded.diagnostics.some(d => d.path.endsWith('notes.md')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

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

test('skill menu sync updates its own command and preserves existing command files', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'shadowbot-skill-commands-'));
  const resources = join(fixture, 'Resources');
  const commands = join(resources, 'Copilot', 'commands');
  const skills = join(fixture, 'skills');
  const generated = join(commands, 'skill-fixture.md');
  try {
    mkdirSync(commands, { recursive: true });
    writeFileSync(join(commands, 'spec.md'), 'official preset');
    writeFileSync(join(commands, 'skill-existing.md'), 'user command');
    for (const name of ['fixture', 'existing']) {
      mkdirSync(join(skills, name), { recursive: true });
      writeFileSync(join(skills, name, 'SKILL.md'), `---\nname: ${name}\ndescription: >-\n  A description\n  on two lines.\n---\nSkill content.`);
    }
    syncSkillCommands(resources, skills);
    assert.equal(parse(readFileSync(generated, 'utf8').split('---')[1]).description, 'A description on two lines.');
    assert.equal(readFileSync(join(commands, 'skill-existing.md'), 'utf8'), 'user command');
    writeFileSync(join(skills, 'fixture', 'SKILL.md'), '---\nname: fixture\ndescription: Updated description.\n---\nSkill content.');
    syncSkillCommands(resources, skills);
    assert.equal(parse(readFileSync(generated, 'utf8').split('---')[1]).description, 'Updated description.');
    syncSkillCommands(resources);
    assert.deepEqual(readdirSync(commands).sort(), ['skill-existing.md', 'spec.md']);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
