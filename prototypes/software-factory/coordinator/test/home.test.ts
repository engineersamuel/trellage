import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { homeAll, homeFor, homeMismatch, homeWarning, parseHome, readHome } from "../src/home.ts"
import { withHome } from "../src/tools.ts"

const text =
  "Shared rule: never touch port 8080.\n\n## copilot-proxy-rs\nProxy notes.\n\n## Weavekit\nUses the proxy.\n"

test("a repo gets the shared rules and only its own section", () => {
  const h = parseHome("/p/FACTORY.md", text)
  const one = homeFor(h, "copilot-proxy-rs")
  expect(one).toContain("never touch port 8080")
  expect(one).toContain("Proxy notes.")
  expect(one).not.toContain("Uses the proxy.")
  expect(one).toContain(`hash="${h.hash}"`)
  expect(homeFor(h, "weavekit")).toContain("Uses the proxy.")
  expect(homeFor(h, "other")).not.toContain("## other")
  expect(homeFor(parseHome("/p", "## a\nx"), "b")).toBe("")
})

test("the desk gets the whole file; no file adds nothing", () => {
  const h = parseHome("/p/FACTORY.md", text)
  expect(homeAll(h)).toContain("Proxy notes.")
  expect(homeAll(h)).toContain("Uses the proxy.")
  expect(homeAll(null)).toBe("")
  expect(homeFor(null, "x")).toBe("")
  expect(readHome({ SF_HOME_FILE: "/nonexistent/FACTORY.md" })).toBeNull()
})

test("a repo worker's task gets its section; a General worker's does not", () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "sf-home-")), "FACTORY.md")
  writeFileSync(file, text)
  process.env.SF_HOME_FILE = file
  try {
    expect(withHome("T", { folderId: "copilot-proxy-rs", label: "copilot-proxy-rs" })).toContain("Proxy notes.")
    expect(withHome("T", {})).toBe("T")
  } finally {
    delete process.env.SF_HOME_FILE
  }
})

test("sections and folders that do not match are named", () => {
  const h = parseHome("/p/FACTORY.md", text)
  expect(homeMismatch(h, ["copilot-proxy-rs", "trellage"])).toEqual({ sections: ["weavekit"], folders: ["trellage"] })
  expect(homeWarning(h, ["copilot-proxy-rs", "weavekit"])).toBeNull()
  expect(homeWarning(h, ["copilot-proxy-rs"])).toContain("reach only the desk): weavekit")
  expect(homeWarning(null, ["x"])).toBeNull()
})
