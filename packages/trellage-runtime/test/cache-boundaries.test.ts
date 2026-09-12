import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { bunArguments, bunExecutable, sourceWorkspaceRoot } from "../src/index.ts";

const roots: string[] = [];
// Bun skips its disk cache for small source files.
const largeModule = `${Array.from(
  { length: 4096 },
  (_, index) => `export const value${index}: number = ${index};`,
).join("\n")}\nprocess.env.CACHE_PROBE = "loaded";\n`;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "trellage-cache-boundary-")));
  roots.push(root);
  const home = path.join(root, "home");
  const cwd = path.join(root, "caller");
  mkdirSync(home);
  mkdirSync(cwd);
  const write = (relative: string, contents: string) => {
    const destination = path.join(root, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, contents);
    return destination;
  };
  const copy = (relative: string) =>
    write(relative, readFileSync(path.join(sourceWorkspaceRoot(), relative), "utf8"));
  const isolatedEnv = {
    HOME: home,
    PATH: `${path.dirname(bunExecutable())}:/usr/bin:/bin`,
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(home, "runtime-cache"),
    TRELLAGE_BUN_EXECUTABLE: bunExecutable(),
  };
  write("package.json", '{"name":"cache-fixture","type":"module"}');
  return { root, home, cwd, write, copy, isolatedEnv };
}

test.each(["trx", "trx.ts", "trellage", "trellage.ts"])(
  "initial bin/%s disables the transpiler cache before importing large source",
  (entry) => {
    const f = fixture();
    const name = path.basename(entry, ".ts");
    for (const relative of [
      `bin/${name}`,
      `bin/${name}.ts`,
      "bin/source-workspace.ts",
      "scripts/bun-runtime.sh",
      "packages/trellage-runtime/bunfig.toml",
      "packages/trellage-runtime/src/index.ts",
      "packages/trellage-runtime/src/workspace.ts",
    ]) {
      f.copy(relative);
    }
    const ts = `bin/${name}.ts`;
    f.write(
      ts,
      readFileSync(path.join(f.root, ts), "utf8").replace("\n", '\nimport "./cache-probe.ts";\n'),
    );
    f.write("bin/cache-probe.ts", largeModule);
    const shell =
      name === "trx" ? "prototypes/trellage-router/bin/trx" : "prototypes/trellage/trellage";
    chmodSync(
      f.write(
        shell,
        '#!/bin/sh\nprintf "%s\\n" "$BUN_RUNTIME_TRANSPILER_CACHE_PATH" "$CACHE_PROBE"\n',
      ),
      0o755,
    );
    const entrypoint = path.join(f.root, "bin", entry);
    chmodSync(entrypoint, 0o755);
    const result = spawnSync(entrypoint, [], {
      cwd: f.cwd,
      encoding: "utf8",
      env: { ...process.env, ...f.isolatedEnv },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("0\nloaded\n");
    expect(readdirSync(f.home, { recursive: true })).toEqual([]);
  },
);

test("shell bridge disables the cache even when the supplied child environment enables it", () => {
  const f = fixture();
  const child = f.write(
    "child.ts",
    `${largeModule}console.log(process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH, process.env.CACHE_PROBE);`,
  );
  const bridge = f.write(
    "bridge.ts",
    `import {runShellBridge} from ${JSON.stringify(path.join(sourceWorkspaceRoot(), "packages/trellage-runtime/src/index.ts"))};
runShellBridge(${JSON.stringify(bunExecutable())}, ${JSON.stringify(bunArguments(child))}, ${JSON.stringify(f.isolatedEnv)});`,
  );
  const result = spawnSync(bunExecutable(), bunArguments(bridge), {
    cwd: f.cwd,
    encoding: "utf8",
    env: { ...process.env, ...f.isolatedEnv, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe("0 loaded\n");
  expect(readdirSync(f.home, { recursive: true })).toEqual([]);
});

test("non-Bun executable validation cannot write a transpiler cache into the controller HOME", () => {
  const node = Bun.which("node");
  if (node === null) throw new Error("Node is required for the controller contract");
  const f = fixture();
  const module = f.copy("packages/trellage-runtime/src/index.ts");
  f.copy("packages/trellage-runtime/bunfig.toml");
  f.write(
    "packages/trellage-runtime/src/bun-version.ts",
    largeModule +
      readFileSync(
        path.join(sourceWorkspaceRoot(), "packages/trellage-runtime/src/bun-version.ts"),
        "utf8",
      ),
  );
  const result = spawnSync(
    node,
    [
      "--no-warnings",
      "--eval",
      `import(${JSON.stringify(module)}).then(({bunExecutable})=>console.log(bunExecutable()))`,
    ],
    { cwd: f.cwd, encoding: "utf8", env: { ...process.env, ...f.isolatedEnv } },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe(bunExecutable());
  expect(readdirSync(f.home, { recursive: true })).toEqual([]);
});

test.each([
  ["agency", "--install"],
  ["copilot", "--install"],
  ["claude", "--install"],
  ["grok", "--install"],
  ["jcode", "--install-manual"],
  ["omp", "--install"],
  ["picx", "--install"],
  ["prime", "--install"],
])(
  "native %s installer disables the cache for its explicit Bun helper invocation",
  (name, installFlag) => {
    const f = fixture();
    const prototype = `prototypes/trellage-${name}-profiles`;
    const installer = readFileSync(
      path.join(sourceWorkspaceRoot(), prototype, "install.sh"),
      "utf8",
    );
    const command = installer.match(
      /^(?:BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 )?bun --no-install[^\n]*\\\n[^\n]+/m,
    )?.[0];
    if (command === undefined)
      throw new Error(`Cannot locate the native helper invocation in ${prototype}`);
    f.copy("packages/trellage-runtime/bunfig.toml");
    f.write(
      "prototypes/trellage-claude-common/native-skills.ts",
      `${largeModule}console.log(JSON.stringify({cache:process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH,probe:process.env.CACHE_PROBE,args:process.argv.slice(2)}));`,
    );
    const source = path.join(f.root, prototype);
    const destination = path.join(f.root, "native-install");
    mkdirSync(source);
    const script = f.write(
      "invoke-installer-helper.sh",
      `#!/bin/bash\nset -euo pipefail\nsource_dir="$PROTOTYPE_SOURCE_DIR"\ninstall_root="$NATIVE_INSTALL_ROOT"\n${command}\n`,
    );
    const result = spawnSync("/bin/bash", [script], {
      cwd: f.cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        ...f.isolatedEnv,
        PROTOTYPE_SOURCE_DIR: source,
        NATIVE_INSTALL_ROOT: destination,
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      cache: "0",
      probe: "loaded",
      args: [installFlag, destination],
    });
    expect(readdirSync(f.home, { recursive: true })).toEqual([]);
  },
);

test.each([undefined, "", "test", "development", "production"])(
  "launcher startup selects production before imports without changing ambient NODE_ENV=%j",
  (nodeEnv) => {
    const f = fixture();
    f.copy("scripts/bun-runtime.sh");
    f.copy("packages/trellage-runtime/bunfig.toml");
    f.write("observed.ts", "export const observed = process.env.NODE_ENV;\n");
    f.write(
      "gui.ts",
      'import {observed} from "./observed.ts"; console.log(JSON.stringify({observed,current:process.env.NODE_ENV,cache:process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH,args:process.argv.slice(2)}));',
    );
    const script = f.write(
      "launch.sh",
      `#!/bin/bash
set -euo pipefail
. "$FIXTURE_ROOT/scripts/bun-runtime.sh"
trellage_bun_runtime "$FIXTURE_ROOT"
printf "parent-before:%s\\n" "\${NODE_ENV-unset}"
"\${trellage_launcher[@]}" "$FIXTURE_ROOT/gui.ts" -- "$@"
printf "parent-after:%s\\n" "\${NODE_ENV-unset}"
`,
    );
    const args = ["spaces here", "", "line\nbreak"];
    const env: NodeJS.ProcessEnv = { ...process.env, ...f.isolatedEnv, FIXTURE_ROOT: f.root };
    if (nodeEnv === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = nodeEnv;
    const result = spawnSync("/bin/bash", [script, ...args], {
      cwd: f.cwd,
      encoding: "utf8",
      env,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.split("\n")).toEqual([
      `parent-before:${nodeEnv ?? "unset"}`,
      JSON.stringify({ observed: "production", current: "production", cache: "0", args }),
      `parent-after:${nodeEnv ?? "unset"}`,
      "",
    ]);
    expect(readdirSync(f.home, { recursive: true })).toEqual([]);
  },
);

test("runtime library imports and argument resolution preserve the test runner environment", () => {
  const f = fixture();
  const module = path.join(sourceWorkspaceRoot(), "packages/trellage-runtime/src/index.ts");
  const script = f.write(
    "import-runtime.ts",
    `const before = process.env.NODE_ENV;
const runtime = await import(${JSON.stringify(module)});
runtime.bunExecutable();
runtime.bunArguments(import.meta.filename);
console.log(JSON.stringify({before,after:process.env.NODE_ENV}));`,
  );
  const result = spawnSync(bunExecutable(), bunArguments(script), {
    cwd: f.cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      ...f.isolatedEnv,
      NODE_ENV: "test",
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ before: "test", after: "test" });
});

test("Sandbox clean compiler environment retains disabled caching without forwarding ambient values", () => {
  const f = fixture();
  const sandbox = readFileSync(
    path.join(sourceWorkspaceRoot(), "prototypes/trellage/trellage"),
    "utf8",
  );
  const initializer = sandbox.match(/^clean_child_environment=\(.*\)$/m)?.[0];
  if (initializer === undefined)
    throw new Error("Cannot locate the Sandbox clean environment boundary");
  f.copy("scripts/bun-runtime.sh");
  f.copy("packages/trellage-runtime/bunfig.toml");
  f.write(
    "compiler.ts",
    `${largeModule}console.log(JSON.stringify({cache:process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH??null,ambient:process.env.UNEXPECTED_ENV??null,nodeEnv:process.env.NODE_ENV??null}));`,
  );
  const script = f.write(
    "compiler.sh",
    `#!/bin/bash
set -euo pipefail
. "$FIXTURE_ROOT/scripts/bun-runtime.sh"
trellage_bun_runtime "$FIXTURE_ROOT"
${initializer}
"\${clean_child_environment[@]}" "HOME=$HOME" "XDG_CACHE_HOME=$HOME/.cache" "\${trellage_bun[@]}" "$FIXTURE_ROOT/compiler.ts"
`,
  );
  const result = spawnSync("/bin/bash", [script], {
    cwd: f.cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      ...f.isolatedEnv,
      FIXTURE_ROOT: f.root,
      UNEXPECTED_ENV: "not-forwarded",
      NODE_ENV: "test",
    },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ cache: "0", ambient: null, nodeEnv: null });
  expect(readdirSync(f.home, { recursive: true })).toEqual([]);
});
