import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const extension = path.join(root, 'extension');

function assert(value, message) { if (!value) throw new Error(message); }
function filesIn(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    assert(!entry.isSymbolicLink(), `Symlink is not allowed: ${path.relative(root, fullPath)}`);
    if (entry.isDirectory()) files.push(...filesIn(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
}
function localFile(value) {
  assert(typeof value === 'string' && !/^(?:[a-z]+:|\/\/)/iu.test(value), 'External extension asset is not allowed');
  const fullPath = path.resolve(extension, value);
  const relative = path.relative(extension, fullPath);
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Extension asset leaves its directory');
  assert(lstatSync(fullPath).isFile(), `Missing extension asset: ${value}`);
  return fullPath;
}

try {
  const sources = ['extension', 'scripts', 'tests'].flatMap(name => filesIn(path.join(root, name)));
  const jsFiles = sources.filter(file => /\.(?:js|mjs)$/u.test(file));
  for (const file of jsFiles) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert(!result.error && result.status === 0, `JavaScript syntax failed: ${path.relative(root, file)}`);
  }
  for (const file of sources.filter(file => file.endsWith('.json'))) JSON.parse(readFileSync(file, 'utf8'));
  JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(path.join(extension, 'manifest.json'), 'utf8'));
  assert(manifest.manifest_version === 3, 'Manifest must use MV3');
  assert(JSON.stringify([...(manifest.permissions || [])].sort()) === JSON.stringify(['bookmarks', 'storage']), 'Only bookmarks and storage permissions are allowed');
  assert(!manifest.host_permissions?.length, 'Required network host permissions are not allowed');
  assert(!manifest.content_scripts?.length && !manifest.externally_connectable, 'Content scripts and external message access are not allowed');
  const allowedHosts = new Set(['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*']);
  assert((manifest.optional_host_permissions || []).every(host => allowedHosts.has(host)), 'Unexpected optional network host permission');
  assert(manifest.background?.type === 'module', 'Service worker must be a module');
  localFile(manifest.background.service_worker);
  const csp = manifest.content_security_policy?.extension_pages || '';
  assert(/(?:^|;)\s*script-src\s+'self'\s*(?:;|$)/u.test(csp) && !/unsafe-inline|unsafe-eval/iu.test(csp), 'Extension scripts must use self-only CSP');
  for (const asset of [...Object.values(manifest.icons || {}), ...Object.values(manifest.action?.default_icon || {})]) {
    const icon = localFile(asset);
    assert(readFileSync(icon).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `Icon must be a PNG: ${asset}`);
  }
  assert(['16', '32', '48', '128'].every(size => typeof manifest.icons?.[size] === 'string'), 'Manifest must include 16/32/48/128 icons');
  for (const file of sources.filter(file => file.startsWith(extension + path.sep) && file.endsWith('.html'))) {
    const html = readFileSync(file, 'utf8');
    for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/giu)) {
      const src = match[1].match(/\bsrc\s*=\s*["']([^"']+)["']/iu);
      assert(src && !match[2].trim(), 'Only local external script files are allowed');
      localFile(src[1]);
    }
    assert(!/\bon\w+\s*=/iu.test(html), 'Inline event handlers are not allowed');
  }
  for (const file of jsFiles.filter(file => file.startsWith(extension + path.sep))) {
    const text = readFileSync(file, 'utf8');
    assert(!/\b(?:eval\s*\(|new\s+Function\s*\()/u.test(text), 'Dynamic executable code is not allowed');
    assert(!/\bimport(?:\s*\(|\s+[\s\S]{0,100}?\bfrom\s*)["']https?:/u.test(text), 'External module imports are not allowed');
  }
  console.log(`Source check passed: ${jsFiles.length} JavaScript files; MV3, local scripts, limited permissions and PNG assets verified.`);
} catch (error) {
  console.error(`Source check failed: ${error.message}`);
  process.exitCode = 1;
}
