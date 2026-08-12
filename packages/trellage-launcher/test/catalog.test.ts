import { describe, expect, it } from "vitest"
import { parseLaunchCatalog } from "../src/catalog.js"

describe("launch catalog", () => {
  it("normalizes picker choices with model and harness metadata", () => {
    const catalog = parseLaunchCatalog(
      JSON.stringify({
        prompt: "Select a harness",
        description: "Choose a host-native harness profile.",
        choices: [
          {
            id: "cdx:hve",
            label: "codex / hve",
            harness: "codex",
            profile: "hve",
            description: "HVE",
            harnessVersion: "1.2.3",
            plugins: ["planner", "reviewer"],
            skills: ["debugging", "verification"],
            mcps: ["docs"],
            commandAlias: "cdx",
            commandPath: "/opt/trellage/cdx/bin/cdx",
            profileArgument: "hve",
            passthroughArgs: ["--literal", "two words", ""],
            details: "Ready",
            defaultModel: "gpt-default",
            models: ["gpt-default", "gpt-fast"],
            modelOverrideSupported: true,
            sandbox: true,
          },
        ],
      }),
    )

    expect(catalog.prompt).toBe("Select a harness")
    expect(catalog.description).toBe("Choose a host-native harness profile.")
    expect(catalog.entries[0]).toMatchObject({
      id: "cdx:hve",
      harness: "codex",
      profile: "hve",
      harnessVersion: "1.2.3",
      plugins: ["planner", "reviewer"],
      skills: ["debugging", "verification"],
      commandAlias: "cdx",
      commandPath: "/opt/trellage/cdx/bin/cdx",
      profileArgument: "hve",
      passthroughArgs: ["--literal", "two words", ""],
      mcps: ["docs"],
      defaultModel: "gpt-default",
      models: ["gpt-default", "gpt-fast"],
      modelOverrideSupported: true,
      sandbox: true,
    })
  })

  it("derives harness and profile from legacy labels while keeping models fixed", () => {
    const catalog = parseLaunchCatalog(
      JSON.stringify([{ id: "0", label: "claude-council / claude", description: "Council" }]),
    )

    expect(catalog.entries[0]).toMatchObject({
      harness: "claude",
      profile: "claude-council",
      models: [],
      modelOverrideSupported: false,
    })
  })

  it("rejects a non-boolean sandbox value", () => {
    expect(() =>
      parseLaunchCatalog(
        JSON.stringify([{ id: "one", label: "one / codex", description: "One", sandbox: "yes" }]),
      ),
    ).toThrow(/sandbox must be a boolean/)
  })

  it("rejects duplicate IDs and terminal control characters", () => {
    expect(() =>
      parseLaunchCatalog(
        JSON.stringify([
          { id: "same", label: "one / codex", description: "One" },
          { id: "same", label: "two / codex", description: "Two" },
        ]),
      ),
    ).toThrow(/unique/)
    expect(() =>
      parseLaunchCatalog(JSON.stringify([{ id: "one", label: "one / codex\n", description: "One" }])),
    ).toThrow(/control/)
  })
})
