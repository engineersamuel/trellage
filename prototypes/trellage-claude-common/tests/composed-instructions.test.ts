import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { publishCompositionInstructions } from "../native-skills.ts"

test("composed Copilot instructions preserve user files and reject an unowned destination", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "trellage-instructions-")))
  const priorHarness = process.env.TRELLAGE_NATIVE_COMPOSITION_HARNESS
  const priorSnapshot = process.env.TRELLAGE_NATIVE_COMPOSITION_SNAPSHOT
  try {
    const cache = path.join(root, "snapshot")
    const home = path.join(root, "home")
    await mkdir(cache)
    await mkdir(path.join(home, "instructions"), { recursive: true })
    await writeFile(path.join(cache, "always-on.md"), "Selected instructions.")
    await writeFile(path.join(home, "instructions/user.instructions.md"), "My instructions.")
    process.env.TRELLAGE_NATIVE_COMPOSITION_HARNESS = "copilot"
    process.env.TRELLAGE_NATIVE_COMPOSITION_SNAPSHOT = cache
    const destination = path.join(home, "instructions/trellage-selected.instructions.md")
    await writeFile(destination, "Unowned content")
    await expect(publishCompositionInstructions(cache, path.join(home, "skills"))).rejects.toThrow("refusing to replace user instructions")
    await rm(destination)
    await publishCompositionInstructions(cache, path.join(home, "skills"))
    expect(await readFile(destination, "utf8")).toContain("Selected instructions.")
    expect(await readFile(path.join(home, "instructions/user.instructions.md"), "utf8")).toBe("My instructions.")
    await writeFile(path.join(cache, "always-on.md"), "")
    await publishCompositionInstructions(cache, path.join(home, "skills"))
    expect(await readFile(destination, "utf8")).not.toContain("Selected instructions.")
  } finally {
    if (priorHarness === undefined) delete process.env.TRELLAGE_NATIVE_COMPOSITION_HARNESS
    else process.env.TRELLAGE_NATIVE_COMPOSITION_HARNESS = priorHarness
    if (priorSnapshot === undefined) delete process.env.TRELLAGE_NATIVE_COMPOSITION_SNAPSHOT
    else process.env.TRELLAGE_NATIVE_COMPOSITION_SNAPSHOT = priorSnapshot
    await rm(root, { recursive: true, force: true })
  }
})
test("JCode composition replaces only its managed instruction block", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "trellage-jcode-instructions-")))
  const priorHarness = process.env.TRELLAGE_NATIVE_COMPOSITION_HARNESS
  const priorSnapshot = process.env.TRELLAGE_NATIVE_COMPOSITION_SNAPSHOT
  try {
    const cache = path.join(root, "snapshot")
    const home = path.join(root, "home")
    await mkdir(cache)
    await mkdir(home)
    const destination = path.join(home, "prompt-overlay.md")
    await writeFile(destination, "User prefix.\n")
    await writeFile(path.join(cache, "always-on.md"), "First selection.")
    process.env.TRELLAGE_NATIVE_COMPOSITION_HARNESS = "jcode"
    process.env.TRELLAGE_NATIVE_COMPOSITION_SNAPSHOT = cache
    await publishCompositionInstructions(cache, path.join(home, "skills"))
    await writeFile(destination, (await readFile(destination, "utf8")) + "User suffix.\n")
    await writeFile(path.join(cache, "always-on.md"), "Second selection.")
    await publishCompositionInstructions(cache, path.join(home, "skills"))
    const updated = await readFile(destination, "utf8")
    expect(updated).toStartWith("User prefix.\n")
    expect(updated).toEndWith("User suffix.\n")
    expect(updated).toContain("Second selection.")
    expect(updated).not.toContain("First selection.")
  } finally {
    if (priorHarness === undefined) delete process.env.TRELLAGE_NATIVE_COMPOSITION_HARNESS
    else process.env.TRELLAGE_NATIVE_COMPOSITION_HARNESS = priorHarness
    if (priorSnapshot === undefined) delete process.env.TRELLAGE_NATIVE_COMPOSITION_SNAPSHOT
    else process.env.TRELLAGE_NATIVE_COMPOSITION_SNAPSHOT = priorSnapshot
    await rm(root, { recursive: true, force: true })
  }
})
