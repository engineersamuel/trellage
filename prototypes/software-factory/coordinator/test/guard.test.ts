import { expect, test } from "bun:test"
import { forbiddenCommand } from "../src/guard.ts"

test("forbiddenCommand blocks merge, push, branch delete, worktree remove, hard reset and rm -rf", () => {
  for (const cmd of [
    "git merge main",
    "git push origin HEAD",
    "git -C /repo push",
    "cd /repo && git -c user.name=x merge feat",
    "git branch -d feat",
    "git branch -D feat",
    "git branch --delete feat",
    "git worktree remove /wt",
    "git reset --hard HEAD~1",
    "/usr/bin/git push",
    "bash -c 'git push --force'",
    "echo $(git push)",
    "rm -rf /repo",
    "rm -fr .",
    "sudo rm -r -f /repo",
    "rm --recursive --force x",
    'git -C "/tmp/repo with spaces" push origin HEAD',
    'git -c user.name="First Last" merge feature',
    "git -C '/tmp/repo with spaces' branch -D feat",
    "git -C /tmp/repo\\ with\\ spaces worktree remove /wt",
    'git --git-dir "/a b/.git" --work-tree=/w reset --hard',
    'bash -c "git status; git push"',
    'sh -c "echo \\"x\\"; git merge main"',
    "git pu\\sh origin",
  ])
    expect([cmd, forbiddenCommand(cmd)]).toEqual([cmd, true])
})

test("forbiddenCommand allows read-only and ordinary commands", () => {
  for (const cmd of [
    "git status",
    "git log --oneline",
    "git merge-base main HEAD",
    "git branch -a",
    "git worktree list",
    "git reset HEAD file",
    "rm file.txt",
    "rm -r dir",
    "ls -rf",
    "bun test",
    'git -C "/tmp/repo with spaces" status',
    "git -c 'user.name=First Last' log",
    'git commit -m "do not push; merge later"',
    "git --version",
    "echo git; merge main",
  ])
    expect([cmd, forbiddenCommand(cmd)]).toEqual([cmd, false])
})

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { PermissionHandler } from "@github/copilot-sdk"
import { Factory } from "../src/factory.ts"

type Request = Parameters<PermissionHandler>[0]
type Invocation = Parameters<PermissionHandler>[1]

test("the global coordinator's permissions reject forbidden shell commands and keep the settings gate", async () => {
  const f = new Factory({ SF_STATE_DIR: mkdtempSync(path.join(tmpdir(), "sf-g-")) })
  const ask = (request: object) => f.globalPermissions(request as Request, { sessionId: "s" } as Invocation)
  expect(await ask({ kind: "shell", fullCommandText: "git push origin main" })).toMatchObject({ kind: "reject" })
  expect(await ask({ kind: "shell", fullCommandText: "git status" })).toEqual({ kind: "approve-once" })
  await f.updateSettings({ agent: { disabledTools: ["shell"] } })
  expect(await ask({ kind: "shell", fullCommandText: "git status" })).toMatchObject({ kind: "reject" })
})

test("sub-coordinator permissions reject forbidden shell commands and keep the settings gate", async () => {
  const f = new Factory({ SF_STATE_DIR: mkdtempSync(path.join(tmpdir(), "sf-g-")) })
  const ask = (request: object) => f.subPermissions(request as Request, { sessionId: "s" } as Invocation)
  expect(await ask({ kind: "shell", fullCommandText: "git push -u origin factory/x" })).toMatchObject({
    kind: "reject",
  })
  expect(await ask({ kind: "shell", fullCommandText: "git worktree remove ../wt" })).toMatchObject({ kind: "reject" })
  // Coordinate, do not do: writes and non-read-only shell go to workers; reading stays allowed.
  expect(await ask({ kind: "shell", fullCommandText: "git commit -m x" })).toMatchObject({ kind: "reject" })
  expect(await ask({ kind: "write", fileName: "mise.toml" })).toMatchObject({ kind: "reject" })
  expect(await ask({ kind: "shell", fullCommandText: "git status && cat README.md" })).toEqual({ kind: "approve-once" })
  await f.updateSettings({ agent: { disabledTools: ["shell"] } })
  expect(await ask({ kind: "shell", fullCommandText: "git status" })).toMatchObject({ kind: "reject" })
})

test("forbiddenCommand blocks gh merge, branch delete and repo delete; allows other gh commands and gh api", () => {
  for (const cmd of ["gh pr merge 12 --squash", "gh pr close 12 -d", "gh repo delete x/y"])
    expect([cmd, forbiddenCommand(cmd)]).toEqual([cmd, true])
  for (const cmd of [
    "gh pr create --fill",
    "gh pr checks --watch",
    "gh pr view --json url",
    "gh run view 1 --log-failed",
    "gh api repos/x/y/pulls/1",
    "gh api -X POST repos/x/y/issues/1/comments -f body=x",
    "gh pr close 12",
  ])
    expect([cmd, forbiddenCommand(cmd)]).toEqual([cmd, false])
})

test("with a push branch, only a plain push of that branch to origin is allowed", () => {
  const b = "factory/x-1"
  for (const cmd of [
    `git push -u origin ${b}`,
    `git push origin ${b}`,
    `git push --set-upstream origin HEAD:${b}`,
    `git push origin HEAD:refs/heads/${b}`,
  ])
    expect([cmd, forbiddenCommand(cmd, b)]).toEqual([cmd, false])
  for (const cmd of [
    `git push --force origin ${b}`,
    `git push -f origin ${b}`,
    `git push origin +${b}`,
    `git push --force-with-lease origin ${b}`,
    "git push origin main",
    `git push origin ${b}:main`,
    `git push origin :${b}`,
    `git push --delete origin ${b}`,
    `git push upstream ${b}`,
    "git push",
    `git push origin ${b} main`,
    `git push -u origin ${b} && git merge main`,
    `gh pr merge --auto`,
  ])
    expect([cmd, forbiddenCommand(cmd, b)]).toEqual([cmd, true])
  expect(forbiddenCommand(`git push -u origin ${b}`)).toBe(true)
})

test("agents never copy or move credential files; reading them in place is fine", () => {
  for (const cmd of [
    "cp ~/.config/copilot-proxy-rs/github_token /tmp/x/github_token",
    'mkdir -p "$D" && cp ~/.config/copilot-proxy-rs/github_token "$D/github_token"',
    "rsync -a ~/.config/gh/hosts.yml /tmp/",
    "ln -s ~/.netrc /tmp/n",
  ])
    expect([cmd, forbiddenCommand(cmd)]).toEqual([cmd, true])
  for (const cmd of [
    "COPILOT_PROXY_RS_CONFIG_DIR=$HOME/.config/copilot-proxy-rs ./target/release/copilot-proxy-rs",
    "ls ~/.config/copilot-proxy-rs/",
    "cp README.md /tmp/x",
  ])
    expect([cmd, forbiddenCommand(cmd)]).toEqual([cmd, false])
})
