import assert from "node:assert/strict"
import { chmod, readFile } from "node:fs/promises"
import { createServer, type Socket } from "node:net"
import path from "node:path"
import {
  ContinuationActionStatus as Status,
  ContinuationPlacementKind as Placement,
  type ContinuationActionDraft,
  type ContinuationDraft,
} from "@trellage/guide-core"
import { createContinuationServices } from "../packages/trellage-launcher/src/continuation-runtime.ts"
import type { ContinuationStore } from "../packages/trellage-launcher/src/continuation-store.ts"
import type { createGuideWorld } from "./exhaustive-guide-world.ts"

export const assertContinuationLaunch = async (
  store: ContinuationStore,
  initial: ContinuationDraft,
  prepared: readonly ContinuationActionDraft[],
  world: Awaited<ReturnType<typeof createGuideWorld>>,
  id: string,
): Promise<void> => {
  assert.equal(prepared.length, 5, id)
  const assessment = initial.assessment
  assert(assessment !== undefined, id)
  for (const wrongAcknowledgment of [false, true]) {
    const label = `${id}: private launch/${wrongAcknowledgment}`
    const created = await store.create(initial.snapshot, initial.model, initial.effort)
    const draft = await store.save(
      {
        ...created,
        assessment,
        actions: prepared.map((edit) => ({
          ...edit,
          selected: true,
          placement: { kind: Placement.NewTab },
          sharedWriteConfirmed: true,
        })),
      },
      created.revision,
    )
    const root = draft.snapshot.source.cwd
    const socketPath = path.join(root, "s")
    const sockets = new Set<Socket>()
    const failures: unknown[] = []
    const deliveries = new Set<string>()
    const panes = new Map<string, string>()
    const commands: Array<{ executable: string; argv: readonly string[] }> = []
    let allocations = 0,
      checks = 0
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once("close", () => sockets.delete(socket))
      let data = "",
        handled = false
      socket.on("data", (chunk) => {
        data += chunk.toString()
        if (handled || !data.includes("\n")) return
        handled = true
        void (async () => {
          const request = JSON.parse(data.slice(0, data.indexOf("\n")))
          assert.deepEqual(Object.keys(request).sort(), ["id", "method", "params"], label)
          assert.equal(request.method, "agent.prompt", label)
          assert.equal(typeof request.id, "string", label)
          const actionId = panes.get(request.params.target)
          assert(actionId !== undefined, label)
          const edit = draft.actions.find((edit) => edit.actionId === actionId)!
          assert.deepEqual(request.params, { target: request.params.target, text: edit.prompt }, label)
          assert.equal(deliveries.has(actionId), false, label)
          const persisted = (await store.load(draft.id)).actions.find((edit) => edit.actionId === actionId)!
          assert.equal(persisted.status, Status.Launching, label)
          assert.equal(persisted.launch?.paneId, request.params.target, label)
          assert.equal(persisted.launch?.workspaceId, "fixture-workspace", label)
          assert.equal(persisted.launch?.cwd, root, label)
          deliveries.add(actionId)
          socket.end(
            JSON.stringify({
              id: request.id,
              result: {
                type: "agent_prompted",
                agent: {
                  pane_id:
                    wrongAcknowledgment && actionId === prepared[1]!.actionId ? "wrong-pane" : request.params.target,
                },
              },
            }) + "\n",
          )
        })().catch((error) => {
          failures.push(error)
          socket.destroy()
        })
      })
    })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(socketPath, resolve)
      })
      await chmod(socketPath, 0o600)
      const unexpected = (): never => {
        throw new Error(`${label}: unexpected model or source boundary`)
      }
      const services = createContinuationServices({
        store,
        initialDraft: draft,
        catalog: world.catalog,
        guideRoot: world.guideRoot,
        socketPath,
        context: { surface: "popup", workspaceId: "fixture-workspace", paneId: "fixture-pane", cwd: root },
        assessmentProvider: unexpected,
        preparationProvider: unexpected,
        jevDecision: { cwd: root, client: { systemOne: unexpected } },
        sourceClient: {
          refresh: unexpected,
          check: async (snapshot) => {
            assert.deepEqual(snapshot, draft.snapshot, label)
            checks++
            return { sameSource: true, advanced: false, revision: snapshot.revision }
          },
        },
        runner: {
          run: async (executable, argv, options) => {
            try {
              commands.push({ executable, argv })
              const ok = (value: unknown) => ({ exitCode: 0 as const, stdout: JSON.stringify(value), stderr: "" })
              if (executable === "/fixture/bin/trx") {
                const entry = world.catalog.native.find((entry) => entry.launcher === argv[1] && entry.name === argv[2])
                assert(entry !== undefined, label)
                assert.deepEqual(argv, ["inventory", entry.launcher, entry.name, "--json"], label)
                assert.equal(options?.cwd, root, label)
                assert.equal(options?.timeoutMs, 30_000, label)
                return ok({ schemaVersion: 2, harness: entry.harness, profiles: entry.profiles, readiness: "healthy" })
              }
              assert.equal(executable, "herdr", label)
              if (argv[0] === "tab") {
                assert.deepEqual(
                  argv,
                  ["tab", "create", "--workspace", "fixture-workspace", "--cwd", root, "--no-focus"],
                  label,
                )
                assert.equal(options?.cwd, root, label)
                const action = draft.actions[allocations++]!
                assert(action !== undefined, label)
                const pane = `fixture-pane-${allocations}`
                panes.set(pane, action.actionId)
                assert.equal(
                  (await store.load(draft.id)).actions.find((edit) => edit.actionId === action.actionId)!.status,
                  Status.Launching,
                  label,
                )
                return ok({ result: { root_pane: { pane_id: pane } } })
              }
              const pane = argv[2]!
              const actionId = panes.get(pane)
              assert(actionId !== undefined, label)
              if (argv[0] === "pane") {
                const action = draft.assessment!.actions.find((action) => action.id === actionId)!
                const [launcher, profile] = action.profileRef.replace(/^native:/u, "").split("/")
                assert.deepEqual(
                  argv,
                  ["pane", "run", pane, `env TRELLAGE_AUTOMATION=1 /fixture/bin/trx run ${launcher} ${profile}`],
                  label,
                )
                assert.equal(options?.cwd, root, label)
                return ok({})
              }
              assert.deepEqual(argv, ["agent", "get", pane], label)
              return ok({ result: { agent: { agent_status: "idle" } } })
            } catch (error) {
              failures.push(error)
              throw error
            }
          },
        },
      })
      const result = await services.launch(draft, false)
      assert.deepEqual(failures, [], label)
      assert.equal(checks, 1, label)
      assert.equal(allocations, 5, label)
      assert.equal(deliveries.size, 5, label)
      assert.equal(commands.length, 20, label)
      assert.deepEqual(
        result.actions.map((edit) => edit.status),
        prepared.map((_, index) => (wrongAcknowledgment && index === 1 ? Status.Unknown : Status.Launched)),
        label,
      )
      assert.deepEqual(await store.load(result.id), result, label)
      const journal = await readFile(path.join(root, "continuations", "launch-events", `${result.id}.jsonl`), "utf8")
      const events = journal
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      assert.equal(events.length, 15, label)
      for (const edit of result.actions) {
        const actionEvents = events.filter((event) => event.actionId === edit.actionId)
        assert.deepEqual(
          actionEvents.map((event) => event.status),
          [Status.Launching, Status.Launching, edit.status],
          label,
        )
        assert(
          actionEvents.every((event) => event.attemptId === edit.launch!.attemptId),
          label,
        )
        for (const value of [journal, ...commands.flatMap((command) => command.argv)]) {
          assert(!value.includes("Fixture Cautious"), label)
          assert(!value.includes(edit.brief), label)
        }
      }
      await assert.rejects(
        services.launch(result, false),
        wrongAcknowledgment ? /uncertain launch/ : /Select a prepared, unlaunched action/,
        label,
      )
      assert.equal(commands.length, 20, label)
      assert.equal(deliveries.size, 5, label)
      assert.deepEqual(await store.load(result.id), result, label)
    } finally {
      for (const socket of sockets) socket.destroy()
      if (server.listening)
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  }
}
