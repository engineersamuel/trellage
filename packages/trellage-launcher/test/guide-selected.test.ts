import path from "node:path"
import { describe, expect, it } from "vitest"

import { SelectedGuideError, sandboxGuideRootFromProfilePath } from "../src/guide-selected.js"

describe("sandbox guide root derivation", () => {
  it("derives the owning worktree guide registry from a profile document", () => {
    expect(
      sandboxGuideRootFromProfilePath(
        path.join(path.sep, "repo", "profiles", "claude-social-media", "profile.toml"),
        "claude-social-media",
      ),
    ).toBe(path.join(path.sep, "repo", "profile-guides"))
  })

  it("rejects paths that do not match the selected profile identity", () => {
    expect(() =>
      sandboxGuideRootFromProfilePath(
        path.join(path.sep, "repo", "profiles", "other", "profile.toml"),
        "claude-social-media",
      ),
    ).toThrow(SelectedGuideError)
    expect(() =>
      sandboxGuideRootFromProfilePath("profiles/claude-social-media/profile.toml", "claude-social-media"),
    ).toThrow(SelectedGuideError)
  })
})
