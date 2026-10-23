import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
}

// Patterns for credential material that must never be committed.
const SECRET_PATTERNS = [
  [/sk-[A-Za-z0-9_-]{20,}/, 'OpenAI-style API key'],
  [/EAA[A-Za-z0-9]{30,}/, 'Meta page access token'],
  [/ghp_[A-Za-z0-9]{20,}/, 'GitHub personal access token'],
  [/AKIA[0-9A-Z]{16}/, 'AWS access key id'],
  [/AIza[0-9A-Za-z_-]{30,}/, 'Google API key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
];

test('no tracked file contains credential material', () => {
  const files = git(['ls-files']).split('\n').filter(Boolean);
  assert.ok(files.length > 0, 'expected tracked files');

  const offenders = [];
  for (const file of files) {
    let content;
    try {
      content = git(['show', `:${file}`]);
    } catch {
      continue; // binary or unreadable via git show
    }
    for (const [pattern, label] of SECRET_PATTERNS) {
      if (pattern.test(content)) offenders.push(`${file} -> ${label}`);
    }
  }
  assert.deepEqual(offenders, [], `tracked files must not contain secrets:\n${offenders.join('\n')}`);
});

test('runtime environment files are ignored and never tracked', () => {
  const ignored = git(['check-ignore', '.env', '.env.local', 'node_modules/x']);
  for (const entry of ['.env', '.env.local', 'node_modules/x']) {
    assert.ok(ignored.split('\n').includes(entry), `${entry} should be git-ignored`);
  }
  const tracked = git(['ls-files']).split('\n');
  assert.ok(!tracked.includes('.env'), '.env must never be tracked');
  assert.ok(tracked.includes('.env.example'), '.env.example is the intended tracked template');
});

test('.env.example contains only placeholder values, no real secrets', () => {
  const example = git(['show', ':.env.example']);
  for (const [pattern] of SECRET_PATTERNS) {
    assert.equal(pattern.test(example), false, '.env.example must not embed real credentials');
  }
});
