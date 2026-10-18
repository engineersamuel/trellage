import { describe, expect, it } from "vitest"
import { buildHerdrCommand, shellQuote } from "../src/run-select-cli.tsx"

describe("run selector Herdr command", () => {
  it("POSIX-quotes every command argument", () => {
    expect(shellQuote("say 'hello'")) .toBe("'say '\\''hello'\\'''" )
    expect(buildHerdrCommand(
      "/tmp/work tree/bin/trx",
      { harness: "codex", profiles: ["youtube", "team's-profile"], model: "gpt 5", effort: "high" },
      ["--dry-run", "--", "say 'hello'"],
    )).toBe(
      "'/tmp/work tree/bin/trx' 'run' 'codex' 'youtube' 'team'\\''s-profile' '--model' 'gpt 5' '--effort' 'high' '--dry-run' '--' 'say '\\''hello'\\'''",
    )
  })

  it("forwards source-checkout router variables so the split pane can run it", () => {
    expect(buildHerdrCommand(
      "/src/bin/trx",
      { harness: "pi", profiles: ["default"] },
      [],
      { TRELLAGE_TRX_SOURCE_ROOT: "/src", TRELLAGE_TRX_NATIVE_SOURCE: "1", HOME: "/home/me" },
    )).toBe("'env' 'TRELLAGE_TRX_SOURCE_ROOT=/src' 'TRELLAGE_TRX_NATIVE_SOURCE=1' '/src/bin/trx' 'run' 'pi' 'default'")
  })
})
