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
  for (const cmd of ["git status", "git log --oneline", "git merge-base main HEAD", "git branch -a", "git worktree list", "git reset HEAD file", "rm file.txt", "rm -r dir", "ls -rf", "bun test", 'git -C "/tmp/repo with spaces" status', "git -c 'user.name=First Last' log", 'git commit -m "do not push; merge later"', "git --version", "echo git; merge main"])
    expect([cmd, forbiddenCommand(cmd)]).toEqual([cmd, false])
})

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Factory } from "../src/factory.ts"

test("the global coordinator's permissions reject forbidden shell commands and keep the settings gate", async () => {
  const f = new Factory({ SF_STATE_DIR: mkdtempSync(path.join(tmpdir(), "sf-g-")) })
  const ask = (request: any) => f.globalPermissions(request, { sessionId: "s" } as any)
  expect(await ask({ kind: "shell", fullCommandText: "git push origin main" })).toMatchObject({ kind: "reject" })
  expect(await ask({ kind: "shell", fullCommandText: "git status" })).toEqual({ kind: "approve-once" })
  f.settings = { ...f.settings, agent: { ...f.settings.agent, disabledTools: ["shell"] } }
  expect(await ask({ kind: "shell", fullCommandText: "git status" })).toMatchObject({ kind: "reject" })
})

test("sub-coordinator permissions reject forbidden shell commands and keep the settings gate", async () => {
  const f = new Factory({ SF_STATE_DIR: mkdtempSync(path.join(tmpdir(), "sf-g-")) })
  const ask = (request: any) => f.subPermissions(request, { sessionId: "s" } as any)
  expect(await ask({ kind: "shell", fullCommandText: "git push -u origin factory/x" })).toMatchObject({ kind: "reject" })
  expect(await ask({ kind: "shell", fullCommandText: "git worktree remove ../wt" })).toMatchObject({ kind: "reject" })
  expect(await ask({ kind: "shell", fullCommandText: "git commit -m x" })).toEqual({ kind: "approve-once" })
  f.settings = { ...f.settings, agent: { ...f.settings.agent, disabledTools: ["shell"] } }
  expect(await ask({ kind: "shell", fullCommandText: "git status" })).toMatchObject({ kind: "reject" })
})
