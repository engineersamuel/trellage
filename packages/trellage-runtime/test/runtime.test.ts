import { afterEach, describe, expect, test } from "bun:test"
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { bunArguments, bunExecutable, sourceWorkspaceRoot } from "../src/index.ts"
import {
  requireOwnedWorkspace,
  requireReady,
  requireReadyAsync,
  sourceFingerprint,
  sourceFingerprintAsync,
  validateOwnedTree,
  validateOwnedTreeAsync,
  writeReadiness,
} from "../src/workspace.ts"
import { runtimeTreeHash, socketIsListening } from "../src/native-tools.ts"
import { packageSources } from "../src/source-package.ts"

const fixtures: string[] = []
const workspaceCli = path.join(sourceWorkspaceRoot(), "packages/trellage-runtime/src/workspace-cli.ts")

function fixture(): string {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), "trellage-source-test.")))
  fixtures.push(directory)
  return directory
}

function write(root: string, relative: string, value: string): void {
  const destination = path.join(root, relative)
  mkdirSync(path.dirname(destination), { recursive: true })
  writeFileSync(destination, value)
}

test("source archive preserves locked workspace and assets without registry workspace dependencies", () => {
  const { root } = sourceFixture()
  write(root, "README.md", "Source fixture")
  write(root, "LICENSE", "MIT")
  write(root, ".agents/rules.md", "canonical rules")
  write(root, "packages/application/dist/ignored.js", "generated")
  expect(run("prepare", root).status).toBe(0)
  const fingerprint = sourceFingerprint(root)
  write(root, "scripts/__pycache__/helper.cpython-314.pyc", "generated Python bytecode")
  expect(sourceFingerprint(root)).toBe(fingerprint)
  expect(() => requireReady(root)).not.toThrow()
  const destination = path.join(fixture(), "source.tgz")
  const manifest = readFileSync(path.join(root, "package.json"), "utf8")
  packageSources(root, destination)
  expect(() => packageSources(root, destination)).toThrow()
  const extracted = fixture()
  const unpack = spawnSync("tar", ["-xzf", destination, "-C", extracted])
  expect(unpack.status).toBe(0)
  const packaged = path.join(extracted, "package")
  expect(readFileSync(path.join(packaged, "package.source.json"), "utf8")).toBe(manifest)
  const published = JSON.parse(readFileSync(path.join(packaged, "package.json"), "utf8"))
  expect(published.dependencies).toBeUndefined()
  expect(published.workspaces).toBeUndefined()
  expect(published.scripts.postinstall).toBe("bash scripts/install-source-runtime.sh --package")
  expect(readFileSync(path.join(packaged, ".agents/rules.md"), "utf8")).toBe("canonical rules")
  expect(existsSync(path.join(packaged, "packages/application/dist"))).toBe(false)
  expect(existsSync(path.join(packaged, "scripts/__pycache__"))).toBe(false)
  expect(sourceFingerprint(packaged)).toBe(sourceFingerprint(root))
})

function hostileBunEnvironment(cwd: string): NodeJS.ProcessEnv {
  const preload = path.join(cwd, "must-not-load.ts")
  const configuration = `preload = [${JSON.stringify(preload)}]\n`
  write(cwd, ".env", "SOURCE_TEST_ENV=wrong\n")
  writeFileSync(preload, 'throw new Error("foreign preload");')
  for (const relative of ["bunfig.toml", "home/.bunfig.toml", "config/.bunfig.toml", "config/bunfig.toml"]) {
    write(cwd, relative, configuration)
  }
  return {
    ...process.env,
    HOME: path.join(cwd, "home"),
    XDG_CONFIG_HOME: path.join(cwd, "config"),
    SOURCE_TEST_ENV: undefined,
  }
}

function run(action: string, root: string, destination?: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(
    bunExecutable(),
    bunArguments(workspaceCli, [action, root, ...(destination === undefined ? [] : [destination])]),
    { encoding: "utf8", env: { ...process.env, ...env } },
  )
}

function sourceFixture(withShellRunner = false) {
  const parent = fixture()
  const root = path.join(parent, "source")
  const home = path.join(parent, "home")
  mkdirSync(home)
  mkdirSync(root)
  for (const directory of ["bin", "packages", "prototypes", "scripts", "profile-guides", "profiles"]) {
    mkdirSync(path.join(root, directory))
  }
  write(
    root,
    "package.json",
    JSON.stringify({
      name: "source-fixture",
      version: "1.0.0",
      private: true,
      workspaces: ["packages/*"],
    }),
  )
  write(root, "bunfig.toml", '[install]\nauto = "disable"\nlinker = "isolated"\n')
  write(root, "tsconfig.base.json", '{"compilerOptions":{"strict":true,"noEmit":true}}')
  write(root, "skills.json", "{}")
  write(
    root,
    "packages/library/package.json",
    JSON.stringify({
      name: "@fixture/library",
      version: "1.0.0",
      type: "module",
      exports: "./src/index.ts",
    }),
  )
  write(root, "packages/library/src/index.ts", 'export const value: string = "source";')
  write(
    root,
    "packages/application/package.json",
    JSON.stringify({
      name: "@fixture/application",
      version: "1.0.0",
      type: "module",
      bin: { "fixture-tool": "src/cli.ts" },
      dependencies: { "@fixture/library": "workspace:*" },
    }),
  )
  write(
    root,
    "packages/application/src/cli.ts",
    [
      "#!/usr/bin/env bun",
      'import {value} from "@fixture/library";',
      "console.log(JSON.stringify({value,cwd:process.cwd(),args:process.argv.slice(2),env:process.env.SOURCE_TEST_ENV ?? null}));",
    ].join("\n"),
  )
  if (withShellRunner) {
    write(root, "packages/trellage-runtime/package.json", '{"name":"@fixture/runtime","version":"1.0.0"}')
    for (const relative of [
      "scripts/run-source.sh",
      "scripts/bun-runtime.sh",
      "packages/trellage-runtime/bunfig.toml",
      "packages/trellage-runtime/src",
    ]) {
      cpSync(path.join(sourceWorkspaceRoot(), relative), path.join(root, relative), { recursive: true })
    }
  }
  const locked = spawnSync(
    bunExecutable(),
    ["--no-env-file", "install", "--lockfile-only", "--ignore-scripts", `--config=${path.join(root, "bunfig.toml")}`],
    { cwd: root, encoding: "utf8", env: { ...process.env, HOME: home } },
  )
  expect(locked.status, locked.stderr).toBe(0)
  return { root, home, parent, destination: path.join(parent, "installed") }
}

afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true })
})

test.each([undefined, "after-staging"])("contains default installer caches without changing HOME (%s)", (failure) => {
  const { root, home, parent, destination } = sourceFixture()
  const before = readdirSync(home)
  const probe = path.join(parent, "cache-paths")
  const fakeBin = path.join(parent, "fake-bin")
  write(parent, "fake-bin/npm", [
    "#!/bin/sh",
    "set -eu",
    'test "$*" = "config get registry --workspaces=false"',
    'printf "%s\\n" "$BUN_INSTALL_CACHE_DIR" "$npm_config_cache" > "$CACHE_PROBE"',
    'mkdir -p "$BUN_INSTALL_CACHE_DIR" "$npm_config_cache"',
    'printf "%s\\n" "https://registry.npmjs.org/"',
  ].join("\n"))
  chmodSync(path.join(fakeBin, "npm"), 0o755)
  const result = run("install", root, destination, {
    HOME: home,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
    CACHE_PROBE: probe,
    BUN_INSTALL_CACHE_DIR: undefined,
    npm_config_cache: undefined,
    NPM_CONFIG_CACHE: undefined,
    npm_config_registry: undefined,
    NPM_CONFIG_REGISTRY: undefined,
    TRELLAGE_SOURCE_INSTALL_TEST_FAIL_AT: failure,
  })
  expect(result.status, result.stderr).toBe(failure === undefined ? 0 : 1)
  expect(result.stdout).toBe("")
  expect(result.stderr).toContain("bun install v")
  if (failure !== undefined) expect(result.stderr).toContain(`injected failure ${failure}`)
  const cachePaths = readFileSync(probe, "utf8").trim().split("\n")
  expect(cachePaths).toHaveLength(2)
  for (const cache of cachePaths) {
    expect(path.basename(path.dirname(cache))).toStartWith(".trellage-package-cache.")
    expect(existsSync(cache)).toBe(false)
  }
  expect(readdirSync(home)).toEqual(before)
})

test("parallel directory inventory preserves validation and rejects escaping links", async () => {
  const { root } = sourceFixture()
  const prepared = run("prepare", root)
  expect(prepared.status, prepared.stderr).toBe(0)
  expect(await validateOwnedTreeAsync(root, true)).toBe(validateOwnedTree(root, true))
  await requireReadyAsync(root)
  write(root, "packages/library/src/index.ts", 'export const value = "changed";')
  await expect(requireReadyAsync(root)).rejects.toThrow("stale")
  symlinkSync(fixture(), path.join(root, "node_modules", "escaping"))
  await expect(validateOwnedTreeAsync(root, true)).rejects.toThrow("link")
})

describe("Bun invocation", () => {
  test("uses the validated Bun process and an absolute owned configuration", () => {
    expect(bunExecutable()).toBe(realpathSync(process.execPath))
    const script = new URL("../src/index.ts", import.meta.url)
    const args = ["--", "spaces and\nnewlines", ""]
    const result = bunArguments(script, args)
    expect(result[0]).toBe("--no-install")
    expect(result[1]).toBe("--no-env-file")
    expect(result[2]).toBe(`--config=${path.join(sourceWorkspaceRoot(), "packages/trellage-runtime/bunfig.toml")}`)
    expect(result[4]).toBe("--")
    expect(result.slice(5)).toEqual(args)
    expect(() => bunArguments("relative.ts")).toThrow("must be absolute")
  })

  test("does not read caller environment files or cwd and user Bun preloads", () => {
    const cwd = fixture()
    const env = hostileBunEnvironment(cwd)
    const script = path.join(cwd, "main.ts")
    writeFileSync(script, "console.log(process.env.SOURCE_TEST_ENV ?? 'clean')")
    const child = spawnSync(bunExecutable(), bunArguments(script), { cwd, encoding: "utf8", env })
    expect(child.status, child.stderr).toBe(0)
    expect(child.stdout.trim()).toBe("clean")
  })

  test("retains shell exit status and arguments through a thin bridge", () => {
    const cwd = fixture()
    const command = path.join(cwd, "command.sh")
    writeFileSync(command, '#!/usr/bin/env bash\nprintf "%s\\n" "$PWD" "$@"\nexit 37\n')
    chmodSync(command, 0o755)
    const bridge = path.join(cwd, "bridge.ts")
    writeFileSync(
      bridge,
      `import {runShellBridge} from ${JSON.stringify(path.join(sourceWorkspaceRoot(), "packages/trellage-runtime/src/index.ts"))}; runShellBridge(${JSON.stringify(command)},process.argv.slice(2),process.env);`,
    )
    const child = spawnSync(bunExecutable(), bunArguments(bridge, ["spaces here", "--flag", ""]), {
      cwd,
      encoding: "utf8",
    })
    expect(child.status).toBe(37)
    expect(child.stdout).toBe(`${cwd}\nspaces here\n--flag\n\n`)
  })

  test("retains the terminating shell signal", () => {
    const cwd = fixture()
    const command = path.join(cwd, "command.sh")
    writeFileSync(command, '#!/usr/bin/env bash\nkill -TERM "$$"\n')
    chmodSync(command, 0o755)
    const bridge = path.join(cwd, "bridge.ts")
    writeFileSync(
      bridge,
      `import {runShellBridge} from ${JSON.stringify(path.join(sourceWorkspaceRoot(), "packages/trellage-runtime/src/index.ts"))}; runShellBridge(${JSON.stringify(command)},[],process.env);`,
    )
    const child = spawnSync(bunExecutable(), bunArguments(bridge), { cwd, encoding: "utf8" })
    expect(child.status).toBeNull()
    expect(child.signal).toBe("SIGTERM")
  })

  test("requires an explicit Bun executable when controlled by Node", () => {
    const node = Bun.which("node")
    expect(node).not.toBeNull()
    if (node === null) throw new Error("Node is required for the controller contract")
    const module = path.join(sourceWorkspaceRoot(), "packages/trellage-runtime/src/index.ts")
    const script = `import(${JSON.stringify(module)}).then(({bunExecutable})=>{try {console.log(bunExecutable())} catch(error) {console.error(error.message);process.exitCode=1}})`
    const rejected = spawnSync(node, ["--no-warnings", "--eval", script], {
      encoding: "utf8",
      env: { ...process.env, TRELLAGE_BUN_EXECUTABLE: undefined },
    })
    expect(rejected.status).toBe(1)
    expect(rejected.stderr).toContain("set TRELLAGE_BUN_EXECUTABLE")
    const accepted = spawnSync(node, ["--no-warnings", "--eval", script], {
      encoding: "utf8",
      env: { ...process.env, TRELLAGE_BUN_EXECUTABLE: bunExecutable() },
    })
    expect(accepted.status, accepted.stderr).toBe(0)
    expect(accepted.stdout.trim()).toBe(bunExecutable())
    const wrong = spawnSync(node, ["--no-warnings", "--eval", script], {
      encoding: "utf8",
      env: { ...process.env, TRELLAGE_BUN_EXECUTABLE: node },
    })
    expect(wrong.status).toBe(1)
    expect(wrong.stderr).toContain("is not Bun 1.3.3")
  })

  test.each(["trx", "trellage"])("preserves every public %s argument from a symlink and foreign cwd", (name) => {
    const root = fixture()
    const cwd = path.join(root, "foreign")
    mkdirSync(cwd)
    for (const relative of [
      `bin/${name}`,
      `bin/${name}.ts`,
      "bin/source-workspace.ts",
      "scripts/bun-runtime.sh",
      "packages/trellage-runtime/bunfig.toml",
      "packages/trellage-runtime/src/index.ts",
      "packages/trellage-runtime/src/workspace.ts",
    ]) {
      mkdirSync(path.dirname(path.join(root, relative)), { recursive: true })
      cpSync(path.join(sourceWorkspaceRoot(), relative), path.join(root, relative))
    }
    const entrypoint = path.join(root, "bin", name)
    write(root, "package.json", '{"name":"bridge-fixture"}')
    chmodSync(entrypoint, 0o755)
    const shell = name === "trx" ? "prototypes/trellage-router/bin/trx" : "prototypes/trellage/trellage"
    write(root, shell, '#!/usr/bin/env bash\nprintf "%s\\0" "$PWD" "${SOURCE_TEST_ENV-clean}" "$@"\nexit 37\n')
    chmodSync(path.join(root, shell), 0o755)
    const env = hostileBunEnvironment(cwd)
    const command = path.join(root, "public-command")
    symlinkSync(entrypoint, command)
    const args = ["--", "a b", "", "line\nbreak"]
    const child = spawnSync(command, args, { cwd, encoding: "utf8", env })
    expect(child.status, child.stderr).toBe(37)
    expect(child.stdout).toBe([cwd, "clean", ...args, ""].join("\0"))
  })
})

describe("Owned source installation", () => {
  test.each([
    ["trellage-agency-profiles", "agx"],
    ["trellage-copilot-profiles", "cpx"],
    ["trellage-omp-profiles", "omp"],
    ["trellage-picx-profiles", "picx"],
    ["trellage-prime-profiles", "prx"],
  ])("does not publish %s when source dependency preparation fails", (prototype, command) => {
    const root = fixture()
    const home = path.join(root, "home")
    mkdirSync(home)
    const installer = path.join(root, "prototypes", prototype, "install.sh")
    mkdirSync(path.dirname(installer), { recursive: true })
    cpSync(path.join(sourceWorkspaceRoot(), "prototypes", prototype, "install.sh"), installer)
    write(root, "prototypes/trellage/copilot-model-settings.py", "fixture")
    write(root, "scripts/trellage-session-bridge.py", "fixture")
    write(root, "scripts/trellage-statusline.sh", "fixture")
    write(root, `prototypes/${prototype}/assets/extensions/ask-user.ts`, "fixture")
    const preparation = path.join(root, "scripts/install-floating-skills-runtime.sh")
    writeFileSync(preparation, '#!/usr/bin/env bash\nprintf "fixture dependency failure\\n" >&2\nexit 37\n')
    chmodSync(preparation, 0o755)
    const child = spawnSync("bash", [installer], { encoding: "utf8", env: { ...process.env, HOME: home } })
    expect(child.status, child.stderr).toBe(37)
    expect(child.stderr).toContain("fixture dependency failure")
    expect(child.stdout).not.toContain("Installed")
    expect(existsSync(path.join(home, ".local/share/trellage", command))).toBe(false)
    expect(existsSync(path.join(home, ".local/bin", command))).toBe(false)
  })

  test("restores the locked workspace manifest only inside an explicit source installation", () => {
    const { root, destination, home } = sourceFixture()
    const workspaceManifest = JSON.stringify({
      ...JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")),
      scripts: { postinstall: "exit 99" },
    })
    write(root, "package.source.json", workspaceManifest)
    write(
      root,
      "package.json",
      JSON.stringify({
        name: "source-fixture",
        version: "1.0.0",
        type: "module",
        trellageSourceManifest: "package.source.json",
        scripts: { postinstall: "exit 99" },
      }),
    )
    const publishedManifest = readFileSync(path.join(root, "package.json"), "utf8")
    const installed = run("install", root, destination, { HOME: home })
    expect(installed.status, installed.stderr).toBe(0)
    expect(readFileSync(path.join(destination, "package.json"), "utf8")).toBe(workspaceManifest)
    expect(readFileSync(path.join(root, "package.json"), "utf8")).toBe(publishedManifest)
    expect(existsSync(path.join(destination, "package.source.json"))).toBe(false)
    expect(() => requireOwnedWorkspace(destination)).not.toThrow()
  })

  test("refuses a redirected public source manifest", () => {
    const { root, destination, home } = sourceFixture()
    write(
      root,
      "package.json",
      JSON.stringify({
        name: "source-fixture",
        trellageSourceManifest: "../package.json",
      }),
    )
    const failed = run("install", root, destination, { HOME: home })
    expect(failed.status).toBe(1)
    expect(failed.stderr).toContain("unpermitted source distribution manifest")
    expect(existsSync(destination)).toBe(false)
  })

  test("installs a frozen source workspace and preserves shell runner arguments from another cwd without dist", () => {
    const { root, destination, home, parent } = sourceFixture(true)
    write(root, "packages/application/dist/cli.js", 'throw new Error("must not use emitted output")')
    const installed = run("install", root, destination, { HOME: home })
    expect(installed.status, installed.stderr).toBe(0)
    expect(() => requireOwnedWorkspace(destination)).not.toThrow()
    expect(existsSync(path.join(destination, "packages/application/dist"))).toBe(false)
    expect(readFileSync(path.join(destination, "bun.lock"), "utf8")).toBe(
      readFileSync(path.join(root, "bun.lock"), "utf8"),
    )
    const cwd = path.join(parent, "foreign")
    mkdirSync(cwd)
    const env = { ...hostileBunEnvironment(cwd), TRELLAGE_BUN_EXECUTABLE: bunExecutable() }
    for (const args of [[], ["command", "--", "--literal"], ["--", "a b", "", "line\nbreak"]]) {
      const child = spawnSync(
        "/bin/bash",
        [
          path.join(destination, "scripts/run-source.sh"),
          path.join(destination, "packages/application/src/cli.ts"),
          ...args,
        ],
        { cwd, encoding: "utf8", env },
      )
      expect(child.status, child.stderr).toBe(0)
      expect(JSON.parse(child.stdout)).toEqual({ value: "source", cwd, args, env: null })
    }
  })

  test("rejects stale source and missing dependencies without an implicit install", () => {
    const { root, destination, home } = sourceFixture()
    expect(run("install", root, destination, { HOME: home }).status).toBe(0)
    const entrypoint = path.join(destination, "packages/library/src/index.ts")
    writeFileSync(entrypoint, 'export const value = "changed";')
    expect(() => requireReady(destination)).toThrow("stale")
    cpSync(path.join(root, "packages/library/src/index.ts"), entrypoint)
    const dependency = path.join(destination, "packages/application/node_modules/@fixture/library")
    unlinkSync(dependency)
    expect(() => requireReady(destination)).toThrow("missing source dependency")
    expect(existsSync(dependency)).toBe(false)
  })

  test("batched fingerprints preserve the byte hash and reject unsafe source entries", async () => {
    const { root, home, parent } = sourceFixture()
    for (let index = 0; index < 37; index += 1) {
      write(root, `packages/application/src/input-${index}.ts`, `export const value = "${"x".repeat(index * 137)}";`)
    }
    const expected = sourceFingerprint(root)
    expect(await sourceFingerprintAsync(root)).toBe(expected)
    const result = run("fingerprint", root, undefined, { HOME: home })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe(`${expected}\n`)

    const input = path.join(root, "packages/application/src/input-1.ts")
    utimesSync(input, 1000000000, 1000000000)
    const contents = readFileSync(input, "utf8")
    writeFileSync(input, contents.replace("x", "y"))
    utimesSync(input, 1000000000, 1000000000)
    const changed = await sourceFingerprintAsync(root)
    expect(changed).not.toBe(expected)
    expect(changed).toBe(sourceFingerprint(root))

    const external = path.join(parent, "external.ts")
    writeFileSync(external, contents)
    unlinkSync(input)
    symlinkSync(external, input)
    await expect(sourceFingerprintAsync(root)).rejects.toThrow("source workspace contains a symlink")
  })

  test("batched fingerprints use the original locked source manifest in public distributions", async () => {
    const { root } = sourceFixture()
    const expected = sourceFingerprint(root)
    cpSync(path.join(root, "package.json"), path.join(root, "package.source.json"))
    write(root, "package.json", '{"name":"source-fixture","trellageSourceManifest":"package.source.json"}')
    expect(await sourceFingerprintAsync(root)).toBe(expected)
  })

  test.each(["after-staging", "during-publication", "after-publication"])(
    "rolls back publication failure at %s",
    (point) => {
      const { root, destination, home } = sourceFixture()
      expect(run("install", root, destination, { HOME: home }).status).toBe(0)
      const before = sourceFingerprint(destination)
      write(root, "packages/library/src/index.ts", 'export const value: string = "next";')
      const failed = run("install", root, destination, { HOME: home, TRELLAGE_SOURCE_INSTALL_TEST_FAIL_AT: point })
      expect(failed.status).toBe(1)
      expect(failed.stderr).toContain(`injected failure ${point}`)
      expect(sourceFingerprint(destination)).toBe(before)
      expect(() => requireOwnedWorkspace(destination)).not.toThrow()
      expect(existsSync(`${destination}.lock`)).toBe(false)
    },
  )

  test.each(["after-staging", "during-publication", "after-publication"])("rolls back termination at %s", (point) => {
    const { root, destination, home } = sourceFixture()
    expect(run("install", root, destination, { HOME: home }).status).toBe(0)
    const before = sourceFingerprint(destination)
    write(root, "packages/library/src/index.ts", 'export const value: string = "next";')
    const failed = run("install", root, destination, {
      HOME: home,
      TRELLAGE_SOURCE_INSTALL_TEST_FAIL_AT: `signal-${point}`,
    })
    expect(failed.status, failed.stderr).toBe(143)
    expect(failed.stderr).toContain("cancelled by SIGTERM")
    expect(sourceFingerprint(destination)).toBe(before)
    expect(() => requireOwnedWorkspace(destination)).not.toThrow()
    expect(existsSync(`${destination}.lock`)).toBe(false)
  })

  test("checks dependency content, not just file sizes and package manifests", () => {
    const { root, destination, home } = sourceFixture()
    expect(run("install", root, destination, { HOME: home }).status).toBe(0)
    const artifact = path.join(destination, "node_modules", "artifact")
    writeFileSync(artifact, "original")
    utimesSync(artifact, 1000000000, 1000000000)
    writeReadiness(destination)
    writeFileSync(artifact, "modified")
    utimesSync(artifact, 1000000000, 1000000000)
    expect(() => requireReady(destination)).toThrow("changed or unrelated")
    unlinkSync(artifact)
    expect(() => requireReady(destination)).toThrow("changed or unrelated")
  })

  test("prepares development sources without reading unrelated checkout paths", () => {
    const { root, home, parent } = sourceFixture()
    symlinkSync(parent, path.join(root, ".git"))
    write(root, "prototypes/example/tests/ignored.ts", "unrelated test")
    const prepared = run("prepare", root, undefined, { HOME: home })
    expect(prepared.status, prepared.stderr).toBe(0)
    expect(() => requireReady(root)).not.toThrow()
    write(root, "prototypes/example/tests/ignored.ts", "changed test")
    expect(() => requireReady(root)).not.toThrow()
  })

  test("copies declared hidden source assets but not local environment values", () => {
    const { root, destination, home } = sourceFixture()
    write(root, ".agents/rules.md", "source rules")
    write(root, "profiles/test/profile.toml", 'name = "test"\n')
    write(root, "prototypes/example/.env.schema", "EXAMPLE=\n")
    write(root, "prototypes/example/.env.local", "EXAMPLE=local-fixture\n")
    expect(run("install", root, destination, { HOME: home }).status).toBe(0)
    expect(readFileSync(path.join(destination, ".agents/rules.md"), "utf8")).toBe("source rules")
    expect(readFileSync(path.join(destination, "profiles/test/profile.toml"), "utf8")).toBe('name = "test"\n')
    expect(readFileSync(path.join(destination, "prototypes/example/.env.schema"), "utf8")).toBe("EXAMPLE=\n")
    expect(existsSync(path.join(destination, "prototypes/example/.env.local"))).toBe(false)
  })

  test.each(["floating", "environment"] as const)("migrates only the exact legacy %s layout", (legacy) => {
    const { root, destination, home } = sourceFixture()
    mkdirSync(destination)
    if (legacy === "floating") {
      write(destination, "floating-skills.mjs", "legacy helper")
      write(destination, "skills.json", "{}")
    } else {
      write(destination, ".managed-by-trellage", "trellage-native-environment-runtime-v1\n")
      write(destination, "native-environment.mjs", "legacy helper")
      write(destination, "node_modules/varlock/package.json", "{}")
      write(destination, "node_modules/smol-toml/package.json", "{}")
    }
    write(destination, "unrelated", "keep")
    expect(run(`install-${legacy}`, root, destination, { HOME: home }).status).toBe(1)
    expect(readFileSync(path.join(destination, "unrelated"), "utf8")).toBe("keep")
    unlinkSync(path.join(destination, "unrelated"))
    const migrated = run(`install-${legacy}`, root, destination, { HOME: home })
    expect(migrated.status, migrated.stderr).toBe(0)
    expect(() => requireOwnedWorkspace(destination)).not.toThrow()
  })

  test("refuses an unowned target and a symlinked parent", () => {
    const { root, destination, home, parent } = sourceFixture()
    mkdirSync(destination)
    write(destination, "keep", "unrelated")
    const unowned = run("install", root, destination, { HOME: home })
    expect(unowned.status).toBe(1)
    expect(unowned.stderr).toContain("unowned")
    expect(readFileSync(path.join(destination, "keep"), "utf8")).toBe("unrelated")
    const redirected = path.join(parent, "link")
    symlinkSync(destination, redirected)
    expect(run("install", root, path.join(redirected, "child"), { HOME: home }).status).toBe(1)
    expect(existsSync(path.join(destination, "child"))).toBe(false)
  })

  describe("Native runtime tools", () => {
    test("hashes names and bytes deterministically and refuses links", () => {
      const first = fixture()
      const second = fixture()
      write(first, "directory/z", "data")
      write(first, "a", "text")
      write(second, "a", "text")
      write(second, "directory/z", "data")
      expect(runtimeTreeHash(first)).toBe(runtimeTreeHash(second))
      write(second, "a", "edit")
      expect(runtimeTreeHash(first)).not.toBe(runtimeTreeHash(second))
      symlinkSync("a", path.join(second, "link"))
      expect(() => runtimeTreeHash(second)).toThrow("symlink")
    })

    test("reports a missing daemon socket as unavailable", async () => {
      expect(await socketIsListening(path.join(fixture(), "absent.sock"))).toBe(false)
    })
  })

  test("refuses unexpected nested content and links outside dependencies", () => {
    const { root, destination, home } = sourceFixture()
    expect(run("install", root, destination, { HOME: home }).status).toBe(0)
    mkdirSync(path.join(destination, "scripts", "unrelated"))
    expect(() => requireOwnedWorkspace(destination)).toThrow("unrelated")
    rmSync(path.join(destination, "scripts", "unrelated"), { recursive: true })
    symlinkSync("../package.json", path.join(destination, "scripts", "escape"))
    expect(() => validateOwnedTree(destination)).toThrow("unpermitted runtime link")
  })

  test("refuses escaping dependency links but accepts workspace links", () => {
    const { root, destination, home } = sourceFixture()
    expect(run("install", root, destination, { HOME: home }).status).toBe(0)
    expect(() => validateOwnedTree(destination)).not.toThrow()
    symlinkSync(home, path.join(destination, "node_modules", "escape"))
    expect(() => validateOwnedTree(destination)).toThrow("unpermitted runtime link")
  })

  test("refuses a lock mismatch without publishing a runtime", () => {
    const { root, destination, home } = sourceFixture()
    write(
      root,
      "packages/application/package.json",
      JSON.stringify({
        name: "@fixture/application",
        version: "2.0.0",
        dependencies: { "@fixture/missing": "workspace:*" },
      }),
    )
    const result = run("install", root, destination, { HOME: home })
    expect(result.status).toBe(1)
    expect(existsSync(destination)).toBe(false)
    expect(existsSync(`${destination}.lock`)).toBe(false)
  })
})
