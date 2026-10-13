import { readFileSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const detectors = [
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{20,255})\b/u],
  ['openai-key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,255}\b/u],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u],
  ['private-key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/u],
];

function safeFileName(file) {
  let name = file;
  for (const [type, pattern] of detectors) {
    name = name.replace(new RegExp(pattern.source, 'gu'), `[redacted-${type}]`);
  }
  return name;
}

function entropy(value) {
  const counts = new Map();
  for (const character of value) counts.set(character, (counts.get(character) || 0) + 1);
  return [...counts.values()].reduce((total, count) => total - (count / value.length) * Math.log2(count / value.length), 0);
}

/** Returns metadata only; matching values must never leave this function. */
export function scanText(text, file) {
  const findings = [];
  const displayFile = safeFileName(file);
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    let known = false;
    for (const [type, pattern] of detectors) {
      if (pattern.test(line)) {
        findings.push({ file: displayFile, line: index + 1, type });
        known = true;
      }
    }
    if (known) continue;
    const assignments = /\b[\w$]*(?:key|secret|token|password|passwd)[\w$]*["']?\s*[:=]\s*["']([A-Za-z0-9+/_=-]{20,255})["']/giu;
    for (const match of line.matchAll(assignments)) {
      const value = match[1];
      if (/example|placeholder|dummy|changeme|replace|your[_-]|test[_-]?(?:key|token|secret)/iu.test(value)) continue;
      if (entropy(value) >= 3.7) {
        findings.push({ file: displayFile, line: index + 1, type: 'high-entropy-assignment' });
        break;
      }
    }
  }
  return findings;
}

function git(cwd, args, { binary = false } = {}) {
  const result = spawnSync('git', args, { cwd, encoding: binary ? null : 'utf8', maxBuffer: 128 * 1024 * 1024 });
  // Git errors may mention data from a repository. Do not echo stdout/stderr here.
  if (result.error || result.status !== 0) throw new Error('Git read failed');
  return result.stdout;
}

function textFromBuffer(buffer) {
  return buffer.includes(0) ? null : buffer.toString('utf8');
}

export function scanRepository(cwd, mode = 'working') {
  const root = git(cwd, ['rev-parse', '--show-toplevel']).trim();
  const findings = [];
  const scanBuffer = (buffer, file) => {
    const text = textFromBuffer(buffer);
    if (text !== null) findings.push(...scanText(text, file));
  };
  if (mode === 'history') {
    const commits = git(root, ['rev-list', '--all']).trim().split(/\r?\n/u).filter(Boolean);
    const cache = new Map();
    const seenPaths = new Set();
    for (const commit of commits) {
      for (const entry of git(root, ['ls-tree', '-r', '-z', commit]).split('\0').filter(Boolean)) {
        const tab = entry.indexOf('\t');
        const [permissions, type, object] = entry.slice(0, tab).split(' ');
        const file = entry.slice(tab + 1);
        if (type !== 'blob' || permissions === '120000' || seenPaths.has(`${object}\0${file}`)) continue;
        seenPaths.add(`${object}\0${file}`);
        if (!cache.has(object)) {
          const contents = textFromBuffer(git(root, ['cat-file', 'blob', object], { binary: true }));
          cache.set(object, contents === null ? [] : scanText(contents, '').map(({ line, type }) => ({ line, type })));
        }
        for (const item of cache.get(object)) findings.push({ file: safeFileName(file), ...item });
      }
    }
  } else {
    const args = mode === 'staged'
      ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']
      : ['ls-files', '--cached', '-z'];
    for (const file of git(root, args).split('\0').filter(Boolean)) {
      if (mode === 'staged') {
        scanBuffer(git(root, ['show', `:${file}`], { binary: true }), file);
      } else {
        const fullPath = path.join(root, file);
        let stat;
        try { stat = lstatSync(fullPath); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (stat.isFile()) scanBuffer(readFileSync(fullPath), file);
      }
    }
  }
  return [...new Map(findings.map(item => [`${item.file}\0${item.line}\0${item.type}`, item])).values()];
}

function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && !['--staged', '--history'].includes(args[0]))) {
    console.error('Usage: node scripts/scan-secrets.mjs [--staged|--history]');
    return 2;
  }
  const mode = args[0] === '--staged' ? 'staged' : args[0] === '--history' ? 'history' : 'working';
  try {
    const findings = scanRepository(process.cwd(), mode);
    for (const item of findings) console.log(JSON.stringify(item));
    if (findings.length) {
      console.error('Potential secrets detected. Remove or rotate credentials; matching values are intentionally hidden.');
      return 1;
    }
    console.error(`Secret scan passed (${mode}; limited patterns, not a guarantee).`);
    return 0;
  } catch {
    console.error('Secret scan could not finish. Ensure Git is available and run inside a readable Git repository.');
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
