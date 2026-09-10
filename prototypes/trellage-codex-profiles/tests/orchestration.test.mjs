import { test } from 'node:test';
import { parse } from 'smol-toml';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readdirSync, writeFileSync, readFileSync, mkdirSync, realpathSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
const helper = resolve('prototypes/trellage-codex-common/codex-config.py');
function merge(text) {
  const result = spawnSync('python3', [helper], { input: text, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  parse(result.stdout);
  return result.stdout;
}
test('merges orchestration into existing nested tables without changing unrelated bytes', () => {
  const source = '# keep me\n[features.other]\nflag = false\n[features.context_management]\nexperimental_mode = false # old\ncustom = "retained"\n[agents]\nmax_concurrent_threads_per_session = 12\ncustom = "keep"\n[agents.personal]\nmodel = "custom"\n';
  const result = merge(source);
  assert.ok(result.includes('[features.other]\nflag = false\n'));
  assert.ok(result.includes('custom = "retained"\n'));
  assert.ok(result.includes('[agents.personal]\nmodel = "custom"\n'));
  assert.ok(result.includes('experimental_mode = true'));
  assert.ok(result.includes('max_concurrent_threads_per_session = 4'));
  assert.ok(result.includes('default_subagent_model = "gpt-5.6-luna"'));
  assert.equal(merge(result), result);
});
test('multiline strings cannot masquerade as table headers', () => {
  const source = 'instructions = """\n[agents]\nenabled = false\n"""\n';
  assert.ok(merge(source).startsWith(source));
});
test('rejects conflicting inline table and duplicate syntax without producing output', () => {
  for (const input of ['features = { hooks = false }\n', '[agents]\nenabled=true\nenabled=false\n']) {
    const result = spawnSync('python3', [helper], { input, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
  }
});
const rolesHelper = resolve('prototypes/trellage-codex-common/codex-agents.mjs');
const source = resolve('prototypes/trellage-codex-common/agents');
test('managed roles preserve custom agents and refuse collisions and unsafe paths', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-roles-')));
  const target = join(root, 'agents');
  const run = (mode) => spawnSync(process.execPath, [rolesHelper, mode, target, source], { encoding: 'utf8' });
  try {
    mkdirSync(target); writeFileSync(join(target, 'personal.toml'), 'custom');
    writeFileSync(join(target, 'worker.toml'), 'user-owned');
    assert.notEqual(run('install').status, 0);
    assert.equal(readFileSync(join(target, 'worker.toml'), 'utf8'), 'user-owned');
    rmSync(join(target, 'worker.toml'));
    assert.equal(run('install').status, 0);
    assert.equal(run('verify').status, 0);
    assert.equal(run('install').status, 0);
    assert.equal(readFileSync(join(target, 'personal.toml'), 'utf8'), 'custom');
    rmSync(join(target, 'worker.toml'));
    symlinkSync(join(target, 'personal.toml'), join(target, 'worker.toml'));
    assert.notEqual(run('install').status, 0);
    assert.equal(readFileSync(join(target, 'personal.toml'), 'utf8'), 'custom');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('preserves TOML comments, quote endings, escaped keys and arrays of tables', () => {
  for (const input of [
    '[features] # see [documentation]\nhooks = false\n',
    'developer_instructions = """Ends with a quote""""\n',
    '[[skills.config]]\npath = "/a/SKILL.md"\nenabled = false\n[[skills.config]]\npath = "/b/SKILL.md"\nenabled = false\n',
    '[mcp_servers."custom\\u002dserver"]\ncommand = "keep"\n',
    '[mcp_servers."quoted\\U00000022name"]\ncommand = "keep"\n',
    '[mcp_servers."literal\\\\U00000061"]\ncommand = "keep"\n',
  ]) {
    const result = merge(input);
    assert.ok(result.startsWith(input.replace('hooks = false', 'hooks = true')));
    const original = parse(input);
    const merged = parse(result);
    if (original.skills) assert.deepEqual(merged.skills, original.skills);
    if (original.mcp_servers) assert.deepEqual(merged.mcp_servers, original.mcp_servers);
    if (original.developer_instructions) assert.equal(merged.developer_instructions, original.developer_instructions);
    assert.equal(merge(result), result);
  }
});

test('failed role publication preserves prior bytes and cleans staging before retry', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-role-publish-')));
  const target = join(root, 'agents');
  const preload = join(root, 'fail.mjs');
  writeFileSync(preload, `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const operation = process.env.FAIL_ROLE_OPERATION;
const original = fs[operation];
fs[operation] = (...args) => {
  if (args[1].endsWith('/worker.toml')) throw new Error('injected role publication failure');
  return original(...args);
};
syncBuiltinESMExports();
`);
  const run = (operation) => spawnSync(process.execPath,
    [...(operation ? ['--import', preload] : []), rolesHelper, 'install', target, source],
    { encoding: 'utf8', env: { ...process.env, FAIL_ROLE_OPERATION: operation } });
  try {
    let result = run('linkSync');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /injected role publication failure/);
    assert.equal(existsSync(join(target, 'worker.toml')), false);
    assert.equal(readdirSync(target).some(name => name.startsWith('.role-')), false);
    assert.equal(run().status, 0);
    const old = '# trellage-managed-codex-role-v1\nname = "old-worker"\n';
    writeFileSync(join(target, 'worker.toml'), old);
    result = run('renameSync');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /injected role publication failure/);
    assert.equal(readFileSync(join(target, 'worker.toml'), 'utf8'), old);
    assert.equal(readdirSync(target).some(name => name.startsWith('.role-')), false);
    assert.equal(run().status, 0);
    assert.equal(parse(readFileSync(join(target, 'worker.toml'), 'utf8')).model, 'gpt-5.6-luna');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('retains unrelated CRLF bytes while merging managed tables', () => {
  const input = '[mcp_servers.custom]\r\ncommand = "keep"\r\n';
  assert.ok(merge(input).startsWith(input));
});

test('empty local config region cannot duplicate its end marker during repair', () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-empty-config-'));
  const config = join(root, 'config.toml');
  try {
    writeFileSync(config, '# trellage-profile-local-config-begin\n# trellage-profile-local-config-end\n');
    const launcher = readFileSync(resolve('prototypes/trellage-codex-common/native-codex'), 'utf8');
    const fn = launcher.slice(launcher.indexOf('append_local_config_with_hooks() {'), launcher.indexOf('validate_local_features_syntax() {'));
    const result = spawnSync('bash', ['-c', `${fn}\nappend_local_config_with_hooks "$1" 1 2`, 'test', config],
      { encoding: 'utf8', env: { ...process.env, codex_config_helper: helper } });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes('trellage-profile-local-config-end'));
    assert.equal(parse(result.stdout).agents.default_subagent_model, 'gpt-5.6-luna');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
