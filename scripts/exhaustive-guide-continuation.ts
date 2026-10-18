import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import { mkdtemp, mkdir, readdir, realpath, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { resolveGuideModelRouting, type GuideHeadlessArgs } from "../packages/trellage-launcher/src/guide-api.ts"
import {
  ConversationAgent,
  ConversationRole,
  ConversationSurface,
  type ConversationSnapshot,
} from "@trellage/guide-core"
import { bunArguments, bunExecutable } from "@trellage/runtime"
import { openContinuationRequest } from "../packages/trellage-launcher/src/continuation-entry.ts"
import { ContinuationSourceClient } from "../packages/trellage-launcher/src/continuation-source-client.ts"
import { ContinuationStore } from "../packages/trellage-launcher/src/continuation-store.ts"
import type { createGuideWorld } from "./exhaustive-guide-world.ts"
import { assertContinuationAssessment } from "./exhaustive-continuation-assessment.ts"

// Source capture is an explicit command mock. Source adapters and
// terminal interaction remain separate coverage obligations.
const assertContinuationEntry = async (
  args: GuideHeadlessArgs,
  id: string,
  world: Awaited<ReturnType<typeof createGuideWorld>>,
): Promise<void> => {
  const root = await mkdtemp(path.join(await realpath(os.homedir()), ".trx-exhaustive-continuation-"))
  try {
    assert.equal((await stat(root)).mode & 0o777, 0o700, id)
    const store = new ContinuationStore(root)
    const snapshot: ConversationSnapshot = {
      schemaVersion: 1,
      id: randomUUID(),
      source: {
        serverId: "fixture-server",
        surface: ConversationSurface.Host,
        agent: ConversationAgent.Copilot,
        sessionId: "fixture-session",
        workspaceId: "fixture-workspace",
        paneId: "fixture-pane",
        cwd: root,
      },
      capturedAt: "2026-01-01T00:00:00.000Z",
      cutoff: { messageId: "m2", recordIndex: 1 },
      revision: "a".repeat(64),
      messages: [
        { id: "m1", role: ConversationRole.User, text: "Review the fixture changes.", recordIndex: 0 },
        {
          id: "m2",
          role: ConversationRole.Assistant,
          text: "The fixture changes are ready for review.",
          recordIndex: 1,
        },
      ],
      coverage: { complete: true, notices: [] },
    }
    let calls = 0,
      sameSource = true
    const client = new ContinuationSourceClient({
      store,
      repoRoot: root,
      env: { TRELLAGE_TEST_OFFLINE: "1", HOME: root, PATH: "" },
      runner: {
        run: async (executable, argv, options) => {
          const request = argv.at(-1)!
          assert.equal(executable, bunExecutable(), id)
          assert.deepEqual(
            argv,
            bunArguments(
              pathToFileURL(
                createRequire(new URL("../packages/trellage-launcher/package.json", import.meta.url)).resolve(
                  "@trellage/conversation-source/cli",
                ),
              ),
              ["--check", request],
            ),
            id,
          )
          assert.equal(path.dirname(request), path.join(root, "continuations", "requests"), id)
          assert.equal((await stat(request)).mode & 0o777, 0o600, id)
          assert.deepEqual(await store.consumeRequest(request), snapshot, id)
          assert.equal(options?.cwd, root, id)
          assert.equal(options?.timeoutMs, 60_000, id)
          assert.equal(options?.terminationGraceMs, 10_000, id)
          assert.deepEqual(
            options?.env,
            {
              TRELLAGE_TEST_OFFLINE: "1",
              HOME: root,
              PATH: "",
              BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
              TRELLAGE_ROOT: root,
            },
            id,
          )
          calls++
          return {
            exitCode: 0,
            stdout: JSON.stringify({ sameSource, advanced: false, revision: snapshot.revision }),
            stderr: "",
          }
        },
      },
    })
    const context = {
      surface: "popup" as const,
      workspaceId: snapshot.source.workspaceId!,
      paneId: snapshot.source.paneId!,
      cwd: root,
    }
    const routing = resolveGuideModelRouting(
      {
        ...(args.model === undefined ? {} : { model: args.model }),
        ...(args.effort === undefined ? {} : { effort: args.effort }),
      },
      {},
    )
    const requestPath = await store.stageRequest(snapshot)
    const input = {
      store,
      sourceClient: client,
      context,
      requestPath,
      model: routing.match.model,
      effort: routing.match.effort,
    }
    for (const wrong of [
      { ...context, paneId: "other-pane" },
      { ...context, workspaceId: "other-workspace" },
      { ...context, cwd: path.join(root, "other") },
    ]) {
      await assert.rejects(openContinuationRequest({ ...input, context: wrong }), /original focused pane/, id)
      assert.equal(calls, 0, id)
      assert((await stat(requestPath)).isFile(), id)
    }
    sameSource = false
    await assert.rejects(openContinuationRequest(input), /pane changed sessions/, id)
    assert.equal(calls, 1, id)
    assert.equal(await store.find(snapshot.source), undefined, id)
    assert.deepEqual(await readdir(path.dirname(requestPath)), [path.basename(requestPath)], id)
    sameSource = true
    const first = await openContinuationRequest(input)
    assert.equal(first.hasSavedDraft, false, id)
    assert.equal(first.draft.model, routing.match.model, id)
    assert.equal(first.draft.effort, routing.match.effort, id)
    assert.deepEqual(first.draft.snapshot, snapshot, id)
    assert.equal(first.draft.assessment, undefined, id)
    assert.deepEqual(await store.load(first.draft.id), first.draft, id)
    assert.deepEqual(await readdir(path.dirname(requestPath)), [], id)
    const saved = await store.save(
      { ...first.draft, model: "fixture-saved-model", effort: "high" },
      first.draft.revision,
    )
    const reopened = await openContinuationRequest({ ...input, requestPath: await store.stageRequest(snapshot) })
    assert.equal(reopened.hasSavedDraft, true, id)
    assert.deepEqual(reopened.draft, saved, id)
    assert.equal(calls, 3, id)
    assert.deepEqual(await readdir(path.dirname(requestPath)), [], id)
    await assertContinuationAssessment(store, snapshot, first.draft, world, id)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

export const assertGuideContinuationAdmission = async (
  args: GuideHeadlessArgs,
  argv: readonly string[],
  id: string,
  world: Awaited<ReturnType<typeof createGuideWorld>>,
): Promise<"next-steps-launch"> => {
  assert.equal(process.env.TRELLAGE_TEST_OFFLINE, "1", "use scripts/test-offline.sh")
  assert(args.nextSteps && argv.length > 0, id)
  const root = await mkdtemp(path.join(os.tmpdir(), "trellage-continuation-preconditions-"))
  try {
    const home = path.join(root, "home"),
      bin = path.join(root, "bin"),
      state = path.join(root, "state")
    await Promise.all([mkdir(home), mkdir(bin), mkdir(state)])
    const pane = {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "fixture-workspace",
      HERDR_PANE_ID: "fixture-pane",
    }
    const cases: ReadonlyArray<{ name: string; env: NodeJS.ProcessEnv; error: string }> = [
      {
        name: "ordinary intent file conflicts before context resolution",
        env: { TRELLAGE_GUIDE_HERDR_INTENT_FILE: path.join(root, "absent-intent") },
        error: "A conversation request cannot be combined with an ordinary guide intent file.",
      },
      { name: "outside Herdr", env: {}, error: "Conversation next steps requires Herdr." },
      {
        name: "incomplete pane context",
        env: { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "fixture-workspace" },
        error: "Conversation next steps requires Herdr.",
      },
      {
        name: "missing private state",
        env: pane,
        error: "Conversation next steps requires the private Herdr plugin state directory.",
      },
      {
        name: "relative private state",
        env: { ...pane, HERDR_PLUGIN_STATE_DIR: "relative-state" },
        error: "Conversation next steps requires the private Herdr plugin state directory.",
      },
      {
        name: "relative helper root",
        env: {
          ...pane,
          HERDR_PLUGIN_STATE_DIR: state,
          TRELLAGE_GUIDE_CONVERSATION_HELPER_ROOT: "relative-helper",
        },
        error: "The conversation helper root must be absolute.",
      },
    ]
    for (const fixture of cases) {
      const label = `${id}: ${fixture.name}`
      const result = spawnSync(
        process.execPath,
        [
          "--no-install",
          "--no-env-file",
          fileURLToPath(new URL("../packages/trellage-launcher/src/cli.tsx", import.meta.url)),
          "guide",
          fileURLToPath(new URL("../profile-guides", import.meta.url)),
          path.join(root, "prompt-master"),
          ...argv,
        ],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
          env: {
            HOME: home,
            PATH: bin,
            TRELLAGE_ENVIRONMENT: "off",
            TRELLAGE_TEST_OFFLINE: "1",
            BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
            NO_COLOR: "1",
            ...fixture.env,
          },
        },
      )
      assert.equal(result.error, undefined, label)
      assert.equal(result.signal, null, label)
      assert.equal(result.status, 2, `${label}: ${result.stderr}`)
      assert.equal(result.stdout, "", label)
      assert.equal(result.stderr, `trellage-launcher: ${fixture.error}\n`, label)
      assert.deepEqual(await readdir(state), [], `${label}: no request state created`)
      assert.deepEqual(await readdir(home), [], `${label}: no host configuration initialized`)
    }
    await assertContinuationEntry(args, id, world)
    return "next-steps-launch"
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
