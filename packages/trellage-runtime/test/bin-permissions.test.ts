import { afterEach, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { bunArguments, bunExecutable, sourceWorkspaceRoot } from "../src/index.ts";
import {
  copySources,
  normalizeDependencyPermissions,
  requireReady,
  writeReadiness,
} from "../src/workspace.ts";

const fixtures: string[] = [];

afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true });
});

function fixture(relativeRoot = "source") {
  const parent = realpathSync(mkdtempSync(path.join(os.tmpdir(), "trellage-bin-permissions-")));
  fixtures.push(parent);
  const root = path.join(parent, relativeRoot);
  const home = path.join(parent, "home");
  mkdirSync(root, { recursive: true });
  mkdirSync(home);
  const write = (relative: string, contents: string, mode = 0o644) => {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents, { mode });
    return target;
  };
  for (const directory of [
    "bin",
    "packages",
    "scripts",
    "prototypes",
    "profiles",
    "profile-guides",
  ]) {
    mkdirSync(path.join(root, directory));
  }
  write(
    "package.json",
    '{"name":"permission-root","private":true,"workspaces":["packages/*"],"dependencies":{"@fixture/tool":"workspace:*"}}',
  );
  write("bunfig.toml", '[install]\nauto = "disable"\nlinker = "isolated"\n');
  write("tsconfig.base.json", '{"compilerOptions":{"noEmit":true}}');
  write("skills.json", "{}");
  const manifest = write(
    "packages/tool/package.json",
    '{"name":"@fixture/tool","version":"1.0.0","type":"module","bin":{"fixture-tool":"src/cli.ts"}}',
  );
  const binary = write(
    "packages/tool/src/cli.ts",
    '#!/usr/bin/env bun\nconsole.log("local");\n',
    0o755,
  );
  const other = write("packages/tool/src/other.ts", "export const unrelated = true;\n");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    BUN_INSTALL_CACHE_DIR: path.join(parent, "cache"),
    npm_config_registry: "https://registry.invalid",
    NPM_CONFIG_REGISTRY: "https://registry.invalid",
  };
  const install = () =>
    spawnSync(
      bunExecutable(),
      [
        "--no-env-file",
        "install",
        "--ignore-scripts",
        `--config=${path.join(root, "bunfig.toml")}`,
      ],
      { cwd: root, encoding: "utf8", env },
    );
  return { parent, root, home, binary, other, manifest, env, install, write };
}

test("real Bun local workspace bin drift is repaired before source copying and readiness", () => {
  const f = fixture();
  const original = readFileSync(f.binary);
  const inode = lstatSync(f.binary).ino;
  expect(lstatSync(f.binary).mode & 0o777).toBe(0o755);
  const result = f.install();
  expect(result.status, result.stderr).toBe(0);
  expect(lstatSync(f.binary).mode & 0o777).toBe(0o777);
  const rejected = path.join(f.parent, "rejected");
  mkdirSync(rejected);
  expect(() => copySources(f.root, rejected)).toThrow("not shared-writable");
  normalizeDependencyPermissions(f.root);
  expect(lstatSync(f.binary).mode & 0o777).toBe(0o755);
  expect(lstatSync(f.binary).ino).toBe(inode);
  expect(readFileSync(f.binary)).toEqual(original);
  writeReadiness(f.root);
  expect(() => requireReady(f.root)).not.toThrow();
  const copied = path.join(f.parent, "copied");
  mkdirSync(copied);
  expect(() => copySources(f.root, copied)).not.toThrow();
});

test("explicit prepare recovers real Bun bin drift without remote dependencies", () => {
  const f = fixture();
  expect(f.install().status).toBe(0);
  expect(lstatSync(f.binary).mode & 0o777).toBe(0o777);
  const cli = path.join(sourceWorkspaceRoot(), "packages/trellage-runtime/src/workspace-cli.ts");
  const result = spawnSync(bunExecutable(), bunArguments(cli, ["prepare", f.root]), {
    cwd: f.parent,
    encoding: "utf8",
    env: f.env,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(lstatSync(f.binary).mode & 0o777).toBe(0o755);
  expect(() => requireReady(f.root)).not.toThrow();
});

test("declared bin normalization works inside a global package source runtime", () => {
  const f = fixture("prefix/lib/node_modules/trellage/.trellage-runtime");
  expect(f.install().status).toBe(0);
  expect(lstatSync(f.binary).mode & 0o777).toBe(0o777);
  normalizeDependencyPermissions(f.root);
  expect(lstatSync(f.binary).mode & 0o777).toBe(0o755);
  writeReadiness(f.root);
  expect(() => requireReady(f.root)).not.toThrow();
});

test("normalization does not repair unrelated shared-writable source", () => {
  const f = fixture();
  expect(f.install().status).toBe(0);
  chmodSync(f.other, 0o777);
  normalizeDependencyPermissions(f.root);
  expect(lstatSync(f.binary).mode & 0o777).toBe(0o755);
  expect(lstatSync(f.other).mode & 0o777).toBe(0o777);
  expect(() => writeReadiness(f.root)).toThrow("not shared-writable");
});

test("normalization refuses a linked manifest rather than trusting an external declaration", () => {
  const f = fixture();
  expect(f.install().status).toBe(0);
  const outside = path.join(f.parent, "external-package.json");
  renameSync(f.manifest, outside);
  symlinkSync(outside, f.manifest);
  expect(() => normalizeDependencyPermissions(f.root)).toThrow();
  expect(lstatSync(f.binary).mode & 0o777).toBe(0o777);
});

test("normalization refuses a redirected bin source and leaves the outside target unchanged", () => {
  const f = fixture();
  expect(f.install().status).toBe(0);
  const outside = path.join(f.parent, "external.ts");
  renameSync(f.binary, outside);
  symlinkSync(outside, f.binary);
  expect(() => normalizeDependencyPermissions(f.root)).toThrow();
  expect(lstatSync(outside).mode & 0o777).toBe(0o777);
});

test("normalization refuses a hard-linked bin source without changing either link", () => {
  const f = fixture();
  expect(f.install().status).toBe(0);
  const outside = path.join(f.parent, "linked.ts");
  linkSync(f.binary, outside);
  expect(() => normalizeDependencyPermissions(f.root)).toThrow("hard-linked");
  expect(lstatSync(f.binary).mode & 0o777).toBe(0o777);
  expect(lstatSync(outside).mode & 0o777).toBe(0o777);
});

test("declared bin recovery does not depend on a remaining node_modules bin link", () => {
  const f = fixture();
  expect(f.install().status).toBe(0);
  expect(lstatSync(f.binary).mode & 0o777).toBe(0o777);
  const dependencies = path.join(f.root, "node_modules");
  rmSync(dependencies, { recursive: true });
  mkdirSync(dependencies);
  normalizeDependencyPermissions(f.root);
  expect(lstatSync(f.binary).mode & 0o777).toBe(0o755);
  expect(() => writeReadiness(f.root)).toThrow("missing source dependency");
});

test("normalization refuses redirected source parents before changing the target", () => {
  const f = fixture();
  expect(f.install().status).toBe(0);
  const original = path.dirname(f.binary);
  const outside = path.join(f.parent, "external-source");
  renameSync(original, outside);
  symlinkSync(outside, original);
  expect(() => normalizeDependencyPermissions(f.root)).toThrow("unsafe directory");
  expect(lstatSync(path.join(outside, "cli.ts")).mode & 0o777).toBe(0o777);
});

test("prepare rejects an unsafe manifest before Bun can link or change source permissions", () => {
  const f = fixture();
  const outside = path.join(f.parent, "external-package.json");
  renameSync(f.manifest, outside);
  symlinkSync(outside, f.manifest);
  const cli = path.join(sourceWorkspaceRoot(), "packages/trellage-runtime/src/workspace-cli.ts");
  const result = spawnSync(bunExecutable(), bunArguments(cli, ["prepare", f.root]), {
    cwd: f.parent,
    encoding: "utf8",
    env: f.env,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("unsafe file");
  expect(lstatSync(f.binary).mode & 0o777).toBe(0o755);
  expect(existsSync(path.join(f.root, "node_modules"))).toBe(false);
  expect(existsSync(path.join(f.root, "bun.lock"))).toBe(false);
});

test("normalization rejects a bin declaration outside its package", () => {
  const f = fixture();
  expect(f.install().status).toBe(0);
  const outside = path.join(f.parent, "external.ts");
  writeFileSync(outside, "external", { mode: 0o777 });
  chmodSync(outside, 0o777);
  writeFileSync(
    f.manifest,
    JSON.stringify({
      name: "@fixture/tool",
      version: "1.0.0",
      bin: { "fixture-tool": path.relative(path.dirname(f.manifest), outside) },
    }),
  );
  expect(() => normalizeDependencyPermissions(f.root)).toThrow("unsafe workspace binary target");
  expect(lstatSync(outside).mode & 0o777).toBe(0o777);
  expect(lstatSync(f.binary).mode & 0o777).toBe(0o777);
});

test("normalization does not chmod an unrelated source target exposed as a dependency command", () => {
  const f = fixture();
  expect(f.install().status).toBe(0);
  chmodSync(f.other, 0o777);
  const bin = path.join(f.root, "node_modules/.bin");
  symlinkSync(path.relative(bin, f.other), path.join(bin, "unrelated-command"));
  expect(() => normalizeDependencyPermissions(f.root)).toThrow("unpermitted workspace binary link");
  expect(lstatSync(f.other).mode & 0o777).toBe(0o777);
});

test("normalization refuses a workspace not owned by the active user", () => {
  const f = fixture();
  expect(f.install().status).toBe(0);
  if (process.getuid === undefined)
    throw new Error("POSIX ownership is required for this contract");
  const owner = spyOn(process, "getuid").mockReturnValue(process.getuid() + 1);
  try {
    expect(() => normalizeDependencyPermissions(f.root)).toThrow("owned by this user");
    expect(lstatSync(f.binary).mode & 0o777).toBe(0o777);
  } finally {
    owner.mockRestore();
  }
});
