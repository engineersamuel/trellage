import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { captureDockerTarget, dockerHostArguments, dockerSocketPath, verifyDockerTarget } from "../src/docker-target.js"

describe("Docker target", () => {
  it("prefers an explicit Unix DOCKER_HOST and captures one server identity", async () => {
    const calls: Array<ReadonlyArray<string>> = []
    const run = (_command: string, args: ReadonlyArray<string>) => {
      calls.push(args)
      return Effect.succeed("server-a\nlinux/arm64\n")
    }

    const target = await Effect.runPromise(captureDockerTarget({ DOCKER_HOST: "unix:///tmp/docker-a.sock" }, run))

    expect(target).toEqual({ endpoint: "unix:///tmp/docker-a.sock", serverId: "server-a", platform: "linux/arm64" })
    expect(calls).toEqual([
      ["--host", "unix:///tmp/docker-a.sock", "info", "--format", "{{.ID}}\n{{.OSType}}/{{.Architecture}}"],
    ])
    expect(dockerSocketPath(target)).toBe("/tmp/docker-a.sock")
    expect(dockerHostArguments(target, ["image", "inspect", "example"])).toEqual([
      "--host",
      "unix:///tmp/docker-a.sock",
      "image",
      "inspect",
      "example",
    ])
  })

  it("fails revalidation when the server identity changes", async () => {
    const target = { endpoint: "unix:///tmp/docker.sock", serverId: "server-a", platform: "linux/arm64" } as const
    const run = () => Effect.succeed("server-b\nlinux/arm64\n")

    await expect(Effect.runPromise(verifyDockerTarget(target, run))).rejects.toThrow(/Docker server changed/)
  })
})
