#!/usr/bin/env bun
import path from "node:path"
import { pathToFileURL } from "node:url"
import { runConversationSourceCli } from "@trellage/conversation-source/cli"
import { bunExecutable } from "@trellage/runtime"

export {
  checkConversationSource, main, runConversationSourceCli,
  type ConversationSourceDependencies,
} from "@trellage/conversation-source/cli"

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  bunExecutable()
  process.exitCode = await runConversationSourceCli()
}
