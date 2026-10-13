import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scanner = fileURLToPath(new URL('../scripts/scan-secrets.mjs', import.meta.url));
const alphabet = 'Ab3Cd4Ef5Gh6Ij7Kl8Mn9Op0Qr1St2Uv3Wx4Yz5';
const fixture = {
  github: ['gh', 'p_', alphabet].join(''),
  githubFine: ['github_', 'pat_', alphabet, alphabet].join(''),
  openai: ['sk-', 'proj-', alphabet].join(''),
  aws: ['AK', 'IA', 'A1B2C3D4E5F6G7H8'].join(''),
  privateKey: ['-----', 'BEGIN ', 'RSA ', 'PRIVATE KEY-----'].join(''),
  generic: [alphabet.slice(0, 17), alphabet.slice(17)].join(''),
};

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, 'fixture git command must succeed');
  return result.stdout.trim();
}

function repository(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'bookmark-tidy-secrets-'));
  git(dir, 'init', '--quiet');
  git(dir, 'config', 'user.name', 'Scanner test');
  git(dir, 'config', 'user.email', 'scanner-test@example.invalid');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function scan(cwd, ...args) {
  return spawnSync(process.execPath, [scanner, ...args], { cwd, encoding: 'utf8' });
}

function findings(result) {
  return result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

test('tracked working files detect provider keys, private keys and high entropy assignments without printing values', t => {
  const dir = repository(t);
  const lines = [
    `credential = "${fixture.github}"`,
    `credential = "${fixture.githubFine}"`,
    `credential = "${fixture.openai}"`,
    `credential = "${fixture.aws}"`,
    fixture.privateKey,
    `API_KEY = "${fixture.generic}"`,
  ];
  writeFileSync(path.join(dir, 'credentials.js'), lines.join('\n'));
  git(dir, 'add', 'credentials.js');
  const result = scan(dir);
  assert.equal(result.status, 1);
  const found = findings(result);
  assert.deepEqual(new Set(found.map(item => item.type)), new Set(['github-token', 'openai-key', 'aws-access-key', 'private-key', 'high-entropy-assignment']));
  assert.equal(found.length, 6);
  for (const item of found) {
    assert.deepEqual(Object.keys(item).sort(), ['file', 'line', 'type']);
    assert.equal(item.file, 'credentials.js');
    assert.ok(item.line >= 1 && item.line <= 6);
  }
  for (const value of Object.values(fixture)) {
    assert.ok(!`${result.stdout}${result.stderr}`.includes(value), 'scan output must not expose a matching value');
  }
});

test('safe placeholders, ordinary text, binary files and untracked files do not block', t => {
  const dir = repository(t);
  writeFileSync(path.join(dir, 'safe.js'), 'const apiKey = "YOUR_API_KEY_PLACEHOLDER";\nconst token = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";');
  writeFileSync(path.join(dir, 'icon.png'), Buffer.from([0, 1, 2, 3]));
  git(dir, 'add', 'safe.js', 'icon.png');
  writeFileSync(path.join(dir, 'untracked.txt'), fixture.github);
  const result = scan(dir);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), '');
});

test('--staged reads the Git index even when the working copy has been cleaned', t => {
  const dir = repository(t);
  writeFileSync(path.join(dir, 'app.js'), fixture.github);
  git(dir, 'add', 'app.js');
  writeFileSync(path.join(dir, 'app.js'), '// locally cleaned but index still unsafe');
  const result = scan(dir, '--staged');
  assert.equal(result.status, 1);
  assert.deepEqual(findings(result), [{ file: 'app.js', line: 1, type: 'github-token' }]);
  assert.equal(scan(dir).status, 0);
});

test('--staged allows a safe staged version while a later unstaged edit contains a secret', t => {
  const dir = repository(t);
  writeFileSync(path.join(dir, 'app.js'), '// safe staged source');
  git(dir, 'add', 'app.js');
  writeFileSync(path.join(dir, 'app.js'), fixture.openai);
  assert.equal(scan(dir, '--staged').status, 0);
  assert.equal(scan(dir).status, 1);
});

test('--history detects a secret removed by a later commit and never prints its contents', t => {
  const dir = repository(t);
  mkdirSync(path.join(dir, 'nested'));
  writeFileSync(path.join(dir, 'nested', 'old.txt'), fixture.githubFine);
  git(dir, 'add', '.');
  git(dir, 'commit', '--quiet', '-m', 'test old snapshot');
  writeFileSync(path.join(dir, 'nested', 'old.txt'), 'safe replacement');
  git(dir, 'add', '.');
  git(dir, 'commit', '--quiet', '-m', 'test clean snapshot');
  assert.equal(scan(dir).status, 0);
  const result = scan(dir, '--history');
  assert.equal(result.status, 1);
  assert.deepEqual(findings(result), [{ file: 'nested/old.txt', line: 1, type: 'github-token' }]);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(fixture.githubFine));
});

test('history on a new repository is empty and unknown arguments fail closed', t => {
  const dir = repository(t);
  assert.equal(scan(dir, '--history').status, 0);
  assert.equal(scan(dir, '--unsupported').status, 2);
});

test('a detected credential embedded in a filename is redacted from metadata too', t => {
  const dir = repository(t);
  writeFileSync(path.join(dir, `file-${fixture.github}.txt`), fixture.github);
  git(dir, 'add', '.');
  const result = scan(dir);
  assert.equal(result.status, 1);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(fixture.github));
  assert.equal(findings(result)[0].file, 'file-[redacted-github-token].txt');
});
