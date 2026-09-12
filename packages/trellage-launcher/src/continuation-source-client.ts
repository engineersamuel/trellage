import { conversationSourceKey, type ConversationSnapshot } from "@trellage/guide-core/conversation"
import { bunArguments, bunExecutable } from "@trellage/runtime"
import { CommandRunnerError, type CommandRunner } from "./guide-launch.ts"
import type { ContinuationSourceStatus } from "./continuation-services.ts"
import type { ContinuationStore } from "./continuation-store.ts"

enum SourceOperation {
  Check = "--check",
  Refresh = "--refresh",
}

enum CommandFailure {
  Aborted = "aborted",
}

const record = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The focused conversation helper returned invalid metadata.")
  }
  return value as Record<string, unknown>
}

export class ContinuationSourceClient {
  constructor(
    private readonly options: {
      readonly store: ContinuationStore
      readonly runner: CommandRunner
      readonly repoRoot: string
      readonly env: NodeJS.ProcessEnv
    },
  ) {}

  private async run(
    snapshot: ConversationSnapshot,
    operation: SourceOperation,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    signal?.throwIfAborted()
    const requestPath = await this.options.store.stageRequest(snapshot)
    try {
      const response = await this.options.runner.run(
        bunExecutable(),
        bunArguments(new URL(import.meta.resolve("@trellage/conversation-source/cli")), [operation, requestPath]),
        {
          cwd: snapshot.source.cwd,
          env: {
            ...this.options.env,
            BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
            TRELLAGE_ROOT: this.options.env.TRELLAGE_ROOT ?? this.options.repoRoot,
          },
          timeoutMs: 60_000,
          terminationGraceMs: 10_000,
          ...(signal === undefined ? {} : { signal }),
        },
      )
      let value: unknown
      try {
        value = JSON.parse(response.stdout)
      } catch {
        throw new Error("The focused conversation helper returned invalid JSON metadata.")
      }
      return record(value)
    } catch (error) {
      if (
        signal?.aborted &&
        error instanceof CommandRunnerError &&
        error.kind === CommandFailure.Aborted &&
        error.exitCode === 143 &&
        error.signal === null &&
        error.stdout.length === 0 &&
        error.stderr.length === 0
      ) {
        throw new DOMException("Conversation capture was cancelled after cleanup.", "AbortError")
      }
      throw error
    } finally {
      await this.options.store.acknowledgeRequest(requestPath)
    }
  }

  async check(snapshot: ConversationSnapshot, signal?: AbortSignal): Promise<ContinuationSourceStatus> {
    const value = await this.run(snapshot, SourceOperation.Check, signal)
    if (
      typeof value.sameSource !== "boolean" ||
      typeof value.advanced !== "boolean" ||
      typeof value.revision !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.revision) ||
      (value.message !== undefined && typeof value.message !== "string") ||
      Object.keys(value).some((key) => !["sameSource", "advanced", "revision", "message"].includes(key))
    ) {
      throw new Error("The focused conversation helper returned invalid freshness metadata.")
    }
    return {
      sameSource: value.sameSource,
      advanced: value.advanced,
      revision: value.revision,
      ...(typeof value.message === "string" ? { message: value.message } : {}),
    }
  }

  async refresh(
    snapshot: ConversationSnapshot,
    signal?: AbortSignal,
  ): Promise<{ readonly snapshot: ConversationSnapshot; readonly requestPath: string }> {
    const value = await this.run(snapshot, SourceOperation.Refresh, signal)
    if (typeof value.requestPath !== "string" || Object.keys(value).length !== 1) {
      throw new Error("The focused conversation helper did not return a private request path.")
    }
    const refreshed = await this.options.store.consumeRequest(value.requestPath)
    if (conversationSourceKey(refreshed.source) !== conversationSourceKey(snapshot.source)) {
      throw new Error("The focused source changed. Open the picker again; no other conversation was selected.")
    }
    return { snapshot: refreshed, requestPath: value.requestPath }
  }
}
