import { readFileSync, readdirSync, lstatSync, mkdirSync, mkdtempSync, copyFileSync, renameSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'extension');
const dist = path.join(root, 'dist');
const manifest = JSON.parse(readFileSync(path.join(source, 'manifest.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/u.test(manifest.version)) throw new Error('Unsafe package version');
const name = `bookmark-tidy-${manifest.version}`;
const target = path.join(dist, name);
const archive = path.join(dist, `${name}.zip`);
const checksums = path.join(dist, `${name}.sha256`);

function assertSafeOutput(output) {
  const relative = path.relative(root, output);
  if (!relative.startsWith(`dist${path.sep}`) || relative.split(path.sep).includes('..') || path.dirname(output) !== dist) {
    throw new Error('Package output leaves the verified workspace dist directory');
  }
  if (existsSync(output) && lstatSync(output).isSymbolicLink()) throw new Error('Package output must not be a symlink');
}
function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Package source must not contain symlinks');
    if (entry.isDirectory()) return sourceFiles(fullPath);
    if (!entry.isFile()) throw new Error('Unexpected package source entry');
    const relative = path.relative(source, fullPath).replaceAll(path.sep, '/');
    // Keep local backups, credentials, tests and development artifacts out of delivery.
    if (!/^(?:manifest\.json|(?:app|background)\.js|app\.html|styles\.css|core\/[a-z-]+\.js|icons\/icon-\d+\.png)$/u.test(relative)) {
      throw new Error(`Unexpected runtime file: ${relative}`);
    }
    return [{ fullPath, relative }];
  });
}
function hash(file) { return createHash('sha256').update(readFileSync(file)).digest('hex'); }

try {
  const check = spawnSync(process.execPath, [path.join(root, 'scripts', 'check.mjs')], { cwd: root, stdio: 'inherit' });
  if (check.error || check.status !== 0) throw new Error('Source check must pass before packaging');
  if (existsSync(dist) && (!lstatSync(dist).isDirectory() || lstatSync(dist).isSymbolicLink())) throw new Error('dist must be a real directory');
  mkdirSync(dist, { recursive: true });
  for (const output of [target, archive, checksums]) assertSafeOutput(output);
  const files = sourceFiles(source).sort((a, b) => a.relative.localeCompare(b.relative));
  const stage = mkdtempSync(path.join(dist, `${name}-build-`));
  assertSafeOutput(stage);
  for (const { fullPath, relative } of files) {
    const destination = path.join(stage, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(fullPath, destination);
    if (hash(fullPath) !== hash(destination)) throw new Error('Copied runtime asset does not match source');
  }
  // Rebuilds preserve previous generated outputs. There is no recursive deletion.
  const previousSuffix = `.previous-${Date.now()}`;
  for (const output of [target, archive, checksums]) {
    if (!existsSync(output)) continue;
    const previous = output + previousSuffix;
    assertSafeOutput(previous);
    if (existsSync(previous)) throw new Error('Previous output path already exists');
    renameSync(output, previous);
  }
  renameSync(stage, target);
  const result = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Compress-Archive -LiteralPath $env:BT_PACKAGE_DIR -DestinationPath $env:BT_PACKAGE_ZIP -CompressionLevel Optimal"], {
      cwd: dist, encoding: 'utf8', env: { ...process.env, BT_PACKAGE_DIR: target, BT_PACKAGE_ZIP: archive },
    })
    : spawnSync('zip', ['-q', '-r', archive, name], { cwd: dist, encoding: 'utf8' });
  if (result.error || result.status !== 0 || !existsSync(archive)) throw new Error('ZIP creation failed; use PowerShell Compress-Archive on Windows or zip CLI elsewhere');
  const lines = files.map(({ relative }) => `${hash(path.join(target, relative))}  ${name}/${relative}`);
  lines.push(`${hash(archive)}  ${name}.zip`);
  writeFileSync(checksums, lines.join('\n') + '\n', 'utf8');
  console.log(`Packaged ${files.length} runtime files: dist/${name}/, dist/${name}.zip, dist/${name}.sha256`);
} catch (error) {
  console.error(`Packaging failed: ${error.message}`);
  process.exitCode = 1;
}
