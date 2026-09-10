// Managed role publication is serialized by the native profile lock. Every
// destination is preflighted before writing; unrelated custom roles stay intact.
import { lstatSync, readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync, linkSync, realpathSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
const [mode, destination, source] = process.argv.slice(2);
const names = ['explorer', 'worker', 'tester', 'researcher', 'reviewer'];
const marker = '# trellage-managed-codex-role-v1\n';
function stat(path) { try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
function directory(path) {
  const parent = dirname(path);
  if (parent !== path) directory(parent);
  const info = stat(path);
  // macOS exposes its system temporary roots through these OS-owned aliases.
  if (process.platform === 'darwin' && ['/var', '/tmp'].includes(path)
      && info?.isSymbolicLink() && realpathSync(path) === `/private${path}`) return;
  if (info && (!info.isDirectory() || info.isSymbolicLink())) throw Error(`unsafe agents directory: ${path}`);
}
try {
  if (!['install', 'verify'].includes(mode) || !destination || !source) throw Error('usage: codex-agents.mjs install|verify TARGET SOURCE');
  const target = resolve(destination);
  directory(target);
  directory(resolve(source));
  const entries = names.map(name => {
    const asset = join(source, `${name}.toml`);
    if (!stat(asset)?.isFile() || stat(asset).isSymbolicLink()) throw Error(`unsafe role asset: ${asset}`);
    const expected = marker + readFileSync(asset, 'utf8');
    const path = join(target, `${name}.toml`);
    const info = stat(path);
    if (info && (!info.isFile() || info.isSymbolicLink())) throw Error(`unsafe managed role: ${path}`);
    const previous = info ? readFileSync(path, 'utf8') : null;
    if (previous !== null && !previous.startsWith(marker)) throw Error(`unmanaged role name collision: ${path}`);
    if (mode === 'verify' && previous !== expected) throw Error(`managed role missing or outdated: ${path}`);
    return {path, expected, previous};
  });
  if (mode === 'install') {
    mkdirSync(target, { recursive: true, mode: 0o700 });
    for (const {path, expected, previous} of entries) {
      if (previous === expected) continue;
      const temporary = join(target, `.role-${randomUUID()}`);
      try {
        writeFileSync(temporary, expected, { mode: 0o600, flag: 'wx' });
        directory(target);
        const info = stat(path);
        if (previous === null) {
          // link is exclusive: never overwrite a role created concurrently.
          linkSync(temporary, path);
        } else {
          if (!info?.isFile() || info.isSymbolicLink() || readFileSync(path, 'utf8') !== previous) throw Error(`role changed during publication: ${path}`);
          renameSync(temporary, path);
        }
      } finally { if (stat(temporary)) unlinkSync(temporary); }
    }
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
