import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { resolveGuideModelRouting, type GuideHeadlessArgs } from "../packages/trellage-launcher/src/guide-api.ts"
import {
  CommandRunnerError,
  type CommandRunner,
  type HerdrContext,
} from "../packages/trellage-launcher/src/guide-launch.ts"
import { createGuideReviewServices } from "../packages/trellage-launcher/src/review-services.ts"
import { reviewCatalog, fleetLenses, reviewModels } from "../packages/trellage-launcher/src/review-catalog.ts"
import {
  assertGuideReviewTargetCurrent,
  type GuideReviewScope,
} from "../packages/trellage-launcher/src/review-target.ts"
import { assertGuideReviewExecution } from "./exhaustive-guide-review-execution.ts"
import { assertGuideInteractiveIntent } from "./exhaustive-guide-interactive.ts"
import type { createGuideWorld } from "./exhaustive-guide-world.ts"

export const assertGuideReviewTarget = async (
  args: GuideHeadlessArgs,
  world: Awaited<ReturnType<typeof createGuideWorld>>,
  id: string,
): Promise<"review-target"> => {
  assert.equal(process.env.TRELLAGE_TEST_OFFLINE, "1", "use scripts/test-offline.sh")
  assert(args.review, id)
  await assertGuideInteractiveIntent(args, id)
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "trellage-review-target-")))
  const cwd = path.join(root, "repo"),
    home = path.join(root, "home")
  try {
    await Promise.all([mkdir(cwd), mkdir(home)])
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_NO_LAZY_FETCH: "1",
      TRELLAGE_TEST_OFFLINE: "1",
      GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
    }
    const git = (argv: readonly string[], input?: string) => {
      const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...argv], {
        cwd,
        env,
        input,
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      })
      assert.equal(result.error, undefined, id)
      assert.equal(result.signal, null, id)
      if (result.status !== 0)
        throw new CommandRunnerError({
          kind: "exited",
          executable: "git",
          args: argv,
          message: result.stderr,
          exitCode: result.status,
          stdout: result.stdout,
          stderr: result.stderr,
        })
      return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 as const }
    }
    git(["init", "--quiet", "-b", "main"])
    git(["config", "user.name", "Offline fixture"])
    git(["config", "user.email", "fixture@example.invalid"])
    for (const name of ["committed.ts", "staged.ts", "unstaged.ts", "deleted.ts"])
      await writeFile(path.join(cwd, name), "before\n")
    git(["add", "."])
    git(["commit", "--quiet", "-m", "Fixture baseline"])
    const base = git(["rev-parse", "HEAD"]).stdout.trim()
    git(["update-ref", "refs/remotes/origin/main", base])
    git(["checkout", "--quiet", "-b", "fixture-change"])
    await writeFile(path.join(cwd, "committed.ts"), "committed change\n")
    git(["commit", "--quiet", "-am", "Fixture change"])
    const head = git(["rev-parse", "HEAD"]).stdout.trim()
    await writeFile(path.join(cwd, "staged.ts"), "staged change\n")
    git(["add", "staged.ts"])
    await writeFile(path.join(cwd, "unstaged.ts"), "unstaged change\n")
    await rm(path.join(cwd, "deleted.ts"))
    await writeFile(path.join(cwd, "untracked.ts"), "untracked change\n")
    const runner: CommandRunner = {
      run: async (executable, argv, options) => {
        assert.equal(executable, "git", `${id}: unexpected external boundary`)
        assert.equal(options?.cwd, cwd, `${id}: escaped fixture`)
        const prefix = argv[0] === "--no-optional-locks"
          ? ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"]
          : ["-c", "core.fsmonitor=false"]
        assert.deepEqual(argv.slice(0, prefix.length), prefix, id)
        assert(
          ["rev-parse", "for-each-ref", "branch", "worktree", "merge-base", "diff", "status", "ls-files", "ls-tree", "show", "log"].includes(
            argv[prefix.length]!,
          ),
          id,
        )
        options?.signal?.throwIfAborted()
        return git(argv, options?.stdin)
      },
    }
    const unexpected = async (): Promise<never> => {
      throw new Error(`${id}: unexpected model or agent boundary`)
    }
    const routing = resolveGuideModelRouting(
      {
        ...(args.model === undefined ? {} : { model: args.model }),
        ...(args.effort === undefined ? {} : { effort: args.effort }),
      },
      {},
    )
    const contexts: ReadonlyArray<HerdrContext | null> = [
      null,
      { surface: "pane", workspaceId: "fixture-workspace", paneId: "fixture-pane" },
      { surface: "popup", workspaceId: "fixture-workspace", paneId: "fixture-pane", cwd },
    ]
    const signal = new AbortController().signal
    for (const context of contexts) {
      const services = createGuideReviewServices({
        runner,
        cwd,
        context,
        catalog: world.catalog,
        env: {},
        routing,
        modelOverrides: {
          ...(args.model === undefined ? {} : { model: routing.optimize.model }),
          ...(args.effort === undefined ? {} : { effort: routing.optimize.effort }),
        },
        dependencies: {
          modelCall: unexpected,
          listAgents: unexpected,
          readiness: unexpected,
          processReader: unexpected,
        },
      })
      assert.equal(services.herdr, context !== null, id)
      assert.deepEqual(
        services.destinations,
        context === null ? ["terminal"] : context.surface === "popup" ? ["pane", "tab"] : ["pane", "tab", "terminal"],
        id,
      )
      assert.deepEqual(
        services.profiles.map((profile) => profile.ref),
        world.catalog.entries
          .filter((entry) => ["copilot", "codex", "claude"].includes(entry.harness))
          .map((entry) => entry.ref),
        id,
      )
      assert.deepEqual(services.coordinator, { model: args.model ?? "gpt-6-astra", effort: args.effort ?? "max" }, id)
      assert.deepEqual(
        services.assignments?.map((assignment) => assignment.id),
        reviewCatalog.map((check) => check.id),
        id,
      )
      for (const assignment of services.assignments!) {
        const check = reviewCatalog.find((check) => check.id === assignment.id)!
        const model = {
          model: args.model ?? check.model,
          effort: args.effort ?? (check.kind === "fleet" || check.id === "ponytail" ? "high" : "low"),
        }
        assert.deepEqual(assignment.model, model, id)
        assert.deepEqual(
          assignment.workers,
          check.kind === "fleet"
            ? fleetLenses.map((name, index) => ({
                name,
                model: { model: args.model ?? reviewModels[index % reviewModels.length], effort: args.effort ?? "low" },
              }))
            : check.kind === "two-axis"
              ? [{ name: "Standards", model }]
              : [],
          id,
        )
      }
      const scopes: GuideReviewScope[] =
        args.reviewBase === undefined
          ? [{ kind: "uncommitted" }, { kind: "current-branch" }]
          : [{ kind: "branch", baseRef: args.reviewBase }]
      for (const scope of scopes) {
        const requested = scope.kind === "branch" ? scope.baseRef.trim() : undefined
        if (requested !== undefined && /[\uD800-\uDFFF]/u.test(requested)) {
          await assert.rejects(
            () => services.inspect(scope, signal),
            {
              name: "GuideValidationError",
              message: "Comparison base: must not contain unpaired Unicode surrogates",
            },
            id,
          )
          continue
        }
        if (
          requested !== undefined &&
          !["origin/main", "main", "refs/heads/main", "refs/remotes/origin/main"].includes(requested)
        ) {
          await assert.rejects(
            () => services.inspect(scope, signal),
            (error: unknown) =>
              error instanceof CommandRunnerError &&
              error.kind === "exited" &&
              error.args.includes(`${requested}^{commit}`),
            id,
          )
          continue
        }
        const target = await services.inspect(scope, signal)
        assert.equal(target.cwd, cwd, id)
        assert.equal(target.gitDirectory, path.join(cwd, ".git"), id)
        assert.equal(target.head, head, id)
        const branch = scope.kind !== "uncommitted"
        assert.deepEqual(
          target.base,
          branch ? { ref: requested ?? "refs/remotes/origin/main", commit: base, mergeBase: base } : undefined,
          id,
        )
        assert.deepEqual(
          target.changes.map(({ path: name, staged, unstaged, untracked, committed, kind }) => ({
            name,
            staged,
            unstaged,
            untracked,
            committed,
            kind,
          })),
          [
            ...(branch
              ? [
                  {
                    name: "committed.ts",
                    staged: false,
                    unstaged: false,
                    untracked: false,
                    committed: true,
                    kind: "file",
                  },
                ]
              : []),
            { name: "deleted.ts", staged: false, unstaged: true, untracked: false, committed: false, kind: "deleted" },
            { name: "staged.ts", staged: true, unstaged: false, untracked: false, committed: false, kind: "file" },
            { name: "unstaged.ts", staged: false, unstaged: true, untracked: false, committed: false, kind: "file" },
            { name: "untracked.ts", staged: false, unstaged: false, untracked: true, committed: false, kind: "file" },
          ],
          id,
        )
        assert.deepEqual(await assertGuideReviewTargetCurrent(runner, target, signal), target, id)
        // Execution does not depend on the scope: run it for the first scope only.
        if (scope === scopes[0] && (context === null || context.surface === "popup")) await assertGuideReviewExecution(args, world, id, { root, runner, target, context })
        await writeFile(path.join(cwd, "untracked.ts"), "changed during review\n")
        await assert.rejects(
          () => assertGuideReviewTargetCurrent(runner, target, signal),
          /worktree or comparison base changed/,
          id,
        )
        await writeFile(path.join(cwd, "untracked.ts"), "untracked change\n")
      }
    }
    return "review-target"
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
