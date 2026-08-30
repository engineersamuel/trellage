import { constants } from "node:fs"
import { lstat, open, realpath, unlink, type FileHandle } from "node:fs/promises"
import path from "node:path"

import {
  GuideArgsError,
  guideIntentMaximumLength,
  type GuideHeadlessArgs,
  validateGuideIntent,
} from "./guide-api.js"
import type { HerdrContext } from "./guide-launch.js"

export const popupGuideIntentFileEnvironmentVariable = "TRELLAGE_GUIDE_HERDR_INTENT_FILE"

const guideIntentDirectoryName = "guide-intents"
const guideIntentFilename =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.txt$/u
const maximumGuideIntentBytes = guideIntentMaximumLength * 4

const invalidIntentFile = (message: string, options?: ErrorOptions): Error =>
  new Error(`Popup guide intent file ${message}`, options)

const currentUserId = (): number => {
  if (process.getuid === undefined) throw invalidIntentFile("requires a POSIX user identity")
  return process.getuid()
}

interface GuideIntentLocation {
  readonly stateDirectory: string
  readonly intentDirectory: string
  readonly intentPath: string
}

const guideIntentLocation = (stateDirectory: string, intentPath: string): GuideIntentLocation => {
  if (!path.isAbsolute(stateDirectory)) throw invalidIntentFile("state directory must be absolute")
  if (!path.isAbsolute(intentPath)) throw invalidIntentFile("path must be absolute")
  const resolvedStateDirectory = path.resolve(stateDirectory)
  const intentDirectory = path.join(resolvedStateDirectory, guideIntentDirectoryName)
  const resolvedIntentPath = path.resolve(intentPath)
  if (
    path.dirname(resolvedIntentPath) !== intentDirectory ||
    !guideIntentFilename.test(path.basename(resolvedIntentPath))
  ) {
    throw invalidIntentFile("path is outside the private plugin state directory")
  }
  return {
    stateDirectory: resolvedStateDirectory,
    intentDirectory,
    intentPath: resolvedIntentPath,
  }
}

const validateIntentDirectory = async (location: GuideIntentLocation, uid: number): Promise<void> => {
  const status = await lstat(location.intentDirectory)
  if (!status.isDirectory() || status.uid !== uid || (status.mode & 0o777) !== 0o700) {
    throw invalidIntentFile("directory must be an owned mode-0700 directory")
  }
  const [stateRealPath, intentRealPath] = await Promise.all([
    realpath(location.stateDirectory),
    realpath(location.intentDirectory),
  ])
  if (path.relative(stateRealPath, intentRealPath) !== guideIntentDirectoryName) {
    throw invalidIntentFile("directory escapes the private plugin state directory")
  }
}

const validateOpenedIntent = async (
  handle: FileHandle,
  location: GuideIntentLocation,
  uid: number,
): Promise<void> => {
  const [openedStatus, pathStatus] = await Promise.all([handle.stat(), lstat(location.intentPath)])
  if (
    !openedStatus.isFile() ||
    openedStatus.uid !== uid ||
    (openedStatus.mode & 0o777) !== 0o600 ||
    openedStatus.nlink !== 1 ||
    openedStatus.size > maximumGuideIntentBytes
  ) {
    throw invalidIntentFile("must be an owned, single-link, mode-0600 regular file within the size limit")
  }
  if (openedStatus.dev !== pathStatus.dev || openedStatus.ino !== pathStatus.ino) {
    throw invalidIntentFile("changed while it was being opened")
  }
}

const decodeGuideIntent = (buffer: Buffer): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer)
  } catch (cause) {
    throw invalidIntentFile("must contain valid UTF-8", { cause })
  }
}

export const consumePopupGuideIntentFile = async (
  stateDirectory: string,
  intentPath: string,
): Promise<string> => {
  const location = guideIntentLocation(stateDirectory, intentPath)
  const uid = currentUserId()
  await validateIntentDirectory(location, uid)
  let handle: FileHandle
  try {
    handle = await open(
      location.intentPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
  } catch (cause) {
    throw invalidIntentFile("cannot be opened safely", { cause })
  }
  try {
    await validateOpenedIntent(handle, location, uid)
    await unlink(location.intentPath)
    return validateGuideIntent(decodeGuideIntent(await handle.readFile()), "popup intent")
  } finally {
    await handle.close()
  }
}

interface ResolveInteractiveGuideIntentOptions {
  readonly args: GuideHeadlessArgs
  readonly herdrContext: HerdrContext | null
  readonly env: NodeJS.ProcessEnv
  readonly readStdin: () => Promise<string>
}

export const resolveInteractiveGuideIntent = async ({
  args,
  herdrContext,
  env,
  readStdin,
}: ResolveInteractiveGuideIntentOptions): Promise<string | undefined> => {
  const intentPath = env[popupGuideIntentFileEnvironmentVariable]
  if (intentPath !== undefined) {
    delete env[popupGuideIntentFileEnvironmentVariable]
    if (args.intent !== undefined || args.intentStdin) {
      throw new GuideArgsError(
        "Provide the popup intent file, --intent-stdin, --intent, or a positional argument, not more than one",
      )
    }
    if (herdrContext?.surface !== "popup") {
      throw new GuideArgsError("The popup intent file is available only for a validated Herdr guide popup")
    }
    const stateDirectory = env.HERDR_PLUGIN_STATE_DIR
    if (stateDirectory === undefined) {
      throw new GuideArgsError("HERDR_PLUGIN_STATE_DIR is required for a popup intent file")
    }
    return consumePopupGuideIntentFile(stateDirectory, intentPath)
  }
  if (args.intent !== undefined) return args.intent
  return args.intentStdin
    ? validateGuideIntent(await readStdin(), "stdin intent")
    : undefined
}
