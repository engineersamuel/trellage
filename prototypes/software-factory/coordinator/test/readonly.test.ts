import { expect, test } from "bun:test"
import { readOnlyViolation } from "../src/readonly.ts"

test("sub-coordinator shell: reading is allowed", () => {
  for (const cmd of [
    "ls -a; cat mise.toml compose.yaml 2>/dev/null; which mise process-compose; grep -n PORT -r src/config.rs | head",
    "git status --short && git diff --stat origin/main",
    "git -C /x log --oneline -5",
    "gh pr view 52 --json state",
    "sed -n 1,40p README.md",
    "find . -name '*.rs' | wc -l",
    "curl -fsS 127.0.0.1:18080/health",
    "mise ls process-compose 2>&1 | head -3",
    "FOO=1 cat x",
    "git branch --show-current",
  ])
    expect([cmd, readOnlyViolation(cmd)]).toEqual([cmd, null])
})

test("sub-coordinator shell: writes, builds, runs and servers are refused", () => {
  const cases: [string, string][] = [
    ["cat > mise.toml <<'EOF'\n[tools]\nEOF", "output redirection writes a file"],
    ["echo x >> README.md", "output redirection writes a file"],
    ["sed -i 's/a/b/' x", "sed -i edits files"],
    ["export COPILOT_PROXY_RS_PORT=18080; mise run proxy:up", "export is not on the read-only list"],
    ["mise run proxy:up", "mise run runs or installs"],
    ["cargo build --release", "cargo build builds or runs"],
    ["cargo test --locked", "cargo test builds or runs"],
    ["git commit -m x", "git commit changes the repo"],
    ["git checkout -b y", "git checkout changes the repo"],
    ["git branch -D y", "git branch with arguments changes the repo"],
    ["rm -rf target", "rm is not on the read-only list"],
    ["find . -name x -delete", "find with -exec/-delete"],
    ["curl -o out http://x", "curl that writes or posts"],
    ["gh pr create --fill", "gh pr create is not read-only"],
    ["python3 -c 'open(\"x\",\"w\")'", "python3 runs code"],
    ["cat $(echo x)", "command substitution is not allowed"],
    ["ls | xargs rm", "xargs is not on the read-only list"],
    ["bash -c 'touch x'", "bash is not on the read-only list"],
  ]
  for (const [cmd, why] of cases) expect([cmd, readOnlyViolation(cmd)]).toEqual([cmd, why])
})
