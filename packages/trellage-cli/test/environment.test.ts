import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { environmentMetadata } from "../src/environment.js"

const withHome = async (run: (home: string, environment: NodeJS.ProcessEnv) => Promise<void>): Promise<void> => {
  const home = await mkdtemp(path.join(os.tmpdir(), "trellage-environment-"))
  await run(home, {})
}

describe("environmentMetadata", () => {
  it("defaults to an optional secure Varlock directory", async () => {
    await withHome(async (home, environment) => {
      await expect(Effect.runPromise(environmentMetadata(environment, home))).resolves.toEqual({
        config_path: path.join(home, ".config", "trellage", "config.toml"),
        config_present: false,
        provider: "varlock",
        enabled: true,
        path: path.join(home, ".config", "trellage"),
        source_present: false,
        required: false,
        strict_permissions: true,
      })
    })
  })

  it("loads a configured environment directory relative to config.toml", async () => {
    await withHome(async (home, environment) => {
      const configDirectory = path.join(home, "configuration")
      const environmentDirectory = path.join(configDirectory, "secrets")
      await mkdir(environmentDirectory, { recursive: true, mode: 0o700 })
      await writeFile(path.join(environmentDirectory, ".env.schema"), "# @sensitive\nTOKEN=\n", { mode: 0o644 })
      await writeFile(path.join(environmentDirectory, ".env.local"), "TOKEN=encrypted\n", { mode: 0o600 })
      await writeFile(path.join(configDirectory, "config.toml"), '[environment]\npath = "secrets"\nrequired = true\n')
      environment.TRELLAGE_CONFIG = path.join(configDirectory, "config.toml")

      const result = await Effect.runPromise(environmentMetadata(environment, home))

      expect(result.path).toBe(environmentDirectory)
      expect(result.source_present).toBe(true)
      expect(result.required).toBe(true)
    })
  })

  it("supports a noninteractive environment override", async () => {
    await withHome(async (home, environment) => {
      environment.TRELLAGE_ENVIRONMENT = "off"

      const result = await Effect.runPromise(environmentMetadata(environment, home))

      expect(result.enabled).toBe(false)
      expect(result.source_present).toBe(false)
    })
  })

  it("rejects loose permissions on secret-bearing files", async () => {
    await withHome(async (home, environment) => {
      const directory = path.join(home, ".config", "trellage")
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const secret = path.join(directory, ".env.local")
      await writeFile(secret, "TOKEN=plaintext\n", { mode: 0o644 })
      await chmod(secret, 0o644)

      await expect(Effect.runPromise(environmentMetadata(environment, home))).rejects.toThrow(
        /must not be accessible by group or other users/,
      )
    })
  })

  it("rejects symbolic-link environment entries", async () => {
    await withHome(async (home, environment) => {
      const directory = path.join(home, ".config", "trellage")
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const target = path.join(home, "secret")
      await writeFile(target, "TOKEN=value\n", { mode: 0o600 })
      await symlink(target, path.join(directory, ".env.local"))

      await expect(Effect.runPromise(environmentMetadata(environment, home))).rejects.toThrow(/regular file/)
    })
  })

  it("rejects unknown environment configuration keys", async () => {
    await withHome(async (home, environment) => {
      const directory = path.join(home, ".config", "trellage")
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await writeFile(path.join(directory, "config.toml"), "[environment]\nenabled = true\nsurprise = true\n")

      await expect(Effect.runPromise(environmentMetadata(environment, home))).rejects.toThrow(
        /invalid \[environment\] configuration/,
      )
    })
  })

  it("rejects a group-writable config file", async () => {
    await withHome(async (home, environment) => {
      const directory = path.join(home, ".config", "trellage")
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const config = path.join(directory, "config.toml")
      await writeFile(config, "[environment]\nenabled = false\n", { mode: 0o620 })
      await chmod(config, 0o620)

      await expect(Effect.runPromise(environmentMetadata(environment, home))).rejects.toThrow(
        /must not be writable by group or other users/,
      )
    })
  })
})
