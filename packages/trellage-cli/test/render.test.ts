import { Effect } from "effect"
import { afterAll, describe, expect, it } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { renderCodexConfig, renderMiseConfig } from "../src/render.js"
import type { ProfileLock } from "../src/lock.js"
import { parseProfile } from "../src/profile.js"
import { createRuntimeSupportSnapshot } from "../src/runtime-support.js"

const source = `
schema = 1
name = "golden"
description = "Golden render profile"
[harness]
kind = "codex"
version = "0.144.6"
args = ["--dangerously-bypass-approvals-and-sandbox"]
[harness.codex]
model = "gpt-5.5"
reasoning_effort = "medium"
model_provider = "proxy"
[harness.codex.providers.proxy]
name = "Copilot Proxy"
base_url = "http://proxy:8080/v1"
wire_api = "responses"
request_max_retries = 3
stream_max_retries = 5
stream_idle_timeout_ms = 300000
[image]
base = "node:22.17.0-bookworm-slim"
shell = "fish"
packages = ["bash", "fish", "git"]
[[skills]]
repository = "https://github.com/example/caveman.git"
ref = "v1.10.0"
select = ["caveman"]
always_on = true
[[mcps]]
name = "local"
transport = "stdio"
command = "local-mcp"
args = ["serve"]
env = { MODE = "safe" }
env_from_secret = { TOKEN = "DOCS_TOKEN" }
tools = { allow = ["search"], deny = ["delete"] }
[[mcps]]
name = "docs"
transport = "http"
url = "https://example.test/mcp"
required = true
bearer_token_env = "DOCS_TOKEN"
headers = { "X-Mode" = "safe" }
headers_from_secret = { Authorization = "DOCS_TOKEN" }
[secrets]
provider = "env"
required = ["DOCS_TOKEN"]
`

const copilotSource = `
schema = 1
name = "copilot-hve"
description = "Copilot render profile"
[harness]
kind = "copilot"
version = "latest"
[harness.copilot]
auth = "host-or-login"
[image]
base = "node:22.17.0-bookworm-slim"
shell = "fish"
packages = ["bash", "fish", "git", "jq"]
[[plugins]]
adapter = "copilot-marketplace"
repository = "https://github.com/microsoft/hve-core.git"
ref = "main"
marketplace = "hve-core"
select = ["hve-core"]
`

const claudeSource = `
schema = 1
name = "claude-research"
description = "Claude render profile"
[harness]
kind = "claude"
version = "2.1.218"
[harness.claude]
default_auth = "proxy"
model = "claude-opus-5"
gateway = "http://copilot-proxy-rs:8080"
[image]
base = "node:22.17.0-bookworm-slim"
shell = "fish"
packages = ["bash", "git", "jq"]
[[plugins]]
adapter = "hyperresearch"
repository = "https://github.com/jordan-gibbs/hyperresearch.git"
ref = "main"
select = ["light"]
`

const claudeMarketplaceSource = `
schema = 1
name = "claude-social-media"
description = "Claude marketplace render profile"
[harness]
kind = "claude"
version = "2.1.218"
[harness.claude]
default_auth = "proxy"
model = "claude-opus-5"
gateway = "http://copilot-proxy-rs:8080"
[image]
base = "node:22.17.0-bookworm-slim"
shell = "fish"
packages = ["bash", "git", "jq"]
[[plugins]]
adapter = "claude-marketplace"
repository = "https://github.com/charlie947/social-media-skills.git"
ref = "main"
marketplace = "social-media-skills"
select = ["social-media-skills"]
`

const piSource = `
schema = 1
name = "pi-oh-my-pi"
description = "Oh My Pi profile"
[harness]
kind = "pi"
version = "latest"
args = ["--yolo"]
[harness.pi]
implementation = "oh-my-pi"
provider = "github-copilot"
model = "gpt-5.6-terra"
auth = "host-or-login"
[image]
base = "node:22.17.0-bookworm-slim"
shell = "fish"
packages = ["bash", "git", "jq"]
`

const primeSource = `
schema = 1
name = "prime-agent"
description = "Prime Agent profile"
[harness]
kind = "prime"
version = "latest"
[harness.prime]
provider = "copilot-proxy-rs"
model = "claude-opus-5"
base_url = "http://copilot-proxy-rs:8080"
api = "anthropic-messages"
[image]
base = "node:22.17.0-bookworm-slim"
shell = "fish"
packages = ["bash", "gh", "git"]
`

const profile = Effect.runSync(parseProfile(source, "/profile/profile.toml")).profile
const copilotProfile = Effect.runSync(parseProfile(copilotSource, "/profile/copilot.toml")).profile
const claudeProfile = Effect.runSync(parseProfile(claudeSource, "/profile/claude.toml")).profile
const piProfile = Effect.runSync(parseProfile(piSource, "/profile/pi.toml")).profile
const primeProfile = Effect.runSync(parseProfile(primeSource, "/profile/prime.toml")).profile
const claudeMarketplaceProfile = Effect.runSync(
  parseProfile(claudeMarketplaceSource, "/profile/claude-marketplace.toml"),
).profile
const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "trellage-render-runtime-"))
afterAll(() => rm(runtimeRoot, { recursive: true, force: true }))
const runtimePaths = {
  codexEntry: path.join(runtimeRoot, "runtime-entry.sh"),
  copilotEntry: path.join(runtimeRoot, "runtime-copilot-entry.sh"),
  piEntry: path.join(runtimeRoot, "runtime-pi-entry.sh"),
  primeEntry: path.join(runtimeRoot, "runtime-prime-entry.sh"),
  finalizeCopilotSeed: path.join(runtimeRoot, "finalize-copilot-seed.mjs"),
  finalizeClaudeSeed: path.join(runtimeRoot, "finalize-claude-seed.mjs"),
  claudeEntry: path.join(runtimeRoot, "runtime-claude-entry.sh"),
  hyperresearchRequirements: path.join(runtimeRoot, "requirements.lock"),
  claudeBrowserAgent: path.join(runtimeRoot, "browser-agent.md"),
}
await Promise.all(Object.values(runtimePaths).map((file) => writeFile(file, file)))
const codexRuntime = await Effect.runPromise(createRuntimeSupportSnapshot("codex", runtimePaths))
const copilotRuntime = await Effect.runPromise(createRuntimeSupportSnapshot("copilot", runtimePaths))
const claudeRuntime = await Effect.runPromise(createRuntimeSupportSnapshot("claude", runtimePaths))
const claudeMarketplaceRuntime = await Effect.runPromise(
  createRuntimeSupportSnapshot("claude", runtimePaths, "claude-marketplace"),
)
const piRuntime = await Effect.runPromise(createRuntimeSupportSnapshot("pi", runtimePaths))
const primeRuntime = await Effect.runPromise(createRuntimeSupportSnapshot("prime", runtimePaths))
const lock = (kind: "claude" | "codex" | "copilot" | "pi"): ProfileLock => ({
  schema: 1,
  platform: "linux/arm64",
  source_date_epoch: 1784379906,
  profile_hash: `sha256:${"a".repeat(64)}`,
  sources: [],
  packages: {
    deja: {
      name: "deja",
      version: "0.17.0",
      integrity: "sha256:e6b21fdd9953b8428bd9464fc1cd6c9bbb1ad9396db31727a96903f60598b0e1",
      url: "https://github.com/vshulcz/deja-vu/releases/download/v0.17.0/deja-vu_0.17.0_linux_arm64.tar.gz",
      size: 4364290,
    },
    harness:
      kind === "codex"
        ? {
            kind,
            selector: "0.144.6",
            version: "0.144.6",
            integrity: `sha256:${"b".repeat(64)}`,
            url: "https://example.test/codex.tar.gz",
            size: 42,
          }
        : kind === "copilot"
          ? {
              kind,
              selector: "latest",
              version: "1.0.75",
              integrity: "sha256:0911f12dd816f612d27c4a360d4f00b62d933845a98d6c913e8d7400a69c6809",
              url: "https://github.com/github/copilot-cli/releases/download/v1.0.75/copilot-linux-arm64.tar.gz",
              size: 106111479,
            }
          : kind === "pi"
            ? {
                kind,
                selector: "latest",
                version: "17.2.6",
                integrity: "sha256:65cd7f5e7d537b0b41f277191c1b95b53d509f8147c3d1bd508503dc048f1453",
                url: "https://github.com/can1357/oh-my-pi/releases/download/v17.2.6/omp-linux-arm64",
                size: 157526160,
              }
            : {
                kind,
                selector: "2.1.218",
                version: "2.1.218",
                integrity: `sha256:${"d".repeat(64)}`,
                url: "https://github.com/anthropics/claude-code/releases/download/v2.1.218/claude-linux-arm64.tar.gz",
                size: 88123930,
              },
    runtime: [],
  },
  image: {
    base: "node:22.17.0-bookworm-slim",
    base_digest: `sha256:${"c".repeat(64)}`,
  },
})

const primeLock: ProfileLock = {
  schema: 1,
  platform: "linux/arm64",
  source_date_epoch: 1784379906,
  profile_hash: `sha256:${"a".repeat(64)}`,
  sources: [],
  packages: {
    deja: {
      name: "deja",
      version: "0.17.0",
      integrity: "sha256:e6b21fdd9953b8428bd9464fc1cd6c9bbb1ad9396db31727a96903f60598b0e1",
      url: "https://github.com/vshulcz/deja-vu/releases/download/v0.17.0/deja-vu_0.17.0_linux_arm64.tar.gz",
      size: 4364290,
    },
    harness: {
      kind: "prime",
      selector: "latest",
      version: "0.7.0",
      integrity: "sha256:88b6578518c72cd51a825bc80f28e0fef9a64c67de4a7d6fd7afd7ca1b34da0b",
      url: "https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/releases/v0.7.0/prime-agent-0.7.0.tgz",
      size: 9323789,
    },
    runtime: [],
  },
  image: {
    base: "node:22.17.0-bookworm-slim",
    base_digest: `sha256:${"c".repeat(64)}`,
  },
}

describe("golden rendering", () => {
  it("rejects Copilot Codex-config rendering", () => {
    expect(() => renderCodexConfig(copilotProfile)).toThrow(/Codex rendering does not support Copilot profiles/)
  })

  it("renders a native Copilot OCI input from the exact lock without Codex or auth state", () => {
    const rendered = renderMiseConfig(copilotProfile, lock("copilot"), {
      baseReference: "docker.io/library/node@sha256:base",
      imageTag: "trellage-profile-copilot-hve:locked",
      runtimeSupport: copilotRuntime,
    })

    expect(rendered).toContain(`[tools."http:copilot"]
version = "1.0.75"
url = "https://github.com/github/copilot-cli/releases/download/v1.0.75/copilot-linux-arm64.tar.gz"
checksum = "sha256:0911f12dd816f612d27c4a360d4f00b62d933845a98d6c913e8d7400a69c6809"
size = "106111479"
rename_exe = "copilot"`)
    expect(rendered).toContain('COPILOT_HOME = "/home/agent/.copilot"')
    expect(rendered).toContain('COPILOT_AUTO_UPDATE = "false"')
    expect(rendered).toContain('XDG_CACHE_HOME = "/home/agent/.cache"')
    expect(rendered).not.toContain('XDG_CACHE_HOME = "/tmp/.cache"')
    expect(rendered).toContain('"/home/agent/.keep" = { source = "workspace.keep", mode = "copy" }')
    expect.soft(rendered).toContain('"dev.trellage.prototype" = "trellage"')
    expect.soft(rendered).toContain('"dev.trellage.profile"')
    expect.soft(rendered).toContain('"dev.trellage.platform" = "linux/arm64"')
    expect
      .soft(rendered)
      .toContain('"/usr/local/share/trellage/copilot-seed" = { source = "copilot-seed", mode = "copy" }')
    expect
      .soft(rendered)
      .toContain('"/usr/local/bin/trellage-copilot-entry" = { source = "runtime-copilot-entry.sh", mode = "copy" }')
    expect.soft(rendered).toContain('"dev.trellage.harness.kind" = "copilot"')
    expect.soft(rendered).toContain('"dev.trellage.copilot.version" = "1.0.75"')
    expect.soft(rendered).toContain('"dev.trellage.deja.version" = "0.17.0"')
    expect.soft(rendered).toContain(`"dev.trellage.runtime.hash" = "${copilotRuntime.hash}"`)
    expect
      .soft(rendered)
      .toContain(
        '"/usr/local/lib/trellage/deja/0.17.0/linux_arm64/deja" = { source = "deja/linux_arm64/deja", mode = "copy" }',
      )
    const runtimeEntry = copilotRuntime.files.find((file) => file.role === "runtime-copilot-entry")!
    expect
      .soft(rendered)
      .toContain(`"${runtimeEntry.destination}" = { source = "${runtimeEntry.buildContextPath}", mode = "copy" }`)
    expect(runtimeEntry.mode).toBe(0o755)
    expect.soft(rendered).not.toContain("dev.sandbox-harness")
    expect.soft(rendered).not.toContain("/usr/local/share/harness")
    expect.soft(rendered).not.toContain("harness-copilot-entry")
    expect.soft(rendered).not.toContain('"dev.trellage.prototype" = "harness-enter-codex"')
    expect(rendered).not.toMatch(/codex-config|http:codex|CODEX_HOME|codex\.version/)
    expect(rendered).not.toContain("initial-prompt")
    expect(rendered).not.toContain("host-or-login")
  })

  it("renders Codex providers and stdio/HTTP MCPs without secret values", () => {
    expect(renderCodexConfig(profile)).toMatchInlineSnapshot(`
      "model = \"gpt-5.5\"
      model_provider = \"proxy\"
      model_reasoning_effort = \"medium\"

      [model_providers.proxy]
      name = \"Copilot Proxy\"
      base_url = \"http://proxy:8080/v1\"
      wire_api = \"responses\"
      request_max_retries = 3
      stream_max_retries = 5
      stream_idle_timeout_ms = 300000

      [mcp_servers.local]
      command = \"local-mcp\"
      args = [\"serve\"]
      env = { MODE = \"safe\" }
      env_vars = [\"TOKEN\"]
      enabled_tools = [\"search\"]
      disabled_tools = [\"delete\"]

      [mcp_servers.docs]
      url = \"https://example.test/mcp\"
      required = true
      bearer_token_env_var = \"DOCS_TOKEN\"
      http_headers = { \"X-Mode\" = \"safe\" }
      env_http_headers = { Authorization = \"DOCS_TOKEN\" }
      "
    `)
  })

  it("renders locked Oh My Pi runtime identity and isolated state", () => {
    const rendered = renderMiseConfig(piProfile, lock("pi"), {
      baseReference: "docker.io/library/node@sha256:base",
      imageTag: "trellage-profile-pi-oh-my-pi:locked",
      runtimeSupport: piRuntime,
    })

    expect(rendered).toContain('[tools."http:pi"]')
    expect(rendered).toContain('rename_exe = "omp"')
    expect(rendered).toContain('PI_CODING_AGENT_DIR = "/home/agent/.omp/agent"')
    expect(rendered).toContain('OMP_SKIP_SETUP = "1"')
    expect(rendered).toContain('XDG_CACHE_HOME = "/home/agent/.cache"')
    expect(rendered).toContain('"/usr/local/bin/trellage-pi-entry" = { source = "runtime-pi-entry.sh", mode = "copy" }')
    expect(rendered).toContain(
      '"/usr/local/share/trellage/pi-config.yml" = { source = "pi-config.yml", mode = "copy" }',
    )
    expect(rendered).toContain('"/usr/local/share/trellage/pi-seed" = { source = "pi-seed", mode = "copy" }')
    expect(rendered).toContain('"dev.trellage.harness.kind" = "pi"')
    expect(rendered).toContain('"dev.trellage.pi.implementation" = "oh-my-pi"')
    expect(rendered).toContain('"dev.trellage.pi.version" = "17.2.6"')
    expect(rendered).not.toMatch(/COPILOT_GITHUB_TOKEN|GH_TOKEN|GITHUB_TOKEN/)
  })

  it("renders Prime Agent with only the locked provider seed and persistent Prime state", () => {
    const rendered = renderMiseConfig(primeProfile, primeLock, {
      baseReference: "docker.io/library/node@sha256:base",
      imageTag: "trellage-profile-prime-agent:locked",
      runtimeSupport: primeRuntime,
    })

    expect(rendered).toContain('node = "22.17.0"')
    expect(rendered).not.toContain('[tools."http:prime"]')
    expect(rendered).toContain(
      '"/usr/local/lib/node_modules" = { source = "prime-agent-prefix/lib/node_modules", mode = "copy" }',
    )
    expect(rendered).toContain('"/usr/local/bin/prime-agent" = { source = "prime-agent-wrapper.sh", mode = "copy" }')
    expect(rendered).toContain(
      '"/usr/local/share/trellage/prime-kernel-seed.tar.gz" = { source = "prime-kernel-seed.tar.gz", mode = "copy" }',
    )
    expect(rendered).toContain('"/usr/local/share/trellage/prime-seed" = { source = "prime-seed", mode = "copy" }')
    expect(rendered).toContain(
      '"/usr/local/bin/trellage-prime-entry" = { source = "runtime-prime-entry.sh", mode = "copy" }',
    )
    expect(rendered).toContain('PRIME_AGENT_CODING_AGENT_DIR = "/home/agent/.prime/agent"')
    expect(rendered).toContain('PI_OFFLINE = "1"')
    expect(rendered).toContain('PI_SKIP_VERSION_CHECK = "1"')
    expect(rendered).toContain('PRIME_AGENT_INSTALL_UV = "0"')
    expect(rendered).toContain(
      'PRIME_AGENT_KERNEL_PYTHON = "/home/agent/.trellage/prime-kernel/.prime/agent/kernel-venv/bin/python"',
    )
    expect(rendered).toContain('XDG_CACHE_HOME = "/home/agent/.cache"')
    expect(rendered).toContain('"dev.trellage.harness.kind" = "prime"')
    expect(rendered).toContain('"dev.trellage.prime.version" = "0.7.0"')
    expect(rendered).not.toMatch(
      /ANTHROPIC_API_KEY|OPENAI_API_KEY|COPILOT_GITHUB_TOKEN|GH_TOKEN|GITHUB_TOKEN|CODEX_HOME|COPILOT_HOME|CLAUDE_CONFIG_DIR|PI_CODING_AGENT_DIR/,
    )
  })

  it("renders the locked Claude toolchain and managed seed without credentials", () => {
    const rendered = renderMiseConfig(claudeProfile, lock("claude"), {
      baseReference: "docker.io/library/node@sha256:base",
      imageTag: "trellage-profile-claude-research:locked",
      runtimeSupport: claudeRuntime,
    })

    expect(rendered).toContain('node = "22.17.0"')
    expect(rendered).toContain('python = "3.13.14"')
    expect(rendered).toContain('[tools."http:claude"]')
    expect(rendered).toContain('rename_exe = "claude"')
    expect(rendered).toContain('"npm:@playwright/mcp" = "0.0.78"')
    expect(rendered).toContain('"/usr/local/share/trellage/claude-seed" = { source = "claude-seed", mode = "copy" }')
    expect(rendered).toContain(
      '"/ms-playwright/chromium_headless_shell-1228" = { source = "chromium-headless-shell-1228", mode = "copy" }',
    )
    expect(rendered).toContain(
      '"/usr/local/bin/trellage-claude-entry" = { source = "runtime-claude-entry.sh", mode = "copy" }',
    )
    expect(rendered).toContain('"dev.trellage.harness.kind" = "claude"')
    expect(rendered).not.toMatch(/CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|PLAYWRIGHT_MCP_EXTENSION_TOKEN/)
  })

  it("renders native Claude marketplace images without Hyperresearch assets", () => {
    const rendered = renderMiseConfig(claudeMarketplaceProfile, lock("claude"), {
      baseReference: "docker.io/library/node@sha256:base",
      imageTag: "trellage-profile-claude-social-media:locked",
      runtimeSupport: claudeMarketplaceRuntime,
    })

    expect(rendered).toContain('TRELLAGE_CLAUDE_RUNTIME_MODE = "native-plugin"')
    expect(rendered).toContain('"/usr/local/share/trellage/claude-seed"')
    expect(rendered).not.toMatch(/hyperresearch|playwright|chromium|obscura|PYTHONPATH/)
  })

  it("renders an opt-in Deja helper beside the fixed managed binary", async () => {
    const helper = path.join(runtimeRoot, "deja-memory")
    await writeFile(helper, "#!/bin/sh\nexit 0\n")
    const runtime = await Effect.runPromise(
      createRuntimeSupportSnapshot("codex", { ...runtimePaths, dejaMemory: helper }),
    )

    const rendered = renderMiseConfig(profile, lock("codex"), {
      baseReference: "docker.io/library/node@sha256:base",
      imageTag: "trellage-profile-golden:locked",
      runtimeSupport: runtime,
    })

    expect(rendered).toContain('"/usr/local/bin/deja-memory" = { source = "deja-memory", mode = "copy" }')
    expect(rendered).toContain(
      '"/usr/local/lib/trellage/deja/0.17.0/linux_arm64/deja" = { source = "deja/linux_arm64/deja", mode = "copy" }',
    )
  })

  it("rejects a non-canonical Deja artifact before rendering", () => {
    const exactLock = lock("codex")

    expect(() =>
      renderMiseConfig(
        profile,
        {
          ...exactLock,
          packages: {
            ...exactLock.packages,
            deja: { ...exactLock.packages.deja!, version: "0.17.1" },
          },
        },
        {
          baseReference: "docker.io/library/node@sha256:base",
          imageTag: "trellage-profile-golden:locked",
          runtimeSupport: codexRuntime,
        },
      ),
    ).toThrow(/exact managed Deja artifact/)
  })

  it("renders locked mise OCI input", () => {
    const rendered = renderMiseConfig(profile, lock("codex"), {
      baseReference: "docker.io/library/node@sha256:base",
      imageTag: "trellage-profile-golden:locked",
      runtimeSupport: codexRuntime,
    })

    expect(rendered).toContain('version = "0.144.6"')
    expect(rendered).toContain(`checksum = "sha256:${"b".repeat(64)}"`)
    expect(rendered).toContain('url = "https://example.test/codex.tar.gz"')
    expect(rendered).toContain('"apt:fish"')
    expect(rendered).toContain('from = "docker.io/library/node@sha256:base"')
    expect(rendered).toContain('tag = "trellage-profile-golden:locked"')
    expect
      .soft(rendered)
      .toContain('"/usr/local/bin/trellage-codex-entry" = { source = "runtime-entry.sh", mode = "copy" }')
    expect.soft(rendered).toContain('"dev.trellage.prototype" = "trellage"')
    expect.soft(rendered).toContain('"dev.trellage.profile"')
    expect.soft(rendered).not.toContain("dev.sandbox-harness")
    expect.soft(rendered).not.toContain("/usr/local/share/harness")
    expect.soft(rendered).not.toContain("harness-codex-entry")
    expect.soft(rendered).not.toContain('"dev.trellage.prototype" = "harness-enter-codex"')
    expect(rendered).toContain('XDG_CACHE_HOME = "/tmp/.cache"')
    expect(rendered).toContain('"/home/agent/.codex/AGENTS.md" = { source = "assets/AGENTS.md", mode = "copy" }')
    expect(rendered).not.toContain('XDG_CACHE_HOME = "/home/agent/.cache"')
  })
})
